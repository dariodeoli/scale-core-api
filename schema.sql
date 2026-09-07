create table if not exists users (
  id bigserial primary key,
  email text unique not null,
  password_hash text not null,
  role text not null default 'admin' check (role in ('admin','viewer')),
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  id text primary key,
  user_id bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_expiry_idx on sessions(expires_at);
create table if not exists events (
  id bigserial primary key,
  name text not null,
  event_date date not null default current_date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_name_date_idx on events(name,event_date);

alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check check (role in ('owner','admin','management','finance','sales','production','editor','viewer'));

create table if not exists agency_clients (
  id bigserial primary key,
  name text not null,
  legal_name text,
  email text,
  phone text,
  tax_id text,
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agency_clients_active_idx on agency_clients(active, name);

create table if not exists agency_projects (
  id bigserial primary key,
  client_id bigint not null references agency_clients(id) on delete restrict,
  name text not null,
  status text not null default 'active' check (status in ('active','paused','completed','cancelled')),
  drive_url text,
  start_date date,
  due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agency_projects_client_idx on agency_projects(client_id, status);

create table if not exists agency_work_orders (
  id bigserial primary key,
  project_id bigint not null references agency_projects(id) on delete cascade,
  title text not null,
  description text,
  status text not null default 'to_record' check (status in ('blocked','to_record','recorded','editing','review','approved','published')),
  due_date date,
  drive_url text,
  assigned_user_id bigint references users(id) on delete set null,
  estimated_hours numeric(8,2),
  actual_hours numeric(8,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agency_work_orders_status_idx on agency_work_orders(status, due_date);

-- Multiempresa: cada agencia opera dentro de una organización aislada.
create table if not exists organizations (
  id bigserial primary key,
  slug text unique not null,
  name text not null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
insert into organizations(slug,name) values('scale','Scale Strategy Group') on conflict(slug) do nothing;

create table if not exists organization_members (
  organization_id bigint not null references organizations(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  role text not null check (role in ('owner','admin','management','finance','sales','production','editor','viewer')),
  created_at timestamptz not null default now(),
  primary key(organization_id,user_id)
);
insert into organization_members(organization_id,user_id,role)
select o.id,u.id,case when u.role='admin' then 'owner' else u.role end
from organizations o cross join users u where o.slug='scale'
on conflict(organization_id,user_id) do nothing;

alter table sessions add column if not exists organization_id bigint references organizations(id) on delete cascade;
update sessions set organization_id=(select organization_id from organization_members m where m.user_id=sessions.user_id order by m.organization_id limit 1) where organization_id is null;

alter table events add column if not exists organization_id bigint references organizations(id) on delete cascade;
update events set organization_id=(select id from organizations where slug='scale') where organization_id is null;
create index if not exists events_organization_date_idx on events(organization_id,event_date);

alter table agency_clients add column if not exists organization_id bigint references organizations(id) on delete cascade;
update agency_clients set organization_id=(select id from organizations where slug='scale') where organization_id is null;
create index if not exists agency_clients_organization_idx on agency_clients(organization_id,active,name);

alter table agency_projects add column if not exists organization_id bigint references organizations(id) on delete cascade;
update agency_projects set organization_id=(select organization_id from agency_clients c where c.id=agency_projects.client_id) where organization_id is null;
create index if not exists agency_projects_organization_idx on agency_projects(organization_id,status);

alter table agency_work_orders add column if not exists organization_id bigint references organizations(id) on delete cascade;
update agency_work_orders set organization_id=(select organization_id from agency_projects p where p.id=agency_work_orders.project_id) where organization_id is null;
create index if not exists agency_work_orders_organization_idx on agency_work_orders(organization_id,status,due_date);
