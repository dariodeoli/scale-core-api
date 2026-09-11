# Concurrencia de inventario en PostgreSQL real

Desde un checkout **Git** de `scale-core-api`, con Node, dependencias locales y
PostgreSQL 16 ya instalados (`.git` accesible; también admite worktrees):

```sh
node test-inventory-postgres.mjs
```

Opcionalmente, indicar otro directorio de binarios (no una base de datos):

```sh
SCALE_TEST_PG_BIN=/opt/homebrew/opt/postgresql@16/bin node test-inventory-postgres.mjs
```

**Runner del export limpio sin `.git`: excluir `test-inventory-postgres.mjs` del
glob `test-*.mjs`.** Ejecutar esta prueba aparte en el checkout Git original.
No es un test portable al export ni hace fallback al schema del filesystem:
esa restricción evita incluir silenciosamente cambios ajenos o mezclar versiones.

El script no instala nada ni usa servicios de Homebrew. Ejecuta `initdb` y `pg_ctl`
en un directorio aleatorio propio bajo `/tmp/scale-inventory-pg-*`, modo 700.
Deshabilita TCP (`listen_addresses=''`) y usa solo un socket Unix privado, también
modo 700, con autenticación local `trust` y rol exclusivo de la fixture.
No usa `DATABASE_URL`, configuraciones `PG*`, archivos `.env`, HTTP ni UI.
Las variables `PG*`/`DATABASE_URL` se descartan solo dentro del proceso de prueba,
sin leer ni imprimir sus valores. Referencias oficiales de las opciones:
[initdb de PostgreSQL 16](https://www.postgresql.org/docs/16/app-initdb.html) y
[pg_ctl de PostgreSQL 16](https://www.postgresql.org/docs/16/app-pg-ctl.html).

Lee `schema.sql`, `server.js` y las migraciones del mismo commit `HEAD`; respeta
el orden de registro del servidor y excluye Dadoo. No lee el `schema.sql` sucio
del working tree. Importa el handler real `inventoryReservations` del checkout,
sin arrancar `server.js`. La salida identifica el commit de SQL y la versión PG.

## Evidencia que debe producir

- Pool de seis conexiones. Cada carrera registra dos `pg_backend_pid()` distintos.
- Barrera antes del primer bloqueo de escritura del handler; una tercera conexión
  comprueba la espera real mediante `pg_blocking_pids()`. No simula locks ni SQL.
- Reservas solapadas: un 201 y un 409. Intervalos adyacentes: dos 201.
- Edición con la misma versión: un 200 y un 409, un solo incremento de versión.
- Checkout y devolución simultáneos: dos 200, uno `alreadyRecorded`, sin duplicar
  la transición. Devolver otra vez conserva versión y fechas; comprueba custodios,
  ubicaciones y estados disponible/mantenimiento.
- Empresas independientes y rechazo de IDs, proyectos, responsables o membresías
  ajenos; los intentos no modifican ni exponen registros del otro tenant.
- Carrera SQL directa sin org lock: una inserción confirma; otra espera y falla
  con `23P01` por `inventory_no_overlapping_reservations`.

En la carrera SQL directa, ambas transacciones alcanzan la barrera; se inserta
primero una tupla sin confirmar y después se lanza la segunda inserción. Se
comprueba su espera antes de confirmar la primera: no se depende de una carrera
de planificación que pudiera generar un deadlock mutuo de inserción GiST.

Las barreras, consultas y esperas tienen límites. Una aserción fallida devuelve
código no cero. `finally` detiene PostgreSQL antes de borrar únicamente la ruta
temporal exacta; SIGINT/SIGTERM tienen además limpieza síncrona de salida. Si no
puede confirmar la parada, conserva la carpeta y avisa. SIGKILL o un apagado del
sistema no pueden interceptarse: conservar la ruta `TEMP` impresa para revisar
ese clúster concreto; nunca usar borrados amplios ni detener otros servicios PG.

Esto complementa PGlite: solo un resultado PASS de este script constituye
evidencia de concurrencia multiconexión PostgreSQL real.

Validación local: dos ejecuciones PASS en PostgreSQL 16.15, SQL HEAD
`0555520e27b215478444a94a60e29d45696c9706` (28 migraciones). Pares PID
`49937/49938` y `50157/50158`, incluidas esperas reales y `23P01` directo.
Ambos clústeres temporales fueron detenidos y eliminados.
