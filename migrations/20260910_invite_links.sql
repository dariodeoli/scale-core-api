create table if not exists agency_invite_links (
 id bigserial primary key, organization_id bigint not null references organizations(id),
 token_hash text not null unique, role text not null check(role in ('owner','admin','management','finance','sales','production','editor','viewer')),
 mode text not null check(mode in ('single','approval')), created_by bigint not null references users(id),
 created_at timestamptz not null default now(), expires_at timestamptz not null,
 revoked_at timestamptz, used_at timestamptz
);
create table if not exists agency_access_requests (
 id bigserial primary key, link_id bigint not null references agency_invite_links(id),
 user_id bigint not null references users(id), full_name text not null,
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 created_at timestamptz not null default now(), decided_at timestamptz, decided_by bigint references users(id),
 unique(link_id,user_id)
);
alter table oauth_states add column if not exists invite_link_id bigint references agency_invite_links(id);
alter table sessions add column if not exists demo_role text check(demo_role in ('owner','admin','management','finance','sales','production','editor','viewer'));
alter table users add column if not exists is_demo_guest boolean not null default false;
create index if not exists agency_invite_org_idx on agency_invite_links(organization_id,id desc);
create index if not exists agency_requests_pending_idx on agency_access_requests(link_id,status);
