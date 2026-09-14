-- Synthetic acceptance transaction. Run ONLY on an isolated workshop database.
-- Does not send invitations, emit invoices or keep users/orders after rollback.
begin;
insert into auth.users(id, email, raw_user_meta_data)
values ('71000000-0000-4000-8000-000000000001', 'vehicleapp-qa@example.invalid', '{"full_name":"VehicleApp QA"}');
update public.profiles set role='admin' where id='71000000-0000-4000-8000-000000000001';
select set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
select set_config('request.jwt.claims','{"sub":"71000000-0000-4000-8000-000000000001","role":"authenticated"}',true);
set local role authenticated;
do $$
declare created jsonb; retry jsonb; service jsonb; part jsonb;
  payload jsonb := '{"data":{"placa":"QA1234","marca":"QA","tipo_vehiculo":"Prueba","nombre_cliente":"Cliente sintético","tipo_formato":"SERVICIO","estado":"ACTIVO","costo_mano_obra":0,"costo_repuestos":0}}';
begin
  created := public.apply_offline_mutation('72000000-0000-4000-8000-000000000001','format.create','format:QA1234',payload);
  retry := public.apply_offline_mutation('72000000-0000-4000-8000-000000000001','format.create','format:QA1234',payload);
  if created->>'status'<>'applied' or retry->>'status'<>'already_applied' then raise exception 'format idempotency failed'; end if;
  if created->'result'->>'id' is distinct from retry->'result'->>'id' then raise exception 'duplicate format'; end if;
  service := public.apply_offline_mutation('72000000-0000-4000-8000-000000000002','servicio.create','servicio:QA1234',
    '{"id":"74000000-0000-4000-8000-000000000001","format_operation_id":"72000000-0000-4000-8000-000000000001","formato_folio":"PENDIENTE:72000000-0000-4000-8000-000000000001","servicio":"Servicio QA","precio_mano_obra":10000}');
  part := public.apply_offline_mutation('72000000-0000-4000-8000-000000000003','repuesto.create','repuesto:QA1234',
    '{"item":{"id":"73000000-0000-4000-8000-000000000001","format_operation_id":"72000000-0000-4000-8000-000000000001","descripcion":"Repuesto QA","cantidad":1,"traido_por":"TALLER","costo_unitario":5000}}');
  if service->>'status'<>'applied' or part->>'status'<>'applied' then raise exception 'children not applied'; end if;
  if not exists(select 1 from public.servicios where formato_folio=created->'result'->>'folio') then raise exception 'service relation failed'; end if;
  if not exists(select 1 from public.repuestos where id_repuesto=created->'result'->>'folio') then raise exception 'part relation failed'; end if;
end;
$$;
select json_build_object('formatos', (select count(*) from public.formatos where placa='QA1234'),
  'servicios', (select count(*) from public.servicios where servicio='Servicio QA'),
  'repuestos', (select count(*) from public.repuestos where descripcion='Repuesto QA'),
  'receipts', (select count(*) from public.offline_mutation_receipts where user_id=auth.uid())) as acceptance;
rollback;
