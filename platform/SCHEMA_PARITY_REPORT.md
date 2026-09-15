# Informe de paridad de esquema — taller «Prueba»

Fase: multitaller, rama `codex/multitaller-fase-1`.
Ámbito permitido: base central `ixjwixcosrzzsgnilkcu`, base operativa
`cpulwtgoqoyjoerttvkt`. La base operativa del taller actual
(`dandezhxxeeqetddivgw`) solo se consultó en modo lectura para validar la
plantilla; no recibió ninguna escritura.

## 1. Referencia canónica

`Backend/platform/template` empaqueta, en este orden:

1. `20260913225816_workshop_baseline.sql` — línea base sin datos de negocio.
2. `20260913225307_installation_contract.sql` — contrato de instalación.
3. `20260913230822_workshop_access_guards.sql` — RLS, grants y `search_path`.
4. `20260914030000_workshop_installation_defaults.sql` — **nueva**: configuración
   singleton de factura v2, ajustes operativos explícitos y trabajo `pg_cron`
   de finalización de liquidaciones.

La versión de esquema del aprovisionador pasó de `20260914.1` a `20260914.2`.

## 2. Verificación contra el taller actual (solo lectura)

Consultas de catálogo ejecutadas sobre `dandezhxxeeqetddivgw`:

| Objeto | Taller actual | Línea base capturada |
| --- | --- | --- |
| Tablas | 35 | 35 |
| Vistas | 0 | 0 |
| Políticas | 97 | 97 |
| Funciones (public + private) | 103 | 103 |
| Disparadores | 48 | 48 |
| Secuencias | 8 | 8 |
| Tablas con RLS | 32 | 32 |
| Tablas en `supabase_realtime` | 25 | 25 |

También se confirmó en el taller actual:

- `public.app_settings` tiene filas `admin_bypass_photos`, `allow_employee_view_finalized`
  y `ready_settlement_workflow_enabled`.
- `public.factura_v2_config` tiene su fila singleton (`cutover_at`).
- Existe un trabajo de `pg_cron` llamado `finalizar-formatos-liquidados`
  (cada hora, en el minuto 5) que llama a `public.finalize_due_settlement_formats()`.
- La base no contiene `exec_sql` ni `registrar_formato_finalizado`; el código de
  `reporte_variacion_service.dart` que los invoca falla de forma controlada y usa
  la ruta alterna. No es una diferencia de la plantilla.

Conclusión: la línea base reproduce el catálogo del taller actual. Las tres
piezas que sí faltaban eran **datos de configuración y el trabajo programado**,
no objetos de esquema.

## 3. Diferencias encontradas y corrección

| Diferencia | Riesgo | Corrección |
| --- | --- | --- |
| `factura_v2_config` vacío en un taller nuevo | `factura_v2_cutover_at()` devuelve `null` y la decisión heredado/v2 queda ambigua | Se inserta la fila singleton con `now()` |
| `app_settings` sin filas explícitas | Lecturas en `null`; el bypass de fotos dependía de valores heredados | Se siembran los tres ajustes en `false` con `on conflict do nothing` |
| Sin trabajo `pg_cron` | Las liquidaciones diferidas no se cerraban solas en un taller nuevo | Se programa `finalizar-formatos-liquidados` cuando `pg_cron` está disponible |

La migración es aditiva, idempotente y no toca filas de negocio. En un motor sin
`pg_cron` (por ejemplo el PostgreSQL embebido de las pruebas) se omite sin error.

## 4. Herramienta repetible de paridad

- `Backend/platform/schema-baseline.js` genera el inventario esperado desde la
  plantilla usando PostgreSQL embebido:
  `node Backend/platform/schema-baseline.js baseline.json`
- `Backend/platform/schema-inventory.js --sql` imprime la consulta que un
  operador ejecuta con el token de gestión del taller (o una conexión de solo
  lectura) y guarda como JSON.
- `node Backend/platform/schema-inventory.js compare baseline.json real.json`
  clasifica el resultado en correctos, faltantes, diferentes, adicionales y
  peligrosas (RLS deshabilitado, políticas ausentes o alteradas, grants a
  `anon`/`PUBLIC`, `SECURITY DEFINER` inesperado, `search_path` perdido).

Huella esperada de un taller recién instalado (incluye la tabla libro
`vehicleapp_schema_migrations`): 37 tablas, 100 políticas, 104 funciones,
48 disparadores, 8 secuencias, 36 tablas con RLS, 8061 objetos inventariados.

`Backend/platform/schema-parity.test.js` verifica esa huella e inyecta cada
tipo de deriva para comprobar que la herramienta la detecta.

## 5. Auditoría de la base «Prueba»: pendiente de credenciales

La herramienta de Supabase disponible en esta sesión no tiene acceso al
proyecto `cpulwtgoqoyjoerttvkt` (pertenece a otra organización o a una cuenta
cuyo token de gestión no está disponible aquí), y no se solicitaron ni
imprimieron credenciales. Por eso la comparación en vivo quedó pendiente.

Procedimiento exacto para completarla, sin exponer secretos en el repositorio:

1. Generar la referencia: `node Backend/platform/schema-baseline.js baseline.json`.
2. Ejecutar `node Backend/platform/schema-inventory.js --sql` con el token de
   gestión de `cpulwtgoqoyjoerttvkt` y guardar el resultado JSON como `real.json`.
3. `node Backend/platform/schema-inventory.js compare baseline.json real.json`.
4. Aplicar la migración de configuración si aún no está registrada en
   `vehicleapp_schema_migrations` (el archivo se autoregistra; también puede
   aplicarse con `POST` a `/v1/projects/cpulwtgoqoyjoerttvkt/database/query`).
5. Actualizar la versión en el registro central:

   ```sql
   update platform_workshop_connections
      set schema_version = '20260914.2', updated_at = now()
    where connection_ref = 'cpulwtgoqoyjoerttvkt';
   update platform_workshops
      set schema_version = '20260914.2'
    where connection_ref = 'cpulwtgoqoyjoerttvkt';
   ```

6. Confirmar `schema_version = 20260914.2` en el registro central.

Criterio de aceptación: `Paridad: OK` y, como máximo, los adicionales
legítimos de una instalación (por ejemplo el propio libro de migraciones).

## 6. Revisión crítica posterior

La revisión de cierre encontró y corrigió estos defectos antes de publicar la
rama:

- En modo multitaller, el cliente todavía consideraba confiables tanto el
  origen de la plataforma como el backend legado. Varias funciones directas
  (usuarios, contraseña, PDF, factura electrónica y voz) podían adjuntar el JWT
  operativo al backend del taller original. Ahora cada llamada autenticada
  valida el origen activo y el backend legado queda bloqueado cuando hay un
  taller seleccionado.
- La reanudación idempotente de una foto buscaba solo carpeta y `uploadRequestId`.
  Ahora también incluye `vehicleAppWorkshop`, de modo que no puede reutilizar
  un archivo de otra instalación aunque coincidan la ruta y el identificador de
  reintento.
- Las rutas de fotos comprobaban el perfil operativo, pero no que la membresía
  central vinculada a ese usuario siguiera activa. Ahora exigen taller `ready`,
  perfil activo y membresía central activa en cada subida, lectura y borrado.
- Las URLs de la API y de la base operativa ahora rechazan rutas, consultas,
  fragmentos, credenciales embebidas y puertos no esperados antes de cambiar el
  contexto de la app.
- Se añadieron casos de prueba para reejecutar dos veces la migración sin
  `pg_cron`, detectar una función `SECURITY DEFINER` inesperada y conservar una
  sola fila en el ledger.

La base central se consultó nuevamente el 2026-09-14: `Prueba` está `ready`,
tiene dos membresías activas y tanto el taller como su conexión siguen en
`20260914.1`. No se actualizó el registro central porque la base operativa aún
no pudo auditarse ni migrarse con el acceso disponible. El MCP visible solo
enumera `ixjwixcosrzzsgnilkcu` y `dandezhxxeeqetddivgw`; el CLI de Vercel enumera
las variables sensibles del Preview, pero no entrega sus valores a procesos
locales. No se imprimieron secretos ni quedó ningún archivo local con sus
valores.

## 7. Evidencia local ejecutada

- `node --test platform/schema-parity.test.js` → 9/9.
- Pruebas enfocadas de Drive, rutas y conexión → 15/15.
- `npm test` (backend completo) → 37/37.
- `dart format --output=none --set-exit-if-changed lib test` → 224 archivos,
  cero cambios requeridos.
- `flutter test` → 349/349.
- `flutter analyze` no encontró errores de compilación y conservó los 833
  avisos/informaciones heredados del proyecto; no se corrigieron por estar fuera
  de esta fase.
- Build web multitaller → `build/web`.
- Build APK debug multitaller → `build/app/outputs/flutter-apk/app-debug.apk`.
- Los conteos de producción de la sección 2 provienen de consultas de catálogo
  de solo lectura; no se ejecutaron migraciones ni escrituras allí.
