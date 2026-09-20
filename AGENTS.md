# Reglas operativas — Scale Core API

## Entrega (regla obligatoria)
- `main` pertenece al integrador: **nunca** mergear ni pushear a `main` desde un worktree; push solo a `origin/<tu-rama>`. El hook local `pre-push` bloquea main sin `MOBOS_INTEGRATOR=1`; instalar en cada checkout con `bash scripts/setup-hooks.sh` (deja `core.hooksPath = .githooks`).
- Antes de tocar archivos: `git fetch origin --prune && git rebase origin/main`. Conflicto → se resuelve en la rama propia; force-push solo a la rama propia, jamás a main.
- Checks antes de entregar: `npm run test:release` en verde, `node --check` de los archivos JS tocados, 0 marcadores de conflicto (`rg "^(<<<<<<<|>>>>>>>)"`), migraciones aditivas/idempotentes/re-ejecutables y toda columna o tabla nueva del schema con su migración. Si algún check falla, no entregues la rama.
- Rutas API: no exportar símbolos que no sean handlers, no duplicar slugs dinámicos.
- Al terminar: matar servidores propios (`lsof -ti :3000 :${PORT:-3000} | xargs kill -9`).
- Handover: conventional commits por unidad de trabajo, sin atribución de IA; avisar con rama, `git log --oneline origin/main..HEAD`, qué hace cada commit, rutas tocadas y verificaciones.
- Issues: cada pedido se trabaja desde un issue del backlog; citar `Refs #<n>` en commits y handover. El integrador cierra el issue solo verificando por contenido contra `main`.

## Worktrees e implementadores (cómo actúa cada uno)
- **Implementador (agente en worktree)**: trabaja SOLO en su rama dentro de su worktree; nunca toca `main` ni despliega. Rebase sobre `origin/main` antes de empezar; entrega por push a `origin/<su-rama>` con handover (rama, commits, rutas, verificaciones). Prohibido: mergear/pushear a main, resolver conflictos sobre main, borrar o arreglar refs.
- **Integrador (sesión sobre main)**: único que mergea y pushea `main`, siempre con `MOBOS_INTEGRATOR=1`; integra una rama por vez, verifica el árbol mergeado y ante conflicto real **para y consulta**. El deploy de producción es exclusivo de Dario con el comando de release.
- **Estado raro de git** (fetch que falla, refs rotas): parar y avisar; no reparar por cuenta propia.

## Tests con base de datos
- Con PGlite (sin instalación): `test-suite.mjs`, `test-operations.mjs`, `test-auth.mjs`, `test-global-identity.mjs`, `test-forecast.mjs`, `test-platform-admin.mjs` y compañía.
- Con **Postgres real** (requieren binarios `initdb`/`pg_ctl`, p. ej. `brew install postgresql@16`): `node test-inventory-postgres.mjs` y `node test-treasury-concurrency.mjs`. Correrlos al tocar inventario, tesorería o concurrencia de saldos; ambos levantan su propio clúster temporal.
- Al agregar una migración nueva, incluirla en las cadenas curadas de los fixtures (`scripts/migration-order.mjs` y las listas de `test-suite.mjs`/`test-auth.mjs`) para que los tests la carguen.

## Contratos de endpoints
- Los endpoints de salary-overrides (GET/PATCH/DELETE por colaborador y mes) sostienen los ajustes mensuales por persona de la Previsión financiera y admiten importes con signo (extra o descuento). Mantener ese contrato; cualquier cambio requiere actualizar la previsión.

## Validación de campos (API)
- Todo campo normalizado en el frontend se revalida acá: `suite-validation.js` es la fuente única (`text`, `email`, `phone`, `serial`, `amount`, `date`, `option`, `id`/`optId`). Al crear una regla nueva de campo, agregarla ahí y usarla en TODOS los endpoints que la reciben.
- Formatos guardados normalizados: teléfono `+<código> <dígitos>`, serial mayúsculas sin separadores, correo en minúsculas (≤254). Nunca confiar en el cliente.
- Los PATCH solo revalidan el campo que cambia: el valor viejo se preserva tal cual para no romper datos legacy.
