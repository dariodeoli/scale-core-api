# Resumen semanal declarado

## Alcance

La tabla de piezas solo tiene horas acumuladas por pieza (`actual_hours`), sin fecha del trabajo ni reparto individual. Sus estados tampoco identifican videos finales, reediciones o fotos diseñadas. No se generan estos indicadores desde títulos, asignaciones múltiples, historial de cambios ni presencia.

Cada integrante declara su propio reporte semanal. El dueño consulta los reportes enviados del equipo. La semana empieza el lunes y termina el domingo. Campos vacíos se guardan como `null` (sin declarar); cero es una declaración explícita. Categorías: videos finales, reediciones, fotos diseñadas y producciones, cada una con terminado/en curso/previsto. Clips brutos, días de producción y horas declaradas son campos separados. No hay sumatoria de entregas del equipo ni reparto automático de horas. El texto libre explica la participación.

El PDF es una referencia de presentación, no un origen de datos importados. Las proyecciones nunca se convierten automáticamente en entregas. No hay implementación de Studio.

## Integración

Integración completada tras autorización del padre: registro en `server.js` y subpestaña en `navigation.ts`/`scale-workspace.tsx`. Se conservaron las modificaciones existentes de los agentes activos.

1. `migrations/20260911_weekly_reports.sql` está registrada en la secuencia existente de migraciones del servidor. Requiere las tablas base `organizations` y `users`; para autorización/atribución al servir solicitudes se requieren `organization_members.removed_at` y la vista `organization_person_identity` existentes.
2. `weeklyReports` está registrado junto a productividad, bajo las mismas protecciones de sesión, origen, demo y suscripción.
3. `WeeklyReport` está montado en **Equipo > Resumen semanal** (`/equipo/resumen-semanal`), con `organizationId` de la sesión activa como string. El componente permite consulta propia para todos los roles y edición salvo viewer; el servidor determina acceso a equipo, reservado a dueño efectivo y de membresía. El menú agrupado permite acceder al reporte propio sin ampliar permisos de gestión de personas.

## Contrato

`GET /api/agency/weekly-reports?week=2026-09-07&scope=own|team`

`PUT` usa la misma ruta, solo `scope=own`, con `{version, metrics, notes}`. `version:0` crea; para editar usar la versión recibida. No acepta `user_id`, empresa ni otros campos de atribución del cliente. Todos los accesos verifican membresía activa. PUT bloquea membresía/organización y engloba guardado y atribución en una transacción. Una versión desactualizada devuelve 409 sin sobrescribir.

Las respuestas incluyen `records`, `week`, `scope`, `source:'declared'`, `canViewTeam`, `canEdit`. Un GET sin registros no representa cero trabajo. Cada registro incluye `metrics`, `notes`, `version`, `updated_at` y campos `actor_*` obtenidos de identidad por empresa. Las cantidades por categoría usan `completed`, `in_progress`, `planned`. Otros campos: `raw_clips`, `production_days` (0–7), `declared_hours` (0–168, dos decimales). Cada cifra es opcional/null.

## Verificación

`node test-weekly-reports.mjs`: PGlite real, migración idempotente, separación cero/null y previsto/terminado, permisos, empresas, semana, versión, rollback de atribución y presencia del bloqueo SQL.

Frontend: `tsx tests/weekly-report.test.tsx`, estados vacíos, separación de previstos, bloqueo de doble guardado, conservación ante error y reinicio al cambiar de organización.

No se ejecutó build, no hay commit ni despliegue. El bloqueo de revocación se implementa mediante `FOR SHARE`; la prueba no simula sesiones concurrentes de PostgreSQL. La revisión visual y la prueba integrada de navegación corresponden al padre después de conectar los módulos.
