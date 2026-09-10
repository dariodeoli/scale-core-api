-- Supplemental assignees; assigned_user_id remains the legacy primary.
-- Requires 20260908_agency_suite.sql and 20260910_productivity.sql.
alter table agency_projects add column if not exists assigned_user_id bigint references users(id) on delete set null;
alter table agency_projects add column if not exists assignee_version bigint not null default 0;
alter table agency_work_orders add column if not exists assignee_version bigint not null default 0;
create unique index if not exists projects_assignee_tenant_key on agency_projects(id,organization_id);
create unique index if not exists orders_assignee_tenant_key on agency_work_orders(id,organization_id);

create table if not exists agency_project_assignees (
 organization_id bigint not null,project_id bigint not null,user_id bigint not null,
 created_at timestamptz not null default now(),
 primary key(organization_id,project_id,user_id),
 foreign key(project_id,organization_id) references agency_projects(id,organization_id) on delete cascade,
 foreign key(organization_id,user_id) references organization_members(organization_id,user_id) on delete cascade
);
create table if not exists agency_work_order_assignees (
 organization_id bigint not null,work_order_id bigint not null,user_id bigint not null,
 created_at timestamptz not null default now(),
 primary key(organization_id,work_order_id,user_id),
 foreign key(work_order_id,organization_id) references agency_work_orders(id,organization_id) on delete cascade,
 foreign key(organization_id,user_id) references organization_members(organization_id,user_id) on delete cascade
);
create index if not exists project_assignees_user_idx on agency_project_assignees(organization_id,user_id);
create index if not exists order_assignees_user_idx on agency_work_order_assignees(organization_id,user_id);

create or replace function guard_agency_assignee() returns trigger language plpgsql as $$
declare person bigint;
begin
 if tg_table_name in ('agency_projects','agency_work_orders') then
  if tg_op='UPDATE' then
   if new.assigned_user_id is not distinct from old.assigned_user_id then return new;end if;
   new.assignee_version:=old.assignee_version+1;
  end if;
  person:=new.assigned_user_id;
 else person:=new.user_id;end if;
 if person is not null then
  perform 1 from organization_members m join organizations o on o.id=m.organization_id
   where m.organization_id=new.organization_id and m.user_id=person and m.active and m.removed_at is null and o.active
   for share of m,o;
  if not found then raise exception 'Assignee must be an active member of this organization' using errcode='23514';end if;
 end if;
 return new;
end $$;
drop trigger if exists assignee_guard on agency_projects;
create trigger assignee_guard before insert or update of assigned_user_id on agency_projects for each row execute function guard_agency_assignee();
drop trigger if exists assignee_guard on agency_work_orders;
create trigger assignee_guard before insert or update of assigned_user_id on agency_work_orders for each row execute function guard_agency_assignee();
drop trigger if exists assignee_guard on agency_project_assignees;
create trigger assignee_guard before insert or update on agency_project_assignees for each row execute function guard_agency_assignee();
drop trigger if exists assignee_guard on agency_work_order_assignees;
create trigger assignee_guard before insert or update on agency_work_order_assignees for each row execute function guard_agency_assignee();
drop trigger if exists operation_audit on agency_project_assignees;
create trigger operation_audit after insert or update or delete on agency_project_assignees for each row execute function audit_agency_operation();
drop trigger if exists operation_audit on agency_work_order_assignees;
create trigger operation_audit after insert or update or delete on agency_work_order_assignees for each row execute function audit_agency_operation();

-- No membership or role is created by this view or by an assignment.
-- Legacy primary changes are reflected immediately; no backfill is needed.
create or replace view agency_record_assignees as
 select a.kind,a.organization_id,a.record_id,a.user_id,bool_or(a.is_primary) as is_primary
 from (
  select 'projects'::text kind,organization_id,id record_id,assigned_user_id user_id,true is_primary from agency_projects where assigned_user_id is not null
  union all select 'projects',organization_id,project_id,user_id,false from agency_project_assignees
  union all select 'work-orders',organization_id,id,assigned_user_id,true from agency_work_orders where assigned_user_id is not null
  union all select 'work-orders',organization_id,work_order_id,user_id,false from agency_work_order_assignees
 ) a join organization_members m on m.organization_id=a.organization_id and m.user_id=a.user_id
 join organizations o on o.id=a.organization_id
 where m.active and m.removed_at is null and o.active
 group by a.kind,a.organization_id,a.record_id,a.user_id;
