-- Keep existing managed installations aligned with the backend schema contract.
begin;
update public.vehicleapp_installation
set schema_version = '20260926.5'
where singleton;
commit;
