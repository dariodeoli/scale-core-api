# Resumen semanal automático

## Alcance

Desde 2026-09-20 el endpoint sirve **solo la sección automática**. La superficie declarada
(`PUT` con `metrics`/`notes`, más los campos `records`, `canEdit` y `canViewTeam`) quedó
retirada: la página del frontend que la consumía (**Equipo > Resumen semanal**,
`/equipo/resumen-semanal`) había sido retirada el 2026-09-14 y los conteos derivados de la
auditoría de operaciones la reemplazan. La tabla `agency_weekly_reports` conserva sus filas
históricas (no se ejecuta ninguna migración destructiva) y el API no la lee ni la escribe;
volver a exponer una declaración manual requiere su propio issue.

La tabla de piezas solo tiene horas acumuladas por pieza (`actual_hours`), sin fecha del
trabajo ni reparto individual. Sus estados tampoco identifican videos finales, reediciones o
fotos diseñadas: los conteos no se generan desde títulos, asignaciones múltiples, historial de
cambios ni presencia.

### Sección automática (sin horas)

El GET incluye `automatic`: conteos de piezas terminadas derivados de la auditoría de
operaciones (`agency_operation_audit`), nunca persistidos. Cada pieza cuenta una sola vez por
reporte: la primera transición a `approved` o `published` de la semana (lunes a domingo, hora
de Asunción), atribuida a quien ejecutó la transición, no al responsable asignado. Se ignoran
actores no numéricos o de sistema. Las piezas sin `work_type` cuentan bajo `untyped`; el resto
bajo `video`, `reedicion`, `foto`, `produccion` o `entregable`. No aparece ningún campo de horas
en esta sección.

Cada entrada de `automatic` es `{user_id, actor_name, counts:{video,reedicion,foto,produccion,entregable,untyped}, orders, projects:[{project_id, project_name, count, orders}]}`.
`orders` cuenta las órdenes distintas en las que el actor operó durante la semana (cualquier
INSERT/UPDATE/DELETE en `agency_work_orders`), una sola vez por orden sin importar cuántas
operaciones haya o si la pieza terminó; los DELETE se atribuyen por `before_state`. `scope=own`
filtra al integrante que consulta; `scope=team` (dueño efectivo) muestra un registro por
colaborador. Las piezas terminadas y las órdenes trabajadas se agrupan además por proyecto
(`projects`), con el nombre resuelto desde `agency_projects` cuando existe.

### Portal del cliente — actividad y visibilidad de enlaces

`GET /api/client-portal/deliveries/:id/activity` devuelve `{activity:[{kind:'decision'|'comment'|'download'|'version',at,version?,actor_name?,summary}]}`
en orden cronológico, solo para entregas visibles y aprobadas/publicadas del cliente con grant
activo; sin actividad devuelve una lista vacía. Los enlaces de pieza se exponen en el detalle
únicamente cuando `visible_to_client=true` (por defecto `false`; solo escritores lo cambian con
`PATCH /api/agency/work-orders/:id/links/:linkId`). La URL del activo nunca se incluye en el
JSON: la descarga sigue siendo un 302 al enlace HTTPS aprobado.

El PDF es una referencia de presentación, no un origen de datos importados. Las proyecciones
nunca se convierten automáticamente en entregas. No hay implementación de Studio.

## Integración

1. `migrations/20260911_weekly_reports.sql` está registrada en la secuencia existente de
   migraciones del servidor. Requiere las tablas base `organizations` y `users`; para
   autorización/atribución al servir solicitudes se requieren `organization_members.removed_at`
   y la vista `organization_person_identity` existentes.
2. `weeklyReports` está registrado junto a productividad, bajo las mismas protecciones de
   sesión, origen, demo y suscripción.
3. El endpoint ya no escribe: cualquier método distinto de `GET` responde 405 antes de tocar
   membresía o base de datos.

## Contrato

`GET /api/agency/weekly-reports?week=2026-09-07&scope=own|team`

La respuesta es `{week, scope, automatic}`. `week` debe ser el lunes de la semana y `scope`
admite `own` (por defecto) o `team` (solo dueño efectivo, verificado contra la membresía
vigente y el rol de la sesión). No se aceptan otros parámetros (`userId` y compañía responden
400). Todos los accesos verifican membresía activa; una membresía revocada recibe 403. Un GET
sin transiciones no representa cero trabajo: devuelve la lista vacía.

## Rollback

Todo el cambio es aditivo. Quitar el `PUT` y los campos declarados es reversible con el
historial de git (la implementación y su validador `declaration()` viven en commits anteriores);
`agency_weekly_reports` permanece intacta con sus filas. La sección `automatic` es solo cálculo
sobre la auditoría; revertir es restaurar el bloque retirado del GET de `weekly-reports.js`. No
hay datos persistidos de reporte automático que migrar.

## Verificación

`node test-weekly-reports.mjs`: PGlite real, migración idempotente, 401/403/400/405, ausencia
de los campos retirados, filas históricas que nunca se sirven, conteos de auditoría una vez por
orden, atribución por actor de transición, desglose por proyecto, alcance own/team y aislamiento
por empresa.

`node test-production-traceability.mjs` cubre el mismo endpoint desde la trazabilidad de
producción (work_type, due_time y conteos automáticos atribuidos al actor de la transición).

Frontend: `tests/weekly-report-automatic.test.tsx` renderiza la sección automática con estados
vacíos y el rango de la semana. La revisión visual corresponde al padre.
