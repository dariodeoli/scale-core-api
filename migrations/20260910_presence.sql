create table if not exists agency_usage_sessions(
 organization_id bigint not null references organizations(id) on delete cascade,
 user_id bigint not null references users(id) on delete cascade,
 session_key text not null,
 first_seen_at timestamptz not null default now(),last_seen_at timestamptz not null default now(),
 active_seconds integer not null default 0 check(active_seconds>=0),was_active boolean not null default false,
 primary key(organization_id,user_id,session_key)
);
create index if not exists agency_usage_recent on agency_usage_sessions(organization_id,last_seen_at desc);
create table if not exists agency_presence_tabs(
 organization_id bigint not null references organizations(id) on delete cascade,
 user_id bigint not null references users(id) on delete cascade,tab_id uuid not null,
 project_id bigint references agency_projects(id) on delete cascade,
 last_seen_at timestamptz not null default now(),is_active boolean not null default false,
 primary key(organization_id,user_id,tab_id)
);
create index if not exists agency_presence_project on agency_presence_tabs(organization_id,project_id,last_seen_at desc);
