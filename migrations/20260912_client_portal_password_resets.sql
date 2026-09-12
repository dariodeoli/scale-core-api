-- Client portal identities are intentionally separate from internal users,
-- including their reset tokens. A reset invalidates every portal session.
create table if not exists client_portal_password_resets (
 token_hash text primary key,
 portal_user_id bigint not null references client_portal_users(id) on delete cascade,
 expires_at timestamptz not null,
 created_at timestamptz not null default now()
);
create index if not exists client_portal_password_resets_user on client_portal_password_resets(portal_user_id,expires_at);
