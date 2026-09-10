# Limpieza y respaldo externo: integración pendiente

Estado del 10 de septiembre de 2026: implementación probada localmente y conectada al arranque de `server.js`, desactivada por defecto. No se ejecutó limpieza contra una base conectada ni se subió/descargó un respaldo real. No se activó mantenimiento ni se cambió la configuración del Hub.

## Cierre de revisión local posterior a publicación

Base publicada de esta revisión: API `9e792650dd3f1e8d31f0d617fb6c1e31e50aff79`, frontend `8cecd7794e2952aaec757476766d8aef93c30be6`. Las correcciones siguientes forman parte de la nueva entrega; su publicación se verifica por el estado del despliegue. No modifican la configuración de R2 ni activan mantenimiento.

Evidencia remota comunicada por el main, no consultada desde esta tarea: `GET /api/v1/s3-storages` respondió 200 con lista vacía; la metadata de entorno de la app no contiene claves R2/S3/BACKUP/RESTORE/MAINTENANCE. No devuelve valores y no permite concluir que falten otras variables, como `DATABASE_URL`. El main solicitó a Dario conectar el bucket/acceso Cloudflare autorizado sin compartir secretos en el chat. R2 queda bloqueado hasta esa conexión; no se crean storages, credenciales ni infraestructura como parte de esta revisión.

Comprobación local: no se encontraron `postgres`, `initdb`, `pg_ctl`, `psql`, `pg_dump`, `pg_restore`, `aws`, Docker ni Podman en PATH o las ubicaciones habituales inspeccionadas. PGlite está instalado y permite las pruebas PostgreSQL aisladas existentes; no sustituye un servidor PostgreSQL nativo ni verifica `pg_dump`/`pg_restore` o contención multiproceso. No se instalaron dependencias de sistema. No se leyeron credenciales ni se usó Hub.

Ruta mínima verificable para el main, una vez conectado el acceso autorizado:

1. Confirmar metadata de las variables requeridas abajo y la disponibilidad de un destino PostgreSQL de pruebas aislado ya autorizado. Para el origen se necesita un rol con lectura completa de los datos a respaldar; para el destino, rol sin superusuario con `CREATEDB`. No usar otro alias del servidor de producción como supuesto destino aislado.
2. En el entorno donde se ejecutará el script, comprobar `aws --version`, `pg_dump --version`, `pg_restore --version` y `node scripts/r2-backup.mjs --check`. La imagen actual instala `postgresql18-client`, **no AWS CLI ni servidor PostgreSQL**. Si no existe un worker autorizado con esas herramientas y destino de restauración, falta ese requisito: el Dockerfile por sí solo no lo resuelve. `--check` ahora exige `capabilities.conditionalPut:true` usando el modelo local de AWS CLI, sin solicitud API. Su resultado no prueba permisos ni conectividad.
3. Confirmar versiones de los servidores mediante una consulta de solo lectura `SHOW server_version_num`: el `pg_dump` no debe ser más antiguo que el origen; para esta imagen, validar restauración en PostgreSQL 18 o compatible más nuevo, con las extensiones requeridas disponibles. Comprobar espacio temporal para el archivo completo y capacidad del destino para la base restaurada. Cada subproceso tiene un máximo de 180 segundos; el manifiesto admite hasta 5 MiB y la subida es `PutObject` simple, sin multipart. Verificar que tamaño y duración del respaldo quepan en esos límites.
4. Solo en una ejecución posterior autorizada: `--upload` y luego `--verify BACKUP_ID` del mismo respaldo. Guardar la salida estructurada, sin URLs de conexión ni stderr del proveedor. Exigir `r2_restore_verified`, comparación de datos/restricciones y eliminación exitosa de la base temporal. No confundir `r2_backup_uploaded` con restauración comprobada. Esta revisión no ejecutó ninguno de esos pasos reales.
5. Para mantenimiento, el único ensayo remoto inicial es `node scripts/cleanup-expired-demo.mjs --dry-run`, coordinado por el main. No ejecutar aquí `--apply`, `--schedule` ni activar `MAINTENANCE_ENABLED`: esos modos aplican retención. Las demos siguen sin eliminación programada y necesitan evidencia reciente para cualquier futuro borrado explícito. La frecuencia/retención externa sigue pendiente de definición y comprobación; subir un archivo no cierra ese punto.

Correcciones locales comprobadas: detección de AWS CLI antiguo sin `IfNoneMatch`; fecha del respaldo anclada al inicio del snapshot en vez del fin de la subida; `--no-password` en clientes PostgreSQL para no quedarse esperando una entrada interactiva; etapa de fallo segura en reportes; mantenimiento desactivado ya no valida ajustes de retención no utilizados ni puede interrumpir el arranque por ellos. No se cambiaron Dockerfile, servidor, esquema ni migraciones ajenas.

## Integración para el agente principal

En `server.js` ya se importa `startMaintenance` desde `./maintenance.js` y se llama una sola vez después de que `init()` termina correctamente, junto a `startAutomation(...)`. Su callback detiene el timer al cerrar el servidor. La función evita timers duplicados para el mismo pool y serializa procesos mediante un bloqueo PostgreSQL; también excluye la inicialización de esquema.

La activación exige `MAINTENANCE_ENABLED=true`; por defecto no arranca. Al habilitarse, ejecuta un ciclo inmediato y luego uno por hora, con **demos en dry-run y retención de presencia/uso aplicada**. No debe importarse desde rutas HTTP ni iniciarse antes de las migraciones existentes. No requiere nuevas migraciones propias.

Alternativa ejecutable ya incluida para un worker dedicado, sin modificar `server.js`:

```sh
node scripts/cleanup-expired-demo.mjs --dry-run
node scripts/cleanup-expired-demo.mjs --schedule
```

`--schedule` habilita expresamente la retención, mantiene vivo el proceso y responde a SIGINT/SIGTERM. `--apply` ejecuta una sola tanda de retención. Ambos conservan `demoDryRun:true`; no borran demos. Una tanda con demos bloqueadas devuelve código 1 desde la CLI. El scheduler informa `maintenance_failed` si falla el ciclo; revisar también los elementos `demos[].status=blocked` en `maintenance_complete`. No se instaló ni activó un job externo.

Como resguardo operativo de esta implementación, la eliminación de demos sigue deshabilitada hasta verificar el respaldo externo. La API interna solo la permite con `runMaintenance(db,{dryRun:false,demoDryRun:false,verifiedBackup:receipt})`: `receipt` debe ser la salida real de `r2-backup.mjs --verify`, de la misma base indicada por `DATABASE_URL`, con respaldo y restauración de menos de 24 horas. El scheduler y la CLI no exponen ese modo. No inventar ni reutilizar los recibos sintéticos de las pruebas; el recibo es evidencia operativa aportada por un operador confiable, no una firma criptográfica. El agente principal debe revisar la ejecución real antes de habilitar una futura integración de borrado.

Coordinación con Hume/Aquinas: leídas las migraciones `20260910_global_identity.sql`, `20260910_live_visitors.sql`, `20260910_project_assignees.sql`, `20260910_inventory_reservations.sql` y su dependencia `20260910_company_currency.sql`. Se incorporaron a la allowlist las dos tablas de responsables y las cuatro de categorías/reservas de inventario, con pruebas de sus FK compuestas. `users` y `user_personal_identities` quedan fuera y conservadas byte por byte. `live_visitor_sites`/`live_visitor_sessions` quedan fuera: una referencia desde esos sitios bloquea la demo, porque el modo demo de visitantes es sintético y no necesita sitios reales. Su retención de 90 segundos corresponde al worker propio `startLiveVisitorCleanup`, no a la retención 30/90 días del equipo. Cualquier FK nueva desconocida sigue bloqueando la demo; no añadir tablas por prefijo automáticamente.

La subtarea de checklist agregó `agency_work_checklists` y `agency_work_checklist_items` a la allowlist, en orden derivado de sus FK compuestas. La prueba de mantenimiento incluye ambas en un fixture demo y comprueba su eliminación aislada, sin tocar las descripciones legadas. Continúa el bloqueo de eliminación programada hasta tener respaldo verificado.

## Alcance y límites

Solo organizaciones con UUID v4 generado, propietario demo explícito, vencimiento finito ya cumplido y gracia mínima de 24 horas. La organización 22 y la plantilla `scale-demo-controles-20260908` quedan excluidas. Demos privadas: origen en esa plantilla y registro de `agency_demo_sessions` con el mismo dueño. Demos públicas: `is_demo_guest`, contraseña deshabilitada exacta y correo ficticio que coincide con el UUID de la organización. Se rechazan sesiones aún vigentes, presencia reciente y miembros adicionales que no tengan los marcadores ficticios exactos.

Cada demo tiene un savepoint; si falla, se revierte entera. Se detecta el orden real de claves foráneas y se rechazan referencias de otras empresas o tablas desconocidas (incluidas tablas WEEM/Dadoo/nuevas). No se deshabilitan FK, auditoría ni triggers globalmente. Se suspenden exclusivamente `agency_payments_sync`, `payment_reversal_sync` y `account_transfers_sync` dentro de la transacción, con sus estados normales comprobados antes y restaurados antes del commit. Las escrituras concurrentes quedan bloqueadas brevemente mientras dura esa sección; las tres tablas financieras requieren bloqueos más fuertes. Espera máxima de bloqueo: 1 segundo; sentencia: hasta 5 segundos, limitada además por el tiempo restante del ciclo. Sin permisos de propietario sobre esas tablas, se bloquea la demo en vez de eludir sus protecciones.

Los usuarios y sus identidades globales se conservan todos, incluso los usuarios sintéticos huérfanos. La auditoría existente se conserva y, en un eventual borrado autorizado, se agregan registros de eliminación con actor de mantenimiento. No se purgan sesiones de autenticación de empresas reales, facturas archivadas reales ni respaldos. Las sesiones asociadas a una demo eliminada sí desaparecen. El historial de auditoría demo puede seguir creciendo: no se incluyó una política de purga de auditoría.

| Ajuste de entorno | Predeterminado | Límite admitido |
| --- | ---: | --- |
| `DEMO_CLEANUP_GRACE_HOURS` | 24 horas | 24–8760 |
| `DEMO_CLEANUP_BATCH_SIZE` | 3 demos por ciclo | 1–20 |
| `DEMO_CLEANUP_MAX_ROWS` | 10000 filas por demo | 1–50000 |
| `PRESENCE_RETENTION_DAYS` | 30 días | 1–3650 |
| `USAGE_RETENTION_DAYS` | 90 días | 30–3650 |
| `PRESENCE_CLEANUP_BATCH_SIZE` | 1000 filas por tabla/ciclo | 1–10000 |
| `MAINTENANCE_INTERVAL_MS` | 3600000 | 60000–86400000 |
| `MAINTENANCE_TIMEOUT_MS` | 30000 | 1000–60000 |

La retención de presencia/uso sí aplica a todas las empresas: elimina únicamente telemetría cuya `last_seen_at` supera el umbral. Nunca usa el inicio de sesión para borrar una sesión todavía activa. Mantiene el significado del informe de últimos 30 días. La limpieza usa tandas ordenadas y `SKIP LOCKED`. Los valores inválidos se rechazan; no se convierten en retención cero.

El dry-run calcula candidatos, referencias y cantidades con las mismas comprobaciones y bloqueos; no ejecuta DELETE ni altera triggers y termina con rollback. Puede producir contención breve: usarlo con los mismos límites operativos. Demos bloqueadas persistentemente aparecen en el reporte y deben revisarse; no se saltan mediante eliminación forzada. Pueden ocupar una tanda hasta corregirse.

## R2: recorrido y configuración exacta

```sh
node scripts/r2-backup.mjs --check
node scripts/r2-backup.mjs --upload
node scripts/r2-backup.mjs --verify BACKUP_ID
```

`--check` solo valida configuración local, herramientas y soporte de `IfNoneMatch` en el modelo local de AWS CLI; no consulta el bucket. `--upload` captura todas las tablas de esquemas de usuario dentro de un snapshot PostgreSQL consistente, crea un dump completo y publica el archivo y luego su manifiesto SHA-256. La antigüedad del manifiesto se cuenta desde el inicio de la operación. Usa claves únicas y escritura condicional `If-None-Match: *`; nunca sobreescribe, borra, aplica ACL pública ni configura retención remota. Una subida parcial sin manifiesto no cuenta como respaldo completo. Las credenciales solo pasan por entorno; no se imprimen ni aparecen en argumentos. Archivos temporales privados se eliminan al finalizar.

`--verify` descarga ese manifiesto y dump desde R2, verifica SHA-256/tamaño, restaura en una base aleatoria recién creada y compara conjunto de tablas, cantidades y huellas de filas; rechaza restricciones sin validar. La base temporal se elimina al terminar. Exige otro host/puerto PostgreSQL y un rol sin superusuario con `CREATEDB`. Debe apuntar a un servidor de pruebas aislado y confiable; la comparación de host/puerto no puede detectar aliases distintos del mismo servidor. Nunca usa `--clean`, `--create` ni una base existente como destino. Un dump puede contener SQL: no usar un servidor de producción ni artefactos ajenos al bucket controlado. La prueba valida datos de tablas y restricciones, no todos los permisos originales, extensiones ni comportamiento de la aplicación.

Variables requeridas; sus valores no se inspeccionaron en esta revisión:

- `DATABASE_URL`: conexión de origen para subir (no se necesita al verificar si el manifiesto ya identifica el host de origen).
- `R2_ENDPOINT_URL`: endpoint S3 HTTPS de la cuenta R2; admite endpoints de jurisdicción `eu`/`fedramp`.
- `R2_BUCKET`: bucket privado existente.
- `R2_ACCESS_KEY_ID` y `R2_SECRET_ACCESS_KEY`: credenciales ya autorizadas, restringidas al bucket; no se crearon ni consultaron credenciales del Hub.
- `R2_BACKUP_PREFIX`: prefijo explícito, por ejemplo `scale/postgres`.
- `R2_RESTORE_ADMIN_URL`: conexión al PostgreSQL aislado de restauración.

Faltan localmente `aws`, `pg_dump` y `pg_restore`. El Dockerfile actual ya instala `postgresql18-client`, pero no AWS CLI; el entorno de ejecución necesita un AWS CLI compatible con `s3api put-object --if-none-match`. No se modificó el Dockerfile compartido ni se instaló software. La evidencia remota es exclusivamente la comunicada por el main arriba.

No se configuró frecuencia ni retención externa y no se alteró el respaldo local diario existente. No hay evidencia de subida o restauración real desde R2. Solo `r2_restore_verified` tras una ejecución real acredita ese recorrido; `--check` y `r2_backup_uploaded` devuelven `externalBackupVerified:false`.

Referencias de implementación: [AWS CLI con R2](https://developers.cloudflare.com/r2/examples/aws/aws-cli/), [compatibilidad S3 de R2](https://developers.cloudflare.com/r2/api/s3/api/), [restauración transaccional PostgreSQL](https://www.postgresql.org/docs/current/app-pgrestore.html).

Referencias de la revisión: [modelo local sin solicitud API y escritura condicional de AWS CLI](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html), [compatibilidad de versiones y ejecución sin prompt de pg_dump](https://www.postgresql.org/docs/18/app-pgdump.html).

## Validación

`node test-maintenance.mjs`: PostgreSQL PGlite con esquema y migraciones existentes, fixtures privados completos y públicos, claves foráneas, controles inmutables, auditoría, usuarios canónicos, gracia, identificadores protegidos, rollback, límites, retención configurable y scheduler. No sustituye una prueba multiproceso de contención en PostgreSQL desplegado.

`node test-r2-backup.mjs`: configuración, secretos fuera de argumentos, snapshot/manifiesto, subida sin sobrescritura, descarga/restauración, corrupción, destino aislado y limpieza. AWS CLI y clientes PostgreSQL externos se simulan; no acredita infraestructura real.
