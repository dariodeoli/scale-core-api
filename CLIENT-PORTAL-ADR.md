# ADR-0001: Portal de cliente aislado

**Estado:** Confirmado — Dario confirmó las cuatro políticas el 2026-09-14; implementación inicial en curso (ver "Estado de implementación")  
**Fecha:** 2026-09-12  
**Decisor:** Dario / Scale OS

## Contexto

Scale OS ya tiene una revisión pública acotada por pieza (`/review/<token>`):
un token aleatorio de 256 bits se guarda como hash, vence en siete días, puede
revocarse, se invalida si cambia la versión y permite aprobar o pedir cambios.
Es deliberadamente un enlace *bearer*: cualquier persona que lo posea puede
responder con un nombre declarado. No es un portal ni verifica la identidad del
cliente.

La sesión interna actual (`scale_session`) exige una fila activa en
`organization_members`; convertir a un cliente en `viewer` daría acceso a
datos de toda la agencia. Reutilizar esa sesión o esos roles para clientes es
inseguro y queda descartado.

También existen enlaces externos de Drive. Scale no descarga ni controla su
ACL: una URL de Drive sólo es segura si el proveedor externo ya limita su
audiencia. No se debe construir un proxy de descarga que use credenciales de
la agencia.

## Decisión propuesta

Crear un portal en `cliente.scaleparaguay.com`, con identidad, sesión y
autorización separadas de empleados. La autorización se resuelve siempre por
la cadena `portal grant -> organization_id + client_id -> project -> work
order`; nunca por un `organization_members.role` ni por un ID recibido del
navegador.

El primer vertical será sólo lectura salvo tres mutaciones explícitas sobre
una entrega visible: comentar, aprobar y solicitar cambios. No incluirá
finanzas, equipo, pipeline, inventario, presupuestos internos, presencia ni
acciones de producción.

### Política que debe confirmar Dario

> Confirmadas por Dario el 2026-09-14, sin cambios respecto de lo propuesto.

1. Una cuenta de cliente ve **todos los proyectos y entregas publicadas** del
   cliente al que fue invitada, incluso los futuros, pero nunca archivos de
   otros clientes de la misma agencia.
2. Sólo `owner`, `admin`, `management` o `production` pueden invitar o
   revocar clientes; una invitación no concede ninguna membresía interna.
3. Una entrega se muestra solamente en estado `approved` o `published` y si
   fue marcada explícitamente como visible para el portal. Por defecto es
   privada.
4. "Descargar" en la primera versión abre el enlace HTTPS aprobado por la
   agencia en otra pestaña. No garantiza que Drive permita descargar ni crea
   un proxy. Si se necesita control de descarga real, hay que elegir un storage
   propio o una integración autorizada con Drive antes de publicarlo.

Si cualquiera de estas cuatro políticas cambia, no se debe aplicar este ADR
sin ajustar migración, consultas y pruebas.

## Modelo de datos propuesto

Nueva migración `migrations/20260912_client_portal.sql`:

```sql
create table client_portal_users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  email_normalized text not null unique,
  password_hash text,
  google_subject text unique,
  full_name text not null default '',
  photo_url text,
  email_verified_at timestamptz,
  disabled_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (password_hash is not null or google_subject is not null)
);

create table client_portal_grants (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  client_id bigint not null references agency_clients(id) on delete cascade,
  portal_user_id uuid not null references client_portal_users(id) on delete cascade,
  status text not null default 'active' check (status in ('active','revoked')),
  invited_by_user_id bigint not null references users(id),
  granted_at timestamptz not null default now(),
  revoked_at timestamptz,
  revoked_by_user_id bigint references users(id),
  unique (organization_id, client_id, portal_user_id)
);
create index client_portal_grants_scope_idx
  on client_portal_grants(portal_user_id, organization_id, client_id)
  where status='active';

create table client_portal_invites (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  client_id bigint not null references agency_clients(id) on delete cascade,
  email_normalized text not null,
  token_hash text not null unique,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  revoked_at timestamptz,
  invited_by_user_id bigint not null references users(id),
  created_at timestamptz not null default now()
);

create table client_portal_sessions (
  token_hash text primary key,
  portal_user_id uuid not null references client_portal_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table client_portal_deliveries (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  work_order_id bigint not null references agency_work_orders(id) on delete cascade,
  visible boolean not null default false,
  title text not null,
  summary text not null default '',
  asset_name text,
  asset_url text,
  published_at timestamptz,
  published_by_user_id bigint references users(id),
  version integer not null default 1,
  unique (organization_id, work_order_id)
);

create table client_portal_delivery_comments (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  delivery_id bigint not null references client_portal_deliveries(id) on delete cascade,
  portal_user_id uuid not null references client_portal_users(id),
  body text not null check (length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);

create table client_portal_delivery_decisions (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  delivery_id bigint not null references client_portal_deliveries(id) on delete cascade,
  portal_user_id uuid not null references client_portal_users(id),
  version integer not null,
  decision text not null check (decision in ('approved','changes_requested')),
  comment_id bigint references client_portal_delivery_comments(id),
  created_at timestamptz not null default now(),
  unique (delivery_id, portal_user_id, version)
);
```

The production migration must add tenant-pair foreign keys or triggers so a
`client_id`, `work_order_id`, and `organization_id` cannot belong to different
tenants. It must also add audit triggers to each mutable portal table and must
not put portal users in `users` or `organization_members`.

## API and authorization contract

All public client routes live under `/api/client-portal/*`; they use
`__Host-scale_client_session`, never `scale_session`. The cookie is `Secure`,
`HttpOnly`, `SameSite=Lax`, `Path=/`, has no `Domain` attribute and lasts at
most seven days. Every portal API response uses `Cache-Control: no-store`.

| Route | Purpose | Required authorization |
| --- | --- | --- |
| `GET /api/client-portal/invites/preview?token=` | Validate an invitation before auth, without exposing agency data | Valid, unexpired token only |
| `POST /api/client-portal/invites/accept` | Bind verified portal identity to the invitation email | Valid invite + verified matching email |
| `POST /api/client-portal/auth/login` | Password sign-in | Portal identity only; same throttle/reset semantics as internal auth |
| `GET /api/client-portal/auth/google/start` | Google OAuth with a portal-only state record | Portal invite or known portal account; verified email only |
| `POST /api/client-portal/auth/logout` | Revoke current client session | Current portal session |
| `GET /api/client-portal/me` | Name, company/client label and visible scope | Current portal session |
| `GET /api/client-portal/deliveries` | List deliveries for the granted `client_id` | Current portal session + SQL scope join |
| `GET /api/client-portal/deliveries/:id` | Delivery, asset metadata, decisions and comments | Same scope join; never accepts `clientId` from client |
| `POST /api/client-portal/deliveries/:id/comments` | Add client comment | Same scope join; body limit 2,000 |
| `POST /api/client-portal/deliveries/:id/decision` | Approve/request changes for current version | Same scope join; one decision per account/version |
| `POST /api/agency/clients/:id/portal-invites` | Issue a client invitation | Internal allowed roles + client belongs to tenant |
| `GET /api/agency/clients/:id/portal-access` | List/revoke invites/grants | Internal allowed roles + client belongs to tenant |
| `POST /api/agency/work-orders/:id/client-portal-delivery` | Publish/update/revoke a delivery | Internal allowed roles + work order/client tenant join |

The API must expose an intentionally small read model. It must not serialize
internal assignees, private comments, due dates marked private, costs,
invoices, audit history, direct project notes, or data from another delivery.

## UI composition

- Add a host branch for `cliente.scaleparaguay.com` in `scale-os/middleware.ts`.
  It may serve only portal routes, `/core-api/*`, `/brand/*`, and a noindex
  robots response. Do not expose the workspace fallback there.
- Add `app/cliente/*` pages: `/ingresar`, `/invitacion`, `/entregas` and
  `/entregas/[id]`.
- Reuse the existing `/core-api` reverse proxy in `next.config.mjs`; it keeps
  portal cookies same-site at the client host. Extend the Core API CORS allow
  list only with `https://cliente.scaleparaguay.com`, never with wildcards.
- Internal UI adds portal management inside an existing client detail, not a
  new employee role screen.

## Options considered

### A. Add a `client` role to `organization_members`

Rejected. Existing internal endpoints are role-based and organizational. A
mistake in one endpoint would expose other clients, finances or staff.

### B. Keep bearer review links as the portal

Rejected. They are useful for an ad-hoc single approval but identify possession
of a link, not a client. They cannot safely provide an account dashboard.

### C. Separate portal identities, grants and sessions

Proposed. It adds schema and auth code, but keeps clients out of the employee
authorization graph and allows precise `organization_id + client_id` scoping.

## Required tests before enabling

Create `test-client-portal.mjs` with at least these cases:

1. An invite previews as valid/expired/revoked before login and does not
   create a session, account or OAuth state on invalid tokens.
2. Accepting an invite requires a verified email equal to the invited email;
   an account for another email cannot claim it.
3. Password and Google portal sessions cannot call `/api/agency/*`; employee
   `scale_session` cannot call `/api/client-portal/*`.
4. A portal account for Client A cannot list or fetch Client B's projects,
   deliveries, URLs, comments or IDs, even by replacing every path parameter.
5. Revoking a grant immediately invalidates active portal sessions for that
   grant; revoking an invite prevents first use.
6. A non-visible, archived, wrong-tenant or pre-approval work order is never
   present in listing/detail responses.
7. A decision is atomic and idempotent per account/version; a new published
   version permits a new decision without overwriting the prior audit row.
8. Comments are scope-checked, length-limited, HTML-safe in the UI and create
   an internal notification without granting employee access.
9. Asset URLs only accept HTTPS without credentials; no endpoint fetches,
   proxies or follows the remote URL.
10. Cookie attributes, CSRF origin checks and rate limiting work for login,
    reset, invite acceptance and comments.
11. The client host returns `noindex`, has no workspace navigation and direct
    internal URLs do not render through its host branch.

## Existing files reviewed

- `content-review.js`: narrow bearer review link, token hashing, expiry,
  revocation and version-stamp protection.
- `migrations/20260908_daily_controls.sql`: existing content-review schema.
- `server.js`: current session depends on `organization_members`; central
  route dispatch and CORS/security headers.
- `password-access.js`: existing password-reset and throttling pattern.
- `media-policy.js`: HTTPS-link validation; it deliberately does not fetch
  external documents.
- `scale-os/next.config.mjs` and `scale-os/middleware.ts`: Core API proxy and
  host routing boundary.
- `scale-os/app/daily-controls.tsx`: existing internal UI for per-piece public
  reviews.

## Estado de implementación (2026-09-14)

- Las cuatro políticas quedaron confirmadas por Dario el 2026-09-14.
- Implementado en `client-portal.js`:
  - `GET /api/client-portal/deliveries/:id/activity`: log de actividad de la
    entrega (decisiones, comentarios, descargas y cambios de versión
    auditados), alcance por grant activo del cliente y `no-store`. Desviación
    de ruta: el diseño proponía `/api/client-portal/activity`; se implementó
    por entrega porque CP-1 exige actividad acotada a una entrega visible.
  - El detalle de entrega devuelve únicamente enlaces marcados
    `visible_to_client`; la bandera se gestiona en `work-order-links.js` y es
    privada por defecto.
- Desviación de normalización registrada: `due_time` acepta `HH:MM` y
  `HH:MM:SS` y se normaliza a `HH:MM`; la columna `time` devuelve `HH:MM:SS`.
- Cobertura de aislamiento en `test-client-portal.mjs` (CP-1 a CP-4).

## Consequences

The existing `/review/<token>` flow remains available for one-off anonymous
reviews and is not silently upgraded into the portal. The portal starts only
after the four policy points are confirmed and the above isolation tests pass.
