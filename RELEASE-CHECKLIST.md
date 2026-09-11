# Scale OS — seguimiento de entregas

## Plan por agencia y registro — 10 de septiembre de 2026

Precio confirmado por Dario: US$10 o G.50.000 mensuales por agencia, con todos sus integrantes incluidos; son alternativas fijas, no una conversión. Landing y registro describen 30 días de prueba y 48 horas de gracia, con suspensión operativa desde el tercer día de atraso sin borrar datos. Empresas existentes y demos quedan exentas; no hay adhesión retroactiva.

Registro con Google verificado, consentimiento y una prueba pública por usuario; repetir el registro no reinicia fechas ni reemplaza su identidad. El servidor protege operaciones y agregados entre empresas suspendidas, conservando suscripción, cambio de empresa y cierre de sesión. Las nuevas migraciones son aditivas; rollback de código no debe borrar tablas.

Stripe está preparado pero desactivado. No se crearon productos, claves, cargos ni correos. Faltan configurar la cuenta y ambos precios, comprobar su disponibilidad y ejecutar pagos/webhooks reales en modo prueba antes de habilitar cobro. Ver STRIPE-SETUP.md: no basta pegar un enlace de pago para aplicar suspensión y reactivación verificadas. Los nuevos trials sí comienzan al registrarse; debe habilitarse y probarse el canal de pago antes de sus vencimientos.

Base anterior verificada: API `6b669384`, interfaz móvil `5005e160`; despliegues finalizados. Esta entrega utiliza componentes y API con proveedores simulados; no acredita QA visual en navegador, concurrencia PostgreSQL multiconexión ni cobro real. R2, revisión actual de Trello y resolución de spam conservan sus pendientes.

Verificación de esta entrega: 40 archivos frontend (50 resultados del runner), 28 suites backend, 27 migraciones registradas aplicadas dos veces y build de 40 rutas aprobados sobre export limpio sin WEEM/Dadoo. Billing cubre 87 casos y registro 104 solicitudes aisladas. También se verificaron ambas ramas del Hub opcional: métricas ausentes como `null` explícito, y agregados reales de fixtures sin incluir empresas suspendidas o ajenas. Publicación: comprobar commit exacto, salud y rechazo anónimo antes de darla por terminada.

## Continuación sin Cloudflare — 10 de septiembre de 2026

Dario pidió dejar R2 pendiente y avanzar con los demás puntos. No se cambia Cloudflare, el bucket, DNS, planes ni mantenimiento destructivo. Las versiones de partida son API `228e39e` e interfaz `8cecd779`.

- Acceso pendiente: prueba de componente reprodujo tres consultas superpuestas en una conexión lenta. Corrección de consulta única, límite de espera de diez segundos, cancelación al salir y comprobación al volver a la pestaña; una validación fallida elimina el aviso anterior de aprobación. El cierre de sesión informa fallos y permite reintentar. Cambios de estado anunciados por una región accesible. Esta pantalla no consulta datos privados del equipo.
- Fotos: comprobación local de abandono durante preparación, eventos simultáneos de carga y reintento del mismo enlace después de fallar la miniatura. Mantiene recorte central automático y proporciones de logos.
- Inventario: validación de categoría vacía y ubicaciones de devolución malformadas. 140 solicitudes integradas del recorrido categoría → reserva de varios equipos → cambio/cancelación → retiro → devolución con ubicación y mantenimiento; errores no liberan stock ni cambian responsables. La devolución disponible es completa, no parcial.
- Presencia: 56 solicitudes por el despachador real con dos usuarios/cookies diferentes, múltiples pestañas, identidad global, caducidad, suspensión y aislamiento. Transporte simulado y PGlite; cero conexiones externas.
- La regresión usa proveedores y datos aislados. No sustituye la prueba visual del selector de fotos, la presencia de dos personas en navegadores reales ni PostgreSQL con conexiones concurrentes.

Verificación previa: revisión entre agentes y correcciones aceptadas; 33 archivos de pruebas frontend y 26 suites backend aprobados, compilación de 39 rutas sobre árbol limpio sin WEEM/Dadoo. Falta confirmar commit exacto y salud después del despliegue. Si fallan salud, sesión o guardado, volver al código de partida, sin eliminar tablas/datos. No hay nuevas migraciones. La prueba visual y un monitoreo extendido de quince minutos no se dan por realizados.

### Pendientes conservados

1. R2 y restauración externa: aplazados por Dario; no reintentar ni activar limpieza en esta tanda.
2. QA visual final y selector de fotos: navegador bloqueado por comprobación de política administrativa; no eludir el control.
3. Trello: comparación actual pendiente de acceso permitido o exportación JSON aportada por Dario. No afirmar movimientos ni importar datos no comprobados.
4. Correo: recepción en spam confirmada, solución no acreditada; sin nuevos mensajes ni cambios de proveedor/DNS en esta tanda.
5. Presencia simultánea real y reservas concurrentes: conservar distinción entre pruebas aisladas y uso real de dos sesiones.

## Revisión del 10 de septiembre de 2026

Esta sección prevalece sobre los pendientes históricos de abajo. Base publicada: API `9e792650`, interfaz `8cecd779`. Esa entrega incorporó identidad personal unificada con demo aislada, fotos de autores, varios responsables, presencia por proyecto, checklist editable, reservas/devoluciones de inventario, moneda de empresa y formularios compactos. Pasaron 30 suites frontend, 23 backend, compilación de 39 rutas y las 25 migraciones registradas aplicadas dos veces. No se incluyeron cambios ajenos WEEM/Dadoo.

### Ajustes adicionales de esta revisión

- Defaults de moneda en los POST de presupuestos, cuentas y facturas: heredan la empresa únicamente cuando se omite la moneda; la selección explícita y los registros existentes se conservan.
- Asuntos de notificaciones operativas sin saltos de línea ni caracteres de control. No acredita una solución a spam.
- Demos nuevas con categorías editables, reparto de responsables, checklists y reservas ilustrativas. No se reinician ni alteran empresas reales o demos ya abiertas.
- Respaldo: detección de AWS CLI compatible, fecha de snapshot conservadora, clientes PostgreSQL sin prompt y errores por etapa sin revelar secretos. Mantenimiento desactivado no procesa ajustes de retención ajenos. No se activa borrado.
- Web de la agencia: `scaleparaguay` commit `8357f390`, GitHub Pages finalizado el 10-09-2026 a las 23:19:07 UTC. Nueve pruebas del tracker aprobadas. Script servido idéntico al publicado, HTML HTTP 200 y preflight CORS 204 para el origen de la agencia; no se generaron visitas sintéticas en estadísticas reales.

### Plan de verificación y límites

| Área | Verificación exigida | Límite |
|---|---|---|
| Monedas | POST integrado: seis preferencias, selección explícita, errores y aislamiento | No convertir saldos históricos |
| Demo | Alta/reinicio aislados, datos relativos, categorías/checklists/reservas y responsables coherentes | No usar empresas reales como fixture |
| Identidad e invitaciones | Roles por empresa, perfil global, demo aislada y solicitud sin acceso | QA simultánea con dos personas pendiente |
| Inventario | Solapes, retiro/devolución, responsable designado, revisión optimista | PGlite no sustituye concurrencia PostgreSQL multiconexión |
| Publicación | Todas las suites, migraciones dos veces, salud lista y rechazo anónimo | QA visual y monitoreo extendido no se dan por hechos |
| Respaldo | Subida R2, descarga, checksum, restauración aislada y comparación | Scripts simulados no prueban un respaldo externo |

Verificación local final: las 25 suites backend pasaron sobre una copia limpia de la entrega, incluyendo 68 casos de moneda en POST y las migraciones aplicadas dos veces; sin código ajeno WEEM/Dadoo. La publicación todavía exige confirmar estado y salud del despliegue. Si falla salud, autenticación, creación de demo o guardado tras publicar, regresar al código API `9e792650`; conservar tablas y datos, sin restauración destructiva. La interfaz `8cecd779` permanece compatible. Registrar el resultado efectivo del despliegue en la entrega; no confundir preparación local con publicación.

### Bloqueos externos confirmados

- Hub: `GET /api/v1/s3-storages` devuelve 200 y lista vacía; metadata de la app sin claves R2/S3/BACKUP/RESTORE/MAINTENANCE. La respuesta oculta valores, por lo que no demuestra ausencia de otras variables. Falta conectar el bucket privado autorizado y disponer de destino de restauración aislado. No se activó mantenimiento ni borrado de demos.
- Navegador: acceso bloqueado por política administrativa. No se intentó otra vía para eludirlo. Faltan la revisión visual final, selector real de foto, prueba de presencia simultánea y comparación de Trello; se solicitó restablecer acceso o aportar JSON.
- Correo: invitación confirmada en spam con SPF/DKIM/DMARC pass. Remitente propio Scale todavía requiere dominio verificado. No se enviaron mensajes nuevos, pagaron planes ni cambiaron DNS. No se garantiza bandeja principal.
- No hay PostgreSQL nativo/Docker local para concurrencia real ni herramientas AWS/pg_dump/pg_restore locales para comprobar el recorrido externo. Las pruebas existentes son aisladas y simuladas donde se indica.

## Historial — entrega del 8 de septiembre de 2026

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
