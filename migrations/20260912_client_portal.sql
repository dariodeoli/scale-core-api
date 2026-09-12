-- Client accounts deliberately live outside users/organization_members.
-- A portal identity can only reach records through an active client grant.
create table if not exists client_portal_users (
 id bigserial primary key,
 email text not null,
 email_normalized text not null unique,
 password_hash text not null,
 full_name text not null,
 disabled_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table if not exists client_portal_invites (
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
create index if not exists client_portal_invites_lookup on client_portal_invites(token_hash,expires_at) where revoked_at is null and accepted_at is null;
create table if not exists client_portal_grants (
 id bigserial primary key,
 organization_id bigint not null references organizations(id) on delete cascade,
 client_id bigint not null references agency_clients(id) on delete cascade,
 portal_user_id bigint not null references client_portal_users(id) on delete cascade,
 active boolean not null default true,
 granted_by_user_id bigint not null references users(id),
 granted_at timestamptz not null default now(),
 revoked_at timestamptz,
 revoked_by_user_id bigint references users(id),
 unique(organization_id,client_id,portal_user_id)
);
create index if not exists client_portal_grants_scope on client_portal_grants(portal_user_id,organization_id,client_id) where active;
create table if not exists client_portal_sessions (
 token_hash text primary key,
 portal_user_id bigint not null references client_portal_users(id) on delete cascade,
 expires_at timestamptz not null,
 created_at timestamptz not null default now(),
 last_seen_at timestamptz not null default now()
);
create index if not exists client_portal_sessions_expiry on client_portal_sessions(expires_at);
create table if not exists client_portal_deliveries (
 id bigserial primary key,
 organization_id bigint not null references organizations(id) on delete cascade,
 work_order_id bigint not null references agency_work_orders(id) on delete cascade,
 visible boolean not null default false,
 title text not null,
 summary text not null default '',
 asset_name text not null,
 asset_url text not null,
 version integer not null default 1 check(version>0),
 published_by_user_id bigint references users(id),
 published_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,work_order_id)
);
create index if not exists client_portal_deliveries_visible on client_portal_deliveries(organization_id,work_order_id) where visible;
create table if not exists client_portal_delivery_comments (
 id bigserial primary key,
 organization_id bigint not null references organizations(id) on delete cascade,
 delivery_id bigint not null references client_portal_deliveries(id) on delete cascade,
 portal_user_id bigint not null references client_portal_users(id) on delete cascade,
 body text not null check(length(trim(body)) between 1 and 2000),
 created_at timestamptz not null default now()
);
create table if not exists client_portal_delivery_decisions (
 id bigserial primary key,
 organization_id bigint not null references organizations(id) on delete cascade,
 delivery_id bigint not null references client_portal_deliveries(id) on delete cascade,
 portal_user_id bigint not null references client_portal_users(id) on delete cascade,
 version integer not null check(version>0),
 decision text not null check(decision in ('approved','changes_requested')),
 comment_id bigint references client_portal_delivery_comments(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(delivery_id,portal_user_id,version)
);

-- Do not permit cross-tenant client/order references even if an API bug tries.
create or replace function guard_client_portal_scope() returns trigger language plpgsql as $$
begin
 if tg_table_name in ('client_portal_invites','client_portal_grants') then
  if not exists(select 1 from agency_clients c where c.id=new.client_id and c.organization_id=new.organization_id)
  then raise exception 'Client portal client must belong to organization' using errcode='23514'; end if;
 end if;
 if tg_table_name='client_portal_deliveries' then
  if not exists(select 1 from agency_work_orders w join agency_projects p on p.id=w.project_id
   where w.id=new.work_order_id and w.organization_id=new.organization_id and p.organization_id=new.organization_id)
  then raise exception 'Client portal delivery must belong to organization' using errcode='23514'; end if;
 end if;
 if tg_table_name in ('client_portal_delivery_comments','client_portal_delivery_decisions') then
  -- A portal response may only be stored against a delivery from the same
  -- organization and a client grant matching that delivery's project client.
  if not exists(
   select 1 from client_portal_deliveries d
   join agency_work_orders w on w.id=d.work_order_id and w.organization_id=d.organization_id
   join agency_projects p on p.id=w.project_id and p.organization_id=w.organization_id
   join client_portal_grants g on g.organization_id=d.organization_id and g.client_id=p.client_id
   where d.id=new.delivery_id and d.organization_id=new.organization_id
    and g.portal_user_id=new.portal_user_id and g.active
  ) then raise exception 'Client portal response is outside the granted client scope' using errcode='23514'; end if;
 end if;
 return new;
end $$;
do $$ declare t text; begin
 foreach t in array array['client_portal_invites','client_portal_grants','client_portal_deliveries','client_portal_delivery_comments','client_portal_delivery_decisions'] loop
  execute format('drop trigger if exists client_portal_scope_guard on %I',t);
  execute format('create trigger client_portal_scope_guard before insert or update on %I for each row execute function guard_client_portal_scope()',t);
  execute format('drop trigger if exists operation_audit on %I',t);
  execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
