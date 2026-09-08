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

## Pendientes actuales

- Conexión oficial de WhatsApp/Instagram, bandeja omnicanal, webhooks y automatizaciones tipo Manychat: requiere permisos y activos de Meta. No hay envíos automáticos habilitados.
- Copias externas: falta un destino de almacenamiento autorizado y verificar su retención. La prueba de restauración ya pasó (ver ampliación).
- Conexión bancaria directa: la conciliación disponible parte de un CSV importado, no de una API bancaria.
- Revisión visual completa de Chrome: la herramienta rechazó acceso por política administrativa. No se ha eludido esa restricción.
- La guía de cinco pasos no obliga a completar datos. Los presupuestos permiten secciones de texto reordenables y visibilidad; no un editor de maquetación libre tipo Canva.
- Algunos movimientos históricos no capturaron autor. Se recuperaron únicamente atribuciones sustentadas por los registros originales; no inventar las restantes.

## Enlaces de Drive y fotos — alcance del 08-09-2026

Dario confirmó que archivos y carpetas se gestionan únicamente por enlace, sin alojar sus contenidos en el admin. No hace falta conectar una cuenta ni descargar archivos mediante la API de Drive para este alcance. Los permisos del enlace siguen siendo responsabilidad de Google Drive.

- Alta y edición de proyectos/órdenes conservan enlaces HTTPS a archivos o carpetas; rechazan enlaces locales, datos embebidos y URLs con credenciales. El servidor no visita ni descarga el destino.
- La única carga de imagen incorporada es la foto del colaborador: selector JPG/PNG/WebP hasta 4 MB, reducción local antes de enviar, validación/recodificación en servidor, miniatura WebP hasta 256 × 256 sin metadatos. Se guarda en el perfil de la base existente, protegido por permisos y empresa. Las modificaciones conservan auditoría, incluida la foto anterior; quitarla del perfil no purga el historial ni las copias.
- No hay un alojamiento general de videos, documentos ni adjuntos. No cambia la generación bajo demanda de presupuestos PDF ni el importador de filas CSV.
- Pruebas: `node test-media.mjs`, suites existentes y build frontend. Nueva dependencia Sharp 0.35.4; auditoría npm de producción sin vulnerabilidades reportadas al realizar el cambio.
- Reversión: restaurar las versiones API `5328275` y frontend `7747420` si fallan salud, autenticación o guardado. No se requieren migraciones ni eliminación de fotos guardadas; el lector anterior puede mostrar las miniaturas, aunque no editarlas con su campo URL antiguo.

## Segunda ampliación — publicada y verificada por API

- Reversión de cobros como contramovimiento inmutable, con motivo, responsable y saldo suficiente. Cobros y transferencias aceptan identificador de reintento para evitar duplicados.
- Transferencias PYG/USD con importe de salida, importe recibido y cotización registrada. No ejecuta órdenes bancarias reales.
- Conciliación mediante extracto CSV: deduplicación, cruce automático exclusivamente exacto/no ambiguo y vinculación manual. Importar/conciliar no modifica saldos. No hay conexión bancaria directa.
- Aprobación externa de piezas por enlace revocable de siete días: comentarios, solicitud de cambios y bloqueo de publicación cuando falta la aprobación de la versión actual.
- Presupuestos con secciones de texto reordenables/ocultables. Detalle de ítems y totales siempre visibles.
- Auditoría de nuevas altas y operaciones financieras. Atribución histórica solo cuando el registro original contiene autor.
- Restauración verificada a las 04:52 UTC del 08-09-2026: 35 tablas y 174 registros, con igualdad de conteos y huellas de contenido. Base temporal y archivo de ensayo eliminados, sin sobrescribir producción. Tarea manual del Hub `tdgmqvwadkzbicnba3heqx5o`, con ejecución periódica deshabilitada.

Pruebas aprobadas: `test-daily-controls.mjs`, `test-suite.mjs`, `test-operations.mjs`, `test-auth.mjs`, build TypeScript y parser CSV. Migraciones completas verificadas en una sola transacción y repetidas sin cambios de saldos.

Prueba de producción en empresa demo separada (ID 22): cobro de Gs. 750.000, salida de Gs. 750.000 y entrada de USD 100, retorno y reversión del cobro. Saldo final: cero en ambas cuentas. Los reintentos no duplicaron operaciones. Dos filas conciliadas, reimportación sin duplicados. Aprobación pública y bloqueo previo de publicación comprobados. No se ejecutó ninguna transferencia bancaria real.

Frontend `7747420` publicado. PDF con secciones personalizado generado, abierto como A4 de una página y revisado visualmente; enlaces públicos servidos desde `app.scaleparaguay.com`. No confundir estas pruebas HTTP/documentales con QA interactivo de Chrome.

Dependencias externas comprobadas: el Hub devuelve cero almacenamientos S3; no hay configuración de Meta en la aplicación. El acceso de Chrome a Scale volvió a ser rechazado por imposibilidad de verificar la política administrativa. No eludirla.
