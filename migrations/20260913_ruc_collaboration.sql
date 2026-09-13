-- Provider-owned RUC results are cached separately from user-entered client fields.
create table if not exists agency_ruc_lookup_cache (
 lookup_key text primary key,
 record jsonb,
 no_result boolean not null default false,
 expires_at timestamptz not null,
 updated_at timestamptz not null default now(),
 check ((no_result and record is null) or (not no_result and record is not null))
);
create index if not exists agency_ruc_lookup_cache_expiry_idx on agency_ruc_lookup_cache(expires_at);
alter table agency_clients add column if not exists ruc_legal_name text;
alter table agency_clients add column if not exists ruc_tax_state text;
alter table agency_clients add column if not exists ruc_source text;
alter table agency_clients add column if not exists ruc_refreshed_at timestamptz;

-- Collaboration link metadata stays relational and is never parsed from comments.
create table if not exists agency_work_order_links (
 id bigserial primary key,
 organization_id bigint not null references organizations(id) on delete cascade,
 work_order_id bigint not null references agency_work_orders(id) on delete cascade,
 label text not null check(length(trim(label)) between 2 and 120),
 url text not null check(length(url)<=2048),
 created_by_user_id bigint not null references users(id),
 created_at timestamptz not null default now(),
 unique(organization_id,work_order_id,url)
);
create index if not exists agency_work_order_links_order_idx on agency_work_order_links(organization_id,work_order_id,id);
do $$ begin
 if to_regprocedure('audit_agency_operation()') is not null then
  execute 'drop trigger if exists operation_audit on agency_work_order_links';
  execute 'create trigger operation_audit after insert or update or delete on agency_work_order_links for each row execute function audit_agency_operation()';
 end if;
end $$;
