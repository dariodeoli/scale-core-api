# Reglas operativas — Scale Core API

## Entrega (regla obligatoria)
- `main` pertenece al integrador: **nunca** mergear ni pushear a `main` desde un worktree; push solo a `origin/<tu-rama>`. El hook local `pre-push` bloquea main sin `MOBOS_INTEGRATOR=1`; instalar en cada checkout con `bash scripts/setup-hooks.sh` (deja `core.hooksPath = .githooks`).
- Antes de tocar archivos: `git fetch origin --prune && git rebase origin/main`. Conflicto → se resuelve en la rama propia; force-push solo a la rama propia, jamás a main.
- Checks antes de entregar: `npm run test:release` en verde, `node --check` de los archivos JS tocados, 0 marcadores de conflicto (`rg "^(<<<<<<<|>>>>>>>)"`), migraciones aditivas/idempotentes/re-ejecutables y toda columna o tabla nueva del schema con su migración. Si algún check falla, no entregues la rama.
- Rutas API: no exportar símbolos que no sean handlers, no duplicar slugs dinámicos.
- Al terminar: matar servidores propios (`lsof -ti :3000 :${PORT:-3000} | xargs kill -9`).
- Handover: conventional commits por unidad de trabajo, sin atribución de IA; avisar con rama, `git log --oneline origin/main..HEAD`, qué hace cada commit, rutas tocadas y verificaciones.
- Issues: cada pedido se trabaja desde un issue del backlog; citar `Refs #<n>` en commits y handover. El integrador cierra el issue solo verificando por contenido contra `main`.

## Contratos de endpoints
- Los endpoints de salary-overrides (GET/PATCH/DELETE por colaborador y mes) sostienen los ajustes mensuales por persona de la Previsión financiera y admiten importes con signo (extra o descuento). Mantener ese contrato; cualquier cambio requiere actualizar la previsión.
