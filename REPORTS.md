# Informes mensuales de agencia

Preparación local, 10-09-2026. Sin llamadas externas, conversiones ni cambios de datos financieros. Una agencia/tenant por consulta. La migración es aditiva y repetible; requiere las migraciones existentes de suite, lifecycle y controles diarios.

## Integración

Importar `reports` de `./reports.js`, registrar `20260911_agency_reports.sql` y despachar `await reports({req,res,url,db,session,body,send})` antes de rutas genéricas de clientes. El handler devuelve `false` fuera de sus dos rutas y `true` después de responder. El gate general de suscripción sigue siendo responsabilidad de `server.js`.

`GET /api/agency/reports?month=YYYY-MM&months=12`: roles owner/admin/finance, comprobados tanto en sesión como en membresía activa de la organización activa. `month` omitido selecciona el actual de `America/Asuncion`; no admite meses futuros. `months` es entero de 1 a 24, incluye el mes seleccionado y devuelve la serie cronológica ascendente. No admite elegir otro tenant desde query/body.

Respuesta:

```json
{
  "asOf": "2026-09-10T15:00:00.000Z",
  "month": "2026-09",
  "historySince": "2026-09-10T12:00:00.000Z",
  "months": [{
    "month": "2026-09", "isPartial": true,
    "clients": {
      "active": 0, "added": null, "lost": null,
      "retentionPercent": null, "averageTenureDays": null, "tenureKnown": 0,
      "types": [], "plans": []
    },
    "financial": []
  }]
}
```

`types`: `{kind,count}[]`. `plans`: `{planId:string|null,name,count}[]`, más populares primero; sin asignación: `planId:null,name:"Sin plan"`. Solo clientes activos al corte. `financial`: `{currency,invoiced:string,collected:string,invoiceCount:number,billedClients:number,averageTicket:string|null,averageRevenuePerClient:string|null}[]`. Solo monedas con facturas o movimientos en el período; `[]` significa ausencia de registros, no una conversión a la moneda predeterminada.

## Metadata comercial del cliente

`GET /api/agency/clients/:id/reporting`: owner/admin/management/sales/finance.

```json
{
  "reporting": {
    "clientId": "12", "customerKind": "unknown", "servicePlanId": null,
    "relationshipStartedOn": null, "version": "1",
    "updatedAt": "2026-09-10T15:00:00.000Z", "archived": false
  },
  "plans": [{"id": "3", "name": "Gold"}]
}
```

Solo devuelve planes activos/no archivados del mismo tenant. La asignación histórica a un plan ya archivado permanece en `reporting.servicePlanId`, aunque no se ofrezca para nuevas asignaciones.

`PATCH` al mismo endpoint: owner/admin/management/sales. Body cerrado:

```json
{"expectedVersion":"1","customerKind":"company","servicePlanId":"3","relationshipStartedOn":"2026-09-01"}
```

Los tres campos editables son opcionales. `expectedVersion` es obligatorio; usar la cadena `reporting.version` recibida, no `updatedAt`. Permite `servicePlanId:null` y `relationshipStartedOn:null` para declarar desconocido/sin plan. Tipos válidos: `unknown|company|professional|individual|other`. Fecha ISO real, desde 1900, no futura local. No modifica estado, archivo ni tenant. Responde el mismo objeto que GET. 400 validación, 401 sin sesión, 403 rol/membresía, 404 cliente inexistente/ajeno, 409 versión obsoleta o cliente archivado. Actualizaciones del cliente y archivo/restauración incrementan la versión; el PATCH bloquea la fila y compara dentro de transacción.

## Historial y fórmulas

Se eligieron fotos completas append-only en PostgreSQL para capturar también las rutas existentes, sin depender de que cada caller recuerde registrar un evento. Una consulta SQL agrega todos los datos con el mismo snapshot MVCC. Índices por tenant/cliente/fecha y tenant/fecha; si crece el volumen, medir el plan antes de introducir proyecciones materializadas o particiones.

- `historySince` es el inicio de observación de clientes. Migración: coverage y eventos `observed` ahora, nunca reconstruidos desde `created_at`. Clientes existentes mantienen inicio de relación desconocido. Organizaciones nuevas reciben coverage al crearse y clientes nuevos evento `created` al insertarse; fecha de relación predeterminada = fecha real local del INSERT, no `created_at` editable.
- Antes de coverage, activos/altas/bajas/retención/antigüedad son `null`, y distribuciones `[]`. En el primer mes con coverage parcial, el stock al cierre sí es conocido; altas/bajas/retención permanecen `null` porque falta el inicio del período. `isPartial` también marca períodos sin cobertura y el mes actual aún abierto.
- Corte: último evento anterior al siguiente mes local y no posterior a `asOf`; empate por mayor `id`. Meses cerrados usan el último día local para antigüedad, el actual usa la fecha local de `asOf`. Respeta reglas históricas de zona horaria, incluido cambio estacional de 2024; no fija UTC-3 para todo el pasado.
- Activo: `active=true AND lifecycle_status='active' AND archived=false`. Pausados, cancelados, vencidos, inactivos y archivados quedan fuera. Los dos UPDATE existentes del lifecycle producen snapshots ordenados; para el stock gana el último.
- Altas: primera creación conocida del cliente, no activaciones/restauraciones. Cualquier `observed` previo impide convertir un cliente preexistente en alta. Dos eventos `created` sintéticos/automáticos del mismo cliente no duplican altas en otro mes.
- Bajas: clientes distintos con transición activo→no activo durante el mes. No es necesariamente el descenso neto: puede haber reactivaciones. Retención = porcentaje del conjunto activo al inicio que sigue activo al cierre; una reactivación dentro del mes cuenta como retenido al corte. Sin conjunto inicial: `null`, nunca división por cero.
- Antigüedad: promedio de días desde `relationship_started_on` hasta la fecha de corte entre activos con inicio conocido/no posterior al corte. No infiere edad con `created_at` ni excluye silenciosamente desconocidos: `tenureKnown` informa el denominador. `types`/`plans` usan atributos de la foto histórica, no el cliente actual. Nombre de plan: última etiqueta observada en las fotos del grupo, no un JOIN al catálogo actual.
- Facturado: suma `numeric` de `agency_invoices.total` por `issued_on` para issued/partial/paid/overdue; excluye draft/cancelled. Total con impuestos, no ganancia ni margen. Ticket promedio = total / cantidad de facturas, ingreso facturado por cliente = total / clientes facturados distintos (incluye tickets cero). No mide efectivo ni rentabilidad.
- Cobrado: pagos en `received_on`, menos reversos en `reversed_on`; no quita el cobro del mes original al revertirlo después. Moneda del cobro = moneda de la cuenta, sin convertir. Un reverso puede dar un mes negativo. No depende de que el cliente esté activo/archivado ni del estado posterior de la factura.
- Importes y promedios monetarios permanecen `numeric` SQL y salen como cadenas decimales; promedios redondeados a dos decimales. Nunca sumar monedas en frontend. Mes actual excluye facturas/pagos/reversos fechados después del día local actual.

El historial de clientes es por observación. Los financieros consultan los registros contables actuales con sus fechas comerciales: una corrección posterior de una factura puede cambiar el total histórico; esto no es un cierre contable inmutable ni un libro mayor nuevo. Archivar clientes no borra su historia financiera.

## Contrato para sembrar SOLO demos nuevas

`agency_reporting_coverage`: `organization_id bigint PK`, `history_since timestamptz NOT NULL`.

`agency_client_reporting_events`:

| Columna | Tipo / contrato |
| --- | --- |
| id | bigserial PK automático; desempata eventos |
| organization_id, client_id | bigint NOT NULL; FK compuesta a cliente del mismo tenant |
| event_at | timestamptz NOT NULL, default clock_timestamp(); instante de la foto |
| recorded_at | timestamptz NOT NULL, default clock_timestamp(); inserción real |
| event_kind | observed / created / changed / archived / restored |
| active | boolean NOT NULL, campo activo del cliente |
| lifecycle_status | active / paused / cancelled / expired / inactive |
| archived | boolean NOT NULL |
| customer_kind | unknown / company / professional / individual / other |
| service_plan_id | bigint nullable; ID real del plan de la demo |
| service_plan_name | text nullable; etiqueta capturada, ambos campos plan nulos o ambos presentes |
| relationship_started_on | date nullable |

Cada evento es una foto completa. El helper autorizado establece coverage al comienzo de la serie sintética e inserta eventos explícitos para clientes de esa demo nueva. No modificar/borrar eventos automáticos, no desactivar triggers. `created` automático actual queda, pero `added` solo cuenta la primera creación. Actualizar metadata real al final produce la foto `changed` actual coherente. Mantener orden temporal consistente; los `id` mayores ganan empates. Nunca aplicar el helper a tenants/clientes existentes ni transformar baselines reales en historia inventada.

Archivo/restauración normales quedan capturados sin modificar rutas compartidas. Los eventos rechazan UPDATE/DELETE; un borrado total autorizado necesita el protocolo de mantenimiento del integrador, con limpieza de tablas dependientes y sin disparar restauraciones sintéticas durante purge. Este módulo no habilita purges ni cambia la política R2.

## Validación local

`node test-reports.mjs`: PGlite en memoria y handlers reales, sin red. Comprueba migración repetible, baseline desconocido, roles/membresías/tenant, metadata y versiones, plan de otro tenant, archivo/restauración, PATCH lifecycle real, meses completos/parciales, zona histórica y año bisiesto, snapshots no retroactivos, denominadores cero, facturas multimoneda, archivos y reversos entre meses. No demuestra concurrencia multi-conexión de PostgreSQL real ni presentación visual del frontend.
