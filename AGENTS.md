# Reglas operativas — Scale Core API

## Entrega a main (regla obligatoria)
- Al terminar una tarea autorizada, commitear por unidad de trabajo y pushear a main. El deploy a producción sigue siendo exclusivo del release (`npm run release:patch` en scale-os dispara el flujo API → interfaz).
- Los endpoints de salary-overrides son legacy: no migrar datos ni ampliar su uso.
