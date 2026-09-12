-- Run after notifications and project_assignees. No historical notifications.
-- Snapshot the union of primary + supplemental IDs, never an inferred project
-- inheritance. Deferred triggers observe the final set of a multi-step edit.
alter table agency_notifications add column if not exists resolved_at timestamptz;
create table if not exists agency_assignment_notification_state (
 organization_id bigint not null references organizations(id) on delete cascade,
 kind text not null check(kind in ('projects','work-orders')),
 record_id bigint not null,
 user_id bigint not null references users(id) on delete cascade,
 primary key(organization_id,kind,record_id,user_id)
);
insert into agency_assignment_notification_state(organization_id,kind,record_id,user_id)
 select organization_id,kind,record_id,user_id from agency_record_assignees
 on conflict do nothing;

create or replace function notify_agency_assignment_set() returns trigger language plpgsql as $$
declare scope_id bigint;record_key bigint;record_kind text;project_key bigint;
 order_key bigint;headline text;recipient bigint;real_org boolean;
begin
 if tg_table_name in ('agency_projects','agency_work_orders') then
  if tg_op='UPDATE' and new.assigned_user_id is not distinct from old.assigned_user_id
   and new.organization_id is not distinct from old.organization_id then return null;end if;
  scope_id:=coalesce(new.organization_id,old.organization_id);
  record_key:=coalesce(new.id,old.id);
  record_kind:=case tg_table_name when 'agency_projects' then 'projects' else 'work-orders' end;
 else
  scope_id:=coalesce(new.organization_id,old.organization_id);
  record_kind:=case tg_table_name when 'agency_project_assignees' then 'projects' else 'work-orders' end;
  if tg_table_name='agency_project_assignees' then
   record_key:=coalesce(new.project_id,old.project_id);
  else
   record_key:=coalesce(new.work_order_id,old.work_order_id);
  end if;
 end if;
 -- Serialize concurrent supplemental edits against their parent, as the API
 -- does, and validate tenant ancestry before exposing a title or target.
 if record_kind='projects' then
  select p.id,'Te asignaron al proyecto: '||p.name into project_key,headline
   from agency_projects p join agency_clients cl on cl.id=p.client_id and cl.organization_id=p.organization_id
   where p.id=record_key and p.organization_id=scope_id for update of p;
 else
  select w.id,p.id,'Te asignaron: '||w.title into order_key,project_key,headline
   from agency_work_orders w join agency_projects p on p.id=w.project_id and p.organization_id=w.organization_id
   join agency_clients cl on cl.id=p.client_id and cl.organization_id=p.organization_id
   where w.id=record_key and w.organization_id=scope_id for update of w;
 end if;
 if not found then
  delete from agency_assignment_notification_state where organization_id=scope_id and kind=record_kind and record_id=record_key;
  return null;
 end if;
 select o.active and o.demo_owner_user_id is null and o.demo_source_id is null
  and o.slug<>'scale-demo-controles-20260908' into real_org
  from organizations o where o.id=scope_id for share;
 -- Membership is held through commit, including the notice insert.
 for recipient in
  select m.user_id from organization_members m
  where m.organization_id=scope_id and m.active and m.removed_at is null
   and exists(select 1 from agency_record_assignees a where a.organization_id=scope_id
    and a.kind=record_kind and a.record_id=record_key and a.user_id=m.user_id)
   and not exists(select 1 from agency_assignment_notification_state s where s.organization_id=scope_id
    and s.kind=record_kind and s.record_id=record_key and s.user_id=m.user_id)
  order by m.user_id for share of m
 loop
  -- Assignment includes self-assignment. Existing category opt-out is honored;
  -- email remains subject to the existing opt-in worker and read suppression.
  if real_org and not exists(select 1 from users where id=recipient and is_demo_guest)
   and not exists(select 1 from agency_notification_preferences where organization_id=scope_id and user_id=recipient and not assignment) then
   insert into agency_notifications(organization_id,user_id,kind,title,body,work_order_id,project_id,dedupe_key)
    values(scope_id,recipient,'assignment',headline,'Revisá los detalles, las fechas y los enlaces.',order_key,project_key,
     'assignment-set:'||record_kind||':'||record_key||':'||txid_current()) on conflict do nothing;
  end if;
 end loop;
 delete from agency_assignment_notification_state where organization_id=scope_id and kind=record_kind and record_id=record_key;
 insert into agency_assignment_notification_state(organization_id,kind,record_id,user_id)
  select organization_id,kind,record_id,user_id from agency_record_assignees
  where organization_id=scope_id and kind=record_kind and record_id=record_key on conflict do nothing;
 return null;
end $$;

-- The old primary-only work trigger would duplicate the final-set notice.
-- Comment triggers using notify_agency_work remain unchanged.
drop trigger if exists work_notification on agency_work_orders;
drop trigger if exists assignment_set_notification on agency_projects;
create constraint trigger assignment_set_notification after insert or update or delete on agency_projects
 deferrable initially deferred for each row execute function notify_agency_assignment_set();
drop trigger if exists assignment_set_notification on agency_work_orders;
create constraint trigger assignment_set_notification after insert or update or delete on agency_work_orders
 deferrable initially deferred for each row execute function notify_agency_assignment_set();
drop trigger if exists assignment_set_notification on agency_project_assignees;
create constraint trigger assignment_set_notification after insert or update or delete on agency_project_assignees
 deferrable initially deferred for each row execute function notify_agency_assignment_set();
drop trigger if exists assignment_set_notification on agency_work_order_assignees;
create constraint trigger assignment_set_notification after insert or update or delete on agency_work_order_assignees
 deferrable initially deferred for each row execute function notify_agency_assignment_set();
