alter table organizations add column if not exists demo_owner_user_id bigint references users(id);
alter table organizations add column if not exists demo_source_id bigint references organizations(id);
alter table organizations add column if not exists demo_expires_at timestamptz;
alter table sessions add column if not exists demo_key text not null default md5(random()::text||clock_timestamp()::text);
create table if not exists agency_demo_sessions (
 demo_key text not null,user_id bigint not null references users(id),
 organization_id bigint not null unique references organizations(id),created_at timestamptz not null default now(),
 primary key(demo_key,user_id)
);
