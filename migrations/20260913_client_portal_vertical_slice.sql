-- A portal identity represents one external client, never a cross-client
-- employee-style account. Existing grants are reduced to their newest active
-- scope before the guard is installed.
alter table client_portal_users add column if not exists organization_id bigint references organizations(id) on delete cascade;
alter table client_portal_users add column if not exists client_id bigint references agency_clients(id) on delete cascade;
alter table client_portal_users alter column password_hash drop not null;

with selected as (
 select distinct on (portal_user_id) portal_user_id,organization_id,client_id
 from client_portal_grants
 order by portal_user_id,active desc,granted_at desc,id desc
)
update client_portal_users u set organization_id=s.organization_id,client_id=s.client_id
from selected s where s.portal_user_id=u.id and (u.organization_id is null or u.client_id is null);
delete from client_portal_users u where not exists(select 1 from client_portal_grants g where g.portal_user_id=u.id);
update client_portal_grants g set active=false,revoked_at=coalesce(revoked_at,now())
from client_portal_users u
where g.portal_user_id=u.id and g.active and (g.organization_id<>u.organization_id or g.client_id<>u.client_id);
alter table client_portal_users alter column organization_id set not null;
alter table client_portal_users alter column client_id set not null;

create or replace function guard_client_portal_scope() returns trigger language plpgsql as $$
begin
 if tg_table_name='client_portal_users' then
  if new.organization_id is null or new.client_id is null or not exists(select 1 from agency_clients c where c.id=new.client_id and c.organization_id=new.organization_id)
  then raise exception 'Client portal account must belong to one client in its organization' using errcode='23514'; end if;
 end if;
 if tg_table_name in ('client_portal_invites','client_portal_grants') then
  if not exists(select 1 from agency_clients c where c.id=new.client_id and c.organization_id=new.organization_id)
  then raise exception 'Client portal client must belong to organization' using errcode='23514'; end if;
 end if;
 if tg_table_name='client_portal_grants' then
  if not exists(select 1 from client_portal_users u where u.id=new.portal_user_id and u.organization_id=new.organization_id and u.client_id=new.client_id)
  then raise exception 'Client portal grant must match the account client binding' using errcode='23514'; end if;
 end if;
 if tg_table_name='client_portal_deliveries' then
  if not exists(select 1 from agency_work_orders w join agency_projects p on p.id=w.project_id
   where w.id=new.work_order_id and w.organization_id=new.organization_id and p.organization_id=new.organization_id)
  then raise exception 'Client portal delivery must belong to organization' using errcode='23514'; end if;
 end if;
 if tg_table_name in ('client_portal_delivery_comments','client_portal_delivery_decisions') then
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
drop trigger if exists client_portal_account_scope_guard on client_portal_users;
create trigger client_portal_account_scope_guard before insert or update on client_portal_users for each row execute function guard_client_portal_scope();

-- Asset URLs are never exposed in delivery JSON. This table is the auditable
-- authorization boundary immediately before the browser is redirected.
create table if not exists client_portal_delivery_downloads (
 id bigserial primary key,
 organization_id bigint not null references organizations(id) on delete cascade,
 delivery_id bigint not null references client_portal_deliveries(id) on delete cascade,
 portal_user_id bigint not null references client_portal_users(id) on delete cascade,
 request_ip text not null default '',
 created_at timestamptz not null default now()
);
create index if not exists client_portal_delivery_downloads_audit on client_portal_delivery_downloads(delivery_id,portal_user_id,created_at desc);
