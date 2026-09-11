# Suscripción de Scale OS — preparación, no activación

Fecha de revisión: 2026-09-10. Módulo opcional; no se configuró ninguna cuenta,
producto, webhook, pago ni servicio externo. Las pruebas usan PGlite y respuestas
Stripe simuladas. No hay SDK nuevo ni modificación de package.json.

**Unidad de cobro: una agencia/organización, no un usuario.** USD 10 o PYG 50.000
por mes incluye a todos los integrantes de esa agencia, sin cantidad de asientos,
cargos por invitación ni multiplicación por miembros. `quantity=1` permanece fija
al agregar personas. Cada agencia nueva adherida tiene su propia suscripción.
Las empresas existentes sin fila quedan exentas: no se les cobra retroactivamente.

## Contrato para integración

```js
import {startTrial, subscriptionState, subscriptionBilling} from './subscription-billing.js';
```

- `await startTrial(c, organizationId, currency = 'USD')`: solo en el alta
  explícita de una organización nueva. Acepta USD/PYG. Usa la transacción del
  cliente `c`: **no hace BEGIN, COMMIT ni ROLLBACK**. Inserta una prueba de
  720 horas desde `now()`. Si ya existe, conserva moneda y fechas. Devuelve
  `{currency, trialEndsAt}`; demos devuelven `null`. No llamar desde login,
  `/auth/me`, lecturas ni un backfill de empresas existentes.
- `await subscriptionState(db, user, now?)`: consulta membresía vigente y devuelve
  exactamente `{status, hasAccess, currency, amount, trialEndsAt, dueAt,
  suspendAt, daysRemaining, canManage, checkoutReady}`. `now` es Date o valor
  admitido por Date, para pruebas. No hace llamadas a Stripe.
- `await subscriptionBilling({req,res,url,db,session,body,send})`: devuelve
  `false` si no reconoce la ruta; `true` después de responder. Solo `db.connect`
  para las transacciones del handler; no pasar un cliente que ya esté dentro
  de otra transacción a este handler.

Registrar `migrations/20260911_subscriptions.sql` después del esquema base y de
`20260908_agency_suite.sql` y `20260910_demo_sessions.sql`. La migración crea
cuatro tablas nuevas, **sin insertar suscripciones ni modificar empresas**.
La migración de trial-registration y su límite de altas son responsabilidad
del integrador, no de este módulo.

| Ruta | Autorización y respuesta |
| --- | --- |
| GET `/api/billing/subscription` | Cualquier miembro autenticado/activo de la empresa de su sesión. Estado directo, sin IDs Stripe ni tokens internos. |
| POST `/api/billing/checkout` | Solo owner de sesión **y** membresía actual. `{}` o `{currency:'USD'|'PYG'}` coincidente con el alta. Devuelve `{url}` HTTPS de `checkout.stripe.com`. Si un checkout ya completado se reconcilia al consultar, devuelve `{completed:true}`: refrescar estado, no intentar abrir una URL ausente. |
| POST `/api/billing/portal` | Solo owner. Body `{}`. Requiere customer/subscription previamente vinculados. Disponible aunque el estado de cobro esté pausado, vencido o suspendido. Devuelve `{url}` de `billing.stripe.com`. |
| POST `/api/billing/webhook` | Sin sesión/cookie. Firma Stripe sobre bytes crudos, validada antes de interpretar JSON. |

El webhook debe llegar **antes** de parsers JSON, de la exigencia de sesión y
del gate de suscripción. El handler lee directamente el stream de `req`; también
admite `req.rawBody` únicamente si es Buffer de los bytes originales, nunca
`JSON.stringify(body)`. Límite 256 KiB. Excluir solo ese webhook del control
CSRF de navegador. Checkout/portal deben conservar el control de origen/CSRF
existente y estar accesibles al owner aunque el gate general suspenda acceso.
No ejecutar `session` antes del webhook. `send` debe conservar el status del handler.

El módulo no implementa el gate de agencia, signup, metrics/hub ni `/auth/me`:
los integra main. No cambia permisos funcionales ni elimina datos. La UI de
gracia debe ser persistente; **no se envían notificaciones ni emails propios**.

## Estados y límites

- Sin fila: `unmanaged`, acceso conservado, fechas/días nulos. No hay corte a
  empresas existentes. Demo clonada o plantilla conocida: `demo`, exenta.
- Antes de `trialEndsAt`: `trialing`. Prueba absoluta de 30 × 24 horas.
- Pago verificado que cubre el presente: `active` hasta el final del período.
- `dueAt` inicial es `trialEndsAt`; solo un período mensual pagado y verificado
  puede adelantarlo. Desde dueAt: `grace`; desde **dueAt + 48 horas inclusive**:
  `suspended`. Reintentos, cambios de estado de Stripe y eventos antiguos nunca
  mueven dueAt por sí mismos. Cancelar no borra el período ya pagado.
- `daysRemaining`: techo de días hasta fin de prueba, fin de período pagado o
  fin de gracia según estado; cero si suspendido. No es una nueva duración.
- `canManage` informa owner actual, salvo demos; no otorga permisos en la agencia.
- `checkoutReady` significa que la configuración requerida está completa para
  una empresa administrada. No prueba cuenta/precios habilitados: se verifican
  contra Stripe al pulsar. Sin credenciales, la prueba local conserva sus fechas;
  no activar comercialmente un gate que termine bloqueando a usuarios sin un
  canal de pago validado. Coordinar esa decisión con main antes de habilitarlo.

La moneda es **fija desde el alta**, independiente de la moneda operativa de la
agencia. Signup puede elegir USD/PYG; altas que omiten moneda quedan USD.
La UI no debe presentar un selector modificable durante checkout.
Cambiarla devuelve `409 BILLING_CURRENCY_LOCKED` antes de crear un intento o
contactar a Stripe. No se aceptan montos, IDs de clientes/suscripciones,
organizaciones, precios ni URLs enviados por el navegador.

## Configuración futura (no realizada)

No incluir valores de credenciales en código, documentación, logs ni respuestas.
El módulo permanece deshabilitado salvo configuración completa:

| Variable | Propósito |
| --- | --- |
| `STRIPE_BILLING_ENABLED` | Literal `true` para permitir integración externa futura. Omitir ahora. |
| `STRIPE_SECRET_KEY` | Secreto del servidor, test o live, nunca `NEXT_PUBLIC_*`. |
| `STRIPE_WEBHOOK_SECRET` | Secreto de firma del endpoint correspondiente. |
| `STRIPE_PRODUCT_ID` | Producto único del plan mensual autorizado. |
| `STRIPE_PRICE_USD` | Precio recurrente de USD 10: `unit_amount=1000`. |
| `STRIPE_PRICE_PYG` | Precio recurrente de PYG 50.000: `unit_amount=50000`, sin multiplicar por 100. |
| `BILLING_APP_ORIGIN` | Origen HTTPS propio, sin ruta, query, credenciales ni fragmento. No se toma de Host ni del cliente. |

Ambos precios deben ser por unidad, quantity 1, uso licensed, intervalo month,
interval_count 1, mismo producto y modo test/live que el secreto. Checkout exige
precio activo. No hay cambios de plan, impuestos automáticos, promociones,
prorrateos, créditos ni descuentos admitidos en el cálculo de acceso.
Confirmar elegibilidad de moneda/país y obligaciones tributarias antes de operar;
no se afirma que la cuenta comercial esté aprobada.

REST usa `Stripe-Version: 2025-03-31.basil` **fija**, no la versión por defecto
ni necesariamente la más reciente. Configurar futuros eventos snapshot del
endpoint con esa misma versión. El parser usa `invoice.parent.subscription_details`,
`line.parent.subscription_item_details`, `line.pricing.price_details` y períodos
en `subscription.items.data[0]`, no los campos superiores anteriores a Basil.
No cambiar esta versión sin actualizar fixtures y validar nuevamente la cuenta
de prueba. Los endpoints REST son `/v1/checkout/sessions`, `/v1/prices/:id`,
`/v1/subscriptions/:id`, `/v1/invoices/:id` y `/v1/billing_portal/sessions`.

El checkout hospedado muestra la recurrencia y el importe fijo. La petición del
owner solo prepara esa pantalla; la aceptación/autorización del cobro corresponde
al flujo Stripe. Se exige método de pago; no se crean PaymentIntents ni cargos
directamente desde la aplicación. Los redirect locales solo refrescan estado:
**nunca** conceden acceso por `billing=success` o por una URL de retorno.

Preparar el portal futuro para método de pago, facturas y cancelación; no habilitar
cambio a otros planes/precios ni descuentos. No hay activación automática de
planes sustitutos: una suscripción ya vinculada va al portal. Recontratación de
suscripciones terminadas o cambios de moneda requieren un flujo separado, aún
fuera de alcance; no crear otra suscripción a ciegas.

## Ensayos, reintentos y webhooks

Checkout usa `subscription_data[trial_end]` absoluto original, jamás un nuevo
`trial_period_days`. Stripe exige al menos 48 horas de trial restante en Checkout;
este módulo reserva 49 horas para que una sesión de 30 minutos no cruce ese mínimo.
Si faltan menos de 49 horas pero la prueba no terminó, devuelve
`409 BILLING_TRIAL_ENDING`: la UI debe indicar volver al finalizar. No hay cobro
adelantado ni ampliación gratuita para sortear esa limitación.

Cada intento guarda parámetros inmutables **antes** de la llamada externa y usa
la misma clave de idempotencia. Repetir el botón recupera la sesión abierta. Una
sesión cuya expiración se verifica se cierra localmente y responde
`409 BILLING_CHECKOUT_EXPIRED`; el siguiente clic puede crear otro intento, con
el fin de trial original. Resultado desconocido por más de 23 horas devuelve
`409 BILLING_RECONCILIATION_REQUIRED`, sin generar otra suscripción. Hace falta
conciliación administrativa; no hay un recuperador automático de esos casos.

Eventos admitidos: `checkout.session.completed`,
`checkout.session.async_payment_succeeded`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`,
`invoice.payment_succeeded`, `invoice.payment_failed`.

- HMAC-SHA256 sobre `timestamp.rawBody`, comparación constante, firmas `v1`,
  tolerancia absoluta de 300 segundos. Se rechazan otros modos y eventos Connect.
- Registro único por event ID dentro de la transacción. Error externo/DB revierte
  la marca para admitir reintento; factura pagada también tiene unicidad propia.
- Vinculación inicial solo desde un intento de Checkout previamente creado por
  el servidor; se recupera la sesión y se valida su token, organización y sub.
  Eventos de suscripciones ajenas se ignoran: no crean altas a partir de metadata.
- Se bloquea la fila de suscripción mientras se recuperan los objetos actuales.
  No se concede acceso por un snapshot de pago, `subscription.status='active'`
  ni por un evento viejo de cancelación. El último período pagado es monótono.
- Se comprueban cliente, suscripción, producto, precio, moneda, quantity, importe
  completo y período mensual. La factura actual debe corresponder al período del
  ítem actual. Facturas cero de trial, parciales o marcadas pagadas fuera de Stripe
  no conceden un período. Pagos viejos no reinician la prueba ni la gracia.
- Sin borrado de datos ni cambios en contabilidad comercial de la agencia.

Procesamiento síncrono acotado, con timeout de 8 s por petición a Stripe y respuesta
no exitosa ante fallas. No hay cola de jobs/cron ni instalación de servicios. Antes
de habilitar en producción, comprobar presupuesto de timeout del host y reintentos
reales del proveedor; si exige respuesta más rápida, coordinar un inbox/worker
durable como alcance separado. Nunca responder éxito antes de persistir el resultado.

## Validación local y limitaciones

`node test-subscription-billing.mjs` ejecuta migración repetible, transacción de
signup, fronteras de trial/gracia, owner/tenant, ambas monedas, firma cruda,
idempotencia, eventos viejos, períodos y montos incorrectos, fallos externos y
portal pausado. `node --check subscription-billing.js` verifica sintaxis.

PGlite usa una única conexión serializada: **no demuestra concurrencia real con
varias conexiones PostgreSQL**. Las llamadas Stripe están totalmente simuladas.
No se abrieron navegador, localhost, túneles ni recursos bloqueados. Falta una
validación futura autorizada en sandbox de Stripe de precios, versión, consentimiento,
webhooks reales, portal y renovación. No hay proveedor activado ni cobros reales.

## Fuentes oficiales consultadas

- [Trials de suscripciones](https://docs.stripe.com/billing/subscriptions/trials):
  timestamp absoluto y factura inicial sin importe.
- [Checkout y trials](https://docs.stripe.com/payments/checkout/free-trials) y
  [creación de sesiones](https://docs.stripe.com/api/checkout/sessions/create):
  contrato de sesiones, `trial_end`, metadatos, precio y expiración.
- [Webhooks](https://docs.stripe.com/webhooks): cuerpo crudo, firma, duplicados,
  recuperación de objetos y orden de entrega no garantizado.
- [Cambios Basil en facturación](https://docs.stripe.com/changelog/basil/2025-03-31/adds-new-parent-field-to-invoicing-objects?locale=en-GB):
  compatibilidad explícita del campo `parent` y versión fija.
- [Ítem de suscripción](https://docs.stripe.com/api/subscription_items/object),
  [líneas de factura](https://docs.stripe.com/api/invoice-line-item/object) y
  [consulta de precio](https://docs.stripe.com/api/prices/retrieve): validaciones.
- [Monedas](https://docs.stripe.com/currencies): importes en unidad menor y
  elegibilidad por método/cuenta; PYG no usa decimales en cobros.
- [Sesiones del portal](https://docs.stripe.com/api/customer_portal/sessions/create):
  acceso hospedado para el customer vinculado.
