# Resumen semanal declarado

## Alcance

La tabla de piezas solo tiene horas acumuladas por pieza (`actual_hours`), sin fecha del trabajo ni reparto individual. Sus estados tampoco identifican videos finales, reediciones o fotos diseñadas. No se generan estos indicadores desde títulos, asignaciones múltiples, historial de cambios ni presencia.

Cada integrante declara su propio reporte semanal. El dueño consulta los reportes enviados del equipo. La semana empieza el lunes y termina el domingo. Campos vacíos se guardan como `null` (sin declarar); cero es una declaración explícita. Categorías: videos finales, reediciones, fotos diseñadas y producciones, cada una con terminado/en curso/previsto. Clips brutos, días de producción y horas declaradas son campos separados. No hay sumatoria de entregas del equipo ni reparto automático de horas. El texto libre explica la participación.

### Sección automática (sin horas)

Desde 2026-09-14 el GET incluye `automatic`: conteos de piezas terminadas derivados de la auditoría de operaciones (`agency_operation_audit`), nunca persistidos. Cada pieza cuenta una sola vez por reporte: la primera transición a `approved` o `published` de la semana (lunes a domingo, hora de Asunción), atribuida a quien ejecutó la transición, no al responsable asignado. Se ignoran actores no numéricos o de sistema. Las piezas sin `work_type` cuentan bajo `untyped`; el resto bajo `video`, `reedicion`, `foto`, `produccion` o `entregable`. No aparece ningún campo de horas en esta sección.

Cada entrada de `automatic` es `{user_id, actor_name, counts:{video,reedicion,foto,produccion,entregable,untyped}, orders}`. `orders` cuenta las órdenes distintas en las que el actor operó durante la semana (cualquier INSERT/UPDATE/DELETE en `agency_work_orders`), una sola vez por orden sin importar cuántas operaciones haya o si la pieza terminó; los DELETE se atribuyen por `before_state`. `scope=own` filtra al integrante que consulta; `scope=team` (dueño efectivo) muestra un registro por colaborador. La sección declarada (`records`, `metrics`, versiones y 409) no cambia.

### Portal del cliente — actividad y visibilidad de enlaces

`GET /api/client-portal/deliveries/:id/activity` devuelve `{activity:[{kind:'decision'|'comment'|'download'|'version',at,version?,actor_name?,summary}]}` en orden cronológico, solo para entregas visibles y aprobadas/publicadas del cliente con grant activo; sin actividad devuelve una lista vacía. Los enlaces de pieza se exponen en el detalle únicamente cuando `visible_to_client=true` (por defecto `false`; solo escritores lo cambian con `PATCH /api/agency/work-orders/:id/links/:linkId`). La URL del activo nunca se incluye en el JSON: la descarga sigue siendo un 302 al enlace HTTPS aprobado.

El PDF es una referencia de presentación, no un origen de datos importados. Las proyecciones nunca se convierten automáticamente en entregas. No hay implementación de Studio.

## Integración

Integración completada tras autorización del padre: registro en `server.js` y subpestaña en `navigation.ts`/`scale-workspace.tsx`. Se conservaron las modificaciones existentes de los agentes activos.

1. `migrations/20260911_weekly_reports.sql` está registrada en la secuencia existente de migraciones del servidor. Requiere las tablas base `organizations` y `users`; para autorización/atribución al servir solicitudes se requieren `organization_members.removed_at` y la vista `organization_person_identity` existentes.
2. `weeklyReports` está registrado junto a productividad, bajo las mismas protecciones de sesión, origen, demo y suscripción.
3. `WeeklyReport` estuvo montado en **Equipo > Resumen semanal** (`/equipo/resumen-semanal`); la página y su ruta fueron retiradas del frontend el 2026-09-14. El endpoint sigue sirviendo la sección declarada y la automática, pendientes de una nueva superficie de renderizado.

## Contrato

`GET /api/agency/weekly-reports?week=2026-09-07&scope=own|team`

`PUT` usa la misma ruta, solo `scope=own`, con `{version, metrics, notes}`. `version:0` crea; para editar usar la versión recibida. No acepta `user_id`, empresa ni otros campos de atribución del cliente. Todos los accesos verifican membresía activa. PUT bloquea membresía/organización y engloba guardado y atribución en una transacción. Una versión desactualizada devuelve 409 sin sobrescribir.

Las respuestas incluyen `records`, `week`, `scope`, `source:'declared'`, `automatic`, `canViewTeam`, `canEdit`. Un GET sin registros no representa cero trabajo. Cada registro incluye `metrics`, `notes`, `version`, `updated_at` y campos `actor_*` obtenidos de identidad por empresa. Las cantidades por categoría usan `completed`, `in_progress`, `planned`. Otros campos: `raw_clips`, `production_days` (0–7), `declared_hours` (0–168, dos decimales). Cada cifra es opcional/null.

## Rollback

Todo el cambio es aditivo. `migrations/20260914_production_traceability.sql` agrega columnas anulables o con default (`work_type`, `due_time`, `completed_at`, `completed_by_user_id`, `visible_to_client`, `comment_id`) y reemplaza `enqueue_agency_notification` por una firma con `comment_key` opcional; revertir es dropear las columnas y recrear la firma anterior. La visibilidad de enlaces nace privada (`false`): quitar la columna no expone nada. La sección `automatic` es solo cálculo sobre la auditoría; revertir es quitar el bloque del GET de `weekly-reports.js`. No hay datos persistidos de reporte automático que migrar.

## Verificación

`node test-weekly-reports.mjs`: PGlite real, migración idempotente, separación cero/null y previsto/terminado, permisos, empresas, semana, versión, rollback de atribución y presencia del bloqueo SQL.

Frontend: `tsx tests/weekly-report.test.tsx`, estados vacíos, separación de previstos, bloqueo de doble guardado, conservación ante error y reinicio al cambiar de organización.

No se ejecutó build, no hay commit ni despliegue. El bloqueo de revocación se implementa mediante `FOR SHARE`; la prueba no simula sesiones concurrentes de PostgreSQL. La revisión visual y la prueba integrada de navegación corresponden al padre después de conectar los módulos.
