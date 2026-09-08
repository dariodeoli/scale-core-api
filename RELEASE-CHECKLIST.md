# Scale OS - entrega del 8 de septiembre de 2026

## Alcance de esta entrega

- [x] CRUD de planes, pipeline, inventario; conversión idempotente de lead a cliente.
- [x] Edición de clientes, proyectos y órdenes; responsables, plazos, horas y enlaces HTTPS.
- [x] Aprobaciones internas de 1-3 pasos y estado publicado, con validación de permisos.
- [x] Suspensión, reactivación, cambio de rol y reenvío de invitación; sesiones invalidadas.
- [x] Recuperación de contraseña: token de un uso, vencimiento y respuesta sin enumerar cuentas.
- [x] Presupuestos de varios ítems, edición, PDF, enlace revocable, aceptación y conversión a factura.
- [x] Cotización de referencia por día; panel financiero separado por moneda e historial de actividad.
- [x] Crear otra empresa sin compartir sus datos; guía de inicio de cinco pasos.
- [ ] Verificación final del PDF generado en producción y de ambos despliegues.

## Pruebas y despliegue

Ejecutar `node test-suite.mjs`, `node test-operations.mjs`, `node --experimental-vm-modules test-auth.mjs` y el build de Scale OS. Las pruebas usan PostgreSQL efímero, no envían correos reales ni modifican producción.

Cambios aditivos de base de datos. Si falla salud, autenticación o guardado, volver a las versiones anteriores del API y frontend desde Owncoding Hub; no eliminar tablas ni registros nuevos. Los cambios ajenos de WEEM/Dadoo quedan fuera de los commits de esta entrega.

## Pendientes que no se deben presentar como terminados

- Conexión oficial de WhatsApp/Instagram, bandeja omnicanal, webhooks y automatizaciones tipo Manychat: requiere permisos y activos de Meta. No hay envíos automáticos habilitados.
- Copias externas y prueba de restauración: definir y verificar almacenamiento/retención en la infraestructura.
- Conciliación bancaria automática, cambios de moneda en transferencias y reversión de cobros: no están implementados en esta entrega.
- Aprobación de videos por un cliente externo: los pasos de producción son internos; la aprobación pública disponible corresponde a presupuestos.
- Revisión visual completa de Chrome: la herramienta rechazó acceso por política administrativa. No se ha eludido esa restricción.
- La guía de cinco pasos no obliga a completar datos. El diseño del PDF usa una plantilla fija; no es un constructor libre de secciones.
- El historial amplía la auditoría, pero algunos movimientos del código anterior carecen de actor; no inventar su autoría.
