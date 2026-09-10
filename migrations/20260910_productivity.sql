alter table agency_clients add column if not exists logo_url text;
alter table agency_clients add column if not exists color_key text not null default 'violet' check(color_key in ('violet','blue','teal','green','gold','rose','slate'));
create table if not exists agency_user_profiles (
 user_id bigint not null references users(id), organization_id bigint not null references organizations(id),
 full_name text not null default '',photo_url text,updated_at timestamptz not null default now(),
 primary key(user_id,organization_id)
);
create table if not exists agency_order_comments (
 id bigserial primary key, organization_id bigint not null references organizations(id),
 work_order_id bigint not null references agency_work_orders(id), author_user_id bigint references users(id),
 body text not null check(length(trim(body)) between 1 and 2000), created_at timestamptz not null default now()
);
create index if not exists order_comments_scope_idx on agency_order_comments(organization_id,work_order_id,id);
create table if not exists agency_internal_tasks (
 id bigserial primary key,organization_id bigint not null references organizations(id),title text not null,
 description text not null default '',status text not null default 'pending' check(status in ('pending','in_progress','done')),
 due_date date,assigned_user_id bigint references users(id),source_key text,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),unique(organization_id,source_key)
);
create table if not exists agency_source_events (
 id bigserial primary key,organization_id bigint not null references organizations(id),source_key text not null,
 source_url text not null,source_author text not null,body text not null,occurred_at timestamptz not null,
 imported_by bigint not null references users(id),created_at timestamptz not null default now(),unique(organization_id,source_key)
);
create table if not exists agency_work_templates (
 id bigserial primary key, organization_id bigint not null references organizations(id),
 name text not null, items jsonb not null, created_by bigint references users(id),created_at timestamptz not null default now()
);
create table if not exists agency_template_runs (
 id bigserial primary key,organization_id bigint not null references organizations(id),
 template_id bigint not null references agency_work_templates(id),project_id bigint not null references agency_projects(id),
 month date not null,created_by bigint references users(id),created_at timestamptz not null default now(),
 unique(organization_id,template_id,project_id,month)
);
alter table agency_work_orders add column if not exists template_run_id bigint references agency_template_runs(id);
do $$ declare t text; begin
 foreach t in array array['agency_order_comments','agency_work_templates','agency_template_runs','agency_user_profiles','agency_internal_tasks','agency_source_events'] loop
 execute format('drop trigger if exists operation_audit on %I',t);
 execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
