create table if not exists agency_role_permissions (
 organization_id bigint not null references organizations(id) on delete cascade,
 role text not null check (role in ('owner','admin','management','finance','sales','production','editor','viewer')),
 capability text not null,
 allowed boolean not null,
 updated_by_user_id bigint references users(id),
 updated_at timestamptz not null default now(),
 primary key (organization_id, role, capability)
);
create index if not exists agency_role_permissions_role_idx on agency_role_permissions(organization_id,role);
