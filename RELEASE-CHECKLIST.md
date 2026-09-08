# Scale OS - entrega del 8 de septiembre de 2026

## Alcance de esta entrega

- [x] Creación, consulta y edición de planes, pipeline e inventario; conversión idempotente de lead a cliente.
- [x] Edición de clientes, proyectos y órdenes; responsables, plazos, horas y enlaces HTTPS.
- [x] Aprobaciones internas de 1-3 pasos y estado publicado, con validación de permisos.
- [x] Suspensión, reactivación, cambio de rol y reenvío de invitación; sesiones invalidadas.
- [x] Recuperación de contraseña: token de un uso, vencimiento y respuesta sin enumerar cuentas.
- [x] Presupuestos de varios ítems, edición, PDF, enlace revocable, aceptación y conversión a factura.
- [x] Cotización de referencia por día; panel financiero separado por moneda e historial de actividad.
- [x] Crear otra empresa sin compartir sus datos; guía de inicio de cinco pasos.
- [x] Ambos despliegues finalizados en Owncoding Hub; frontend publicado y rutas privadas verificadas por HTTP.
- [x] PDF privado generado en producción (A4, una página, 38.280 bytes) y revisado visualmente, sin cortes ni superposiciones.
- [x] Copia diaria local de PostgreSQL, retención de siete días; primera ejecución exitosa el 8 de septiembre de 2026 a las 03:24 UTC.

## Pruebas y despliegue

Ejecutar `node test-suite.mjs`, `node test-operations.mjs`, `node --experimental-vm-modules test-auth.mjs` y el build de Scale OS. Las pruebas usan PostgreSQL efímero, no envían correos reales ni modifican producción.

Los tres conjuntos de pruebas y el build pasaron. En producción se verificaron por HTTP sesión, miembros, colaboradores, leads, inventario, planes, actividad, resumen financiero y configuración. Los accesos anónimos a datos privados fueron rechazados. Se creó únicamente una propuesta demostrativa adicional, «Demo · Propuesta con PDF», por Gs. 1.320.000; no se registraron cobros reales para esta prueba.

Versiones publicadas: API `6c44bd0` y frontend `9b8f75e`. La API se construye ahora desde `/Dockerfile` (antes Railpack ignoraba la instalación de Chromium); despliegue correctivo `6dz6shtrzeudsf7xdizccfri`, finalizado a las 03:30 UTC. Este ajuste es necesario para conservar la generación de PDF en los próximos despliegues.

Cambios aditivos de base de datos. Si falla salud, autenticación o guardado, volver a las versiones anteriores del API y frontend desde Owncoding Hub; no eliminar tablas ni registros nuevos. Los cambios ajenos de WEEM/Dadoo quedan fuera de los commits de esta entrega.

## Pendientes que no se deben presentar como terminados

- Conexión oficial de WhatsApp/Instagram, bandeja omnicanal, webhooks y automatizaciones tipo Manychat: requiere permisos y activos de Meta. No hay envíos automáticos habilitados.
- Copias externas y prueba de restauración: definir y verificar almacenamiento/retención en la infraestructura.
- Conciliación bancaria automática, cambios de moneda en transferencias y reversión de cobros: no están implementados en esta entrega.
- Aprobación de videos por un cliente externo: los pasos de producción son internos; la aprobación pública disponible corresponde a presupuestos.
- Revisión visual completa de Chrome: la herramienta rechazó acceso por política administrativa. No se ha eludido esa restricción.
- La guía de cinco pasos no obliga a completar datos. El diseño del PDF usa una plantilla fija; no es un constructor libre de secciones.
- El historial amplía la auditoría, pero algunos movimientos del código anterior carecen de actor; no inventar su autoría.

## Segunda ampliación — en verificación

- Reversión de cobros como contramovimiento inmutable, con motivo, responsable y saldo suficiente. Cobros y transferencias aceptan identificador de reintento para evitar duplicados.
- Transferencias PYG/USD con importe de salida, importe recibido y cotización registrada. No ejecuta órdenes bancarias reales.
- Conciliación mediante extracto CSV: deduplicación, cruce automático exclusivamente exacto/no ambiguo y vinculación manual. Importar/conciliar no modifica saldos. No hay conexión bancaria directa.
- Aprobación externa de piezas por enlace revocable de siete días: comentarios, solicitud de cambios y bloqueo de publicación cuando falta la aprobación de la versión actual.
- Presupuestos con secciones de texto reordenables/ocultables. Detalle de ítems y totales siempre visibles.
- Auditoría de nuevas altas y operaciones financieras. Atribución histórica solo cuando el registro original contiene autor.
- Script manual de verificación de restauración en base temporal independiente; pendiente ejecutar en Hub.

Pruebas: `test-daily-controls.mjs`, `test-suite.mjs`, `test-operations.mjs`, `test-auth.mjs`, build TypeScript y pruebas del parser CSV. Publicar API antes de frontend y verificar PDF público/privado, salud y movimientos demo en empresa separada. Los apartados anteriores describen la primera entrega; actualizar resultados al cerrar esta ampliación.

Dependencias externas comprobadas: el Hub devuelve cero almacenamientos S3; no hay configuración de Meta en la aplicación. El acceso de Chrome a Scale volvió a ser rechazado por imposibilidad de verificar la política administrativa. No eludirla.
