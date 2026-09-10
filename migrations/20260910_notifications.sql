create table if not exists agency_notification_preferences (
 organization_id bigint not null references organizations(id), user_id bigint not null references users(id),
 email_enabled boolean not null default false,assignment boolean not null default true,
 comment boolean not null default true,due boolean not null default true,primary key(organization_id,user_id)
);
create table if not exists agency_notifications (
 id bigserial primary key,organization_id bigint not null references organizations(id),
 user_id bigint not null references users(id),kind text not null check(kind in ('assignment','comment','due')),
 title text not null,body text not null default '',work_order_id bigint references agency_work_orders(id),
 project_id bigint references agency_projects(id),dedupe_key text not null,read_at timestamptz,
 created_at timestamptz not null default now(),email_status text not null default 'pending',
 email_attempts int not null default 0,next_attempt_at timestamptz not null default now(),
 unique(organization_id,user_id,dedupe_key)
);
create index if not exists notification_inbox_idx on agency_notifications(organization_id,user_id,id desc);
create or replace function enqueue_agency_notification(org bigint,recipient bigint,category text,subject text,content text,order_key bigint,project_key bigint,dedupe text)
 returns void language plpgsql as $$
begin
 if recipient is null or recipient::text=coalesce(current_setting('app.current_user',true),'') then return;end if;
 if not exists(select 1 from organization_members m join organizations o on o.id=m.organization_id where m.organization_id=org and m.user_id=recipient and m.active and m.removed_at is null and o.active and o.demo_owner_user_id is null)then return;end if;
 if exists(select 1 from agency_notification_preferences p where p.organization_id=org and p.user_id=recipient and not case category when 'assignment' then p.assignment when 'comment' then p.comment else p.due end)then return;end if;
 insert into agency_notifications(organization_id,user_id,kind,title,body,work_order_id,project_id,dedupe_key)
 values(org,recipient,category,subject,left(content,1000),order_key,project_key,dedupe) on conflict do nothing;
end $$;
create or replace function notify_agency_work() returns trigger language plpgsql as $$
declare recipient bigint;project_key bigint;order_key bigint;headline text;event_key text;
begin
 if tg_table_name='agency_work_orders' then
  if tg_op='UPDATE' and new.assigned_user_id is not distinct from old.assigned_user_id then return new;end if;
  perform enqueue_agency_notification(new.organization_id,new.assigned_user_id,'assignment','Te asignaron: '||new.title,'Revisá la pieza, la fecha de entrega y los enlaces.',new.id,new.project_id,'assignment:'||new.id||':'||txid_current());
 else
  if tg_table_name='agency_order_comments' then
   order_key=new.work_order_id;
   select o.project_id,'Comentario en: '||o.title into project_key,headline from agency_work_orders o where o.id=order_key and o.organization_id=new.organization_id;
  else project_key=new.project_id;headline='Nuevo comentario de proyecto';end if;
  event_key=tg_table_name||':'||new.id;
  for recipient in
   select distinct m.user_id from organization_members m join users u on u.id=m.user_id
   where m.organization_id=new.organization_id and m.active and m.removed_at is null and m.user_id is distinct from new.author_user_id
   and (position('@'||lower(u.email) in lower(new.body))>0 or exists(
    select 1 from agency_work_orders o where o.organization_id=new.organization_id and o.project_id=project_key and (order_key is null or o.id=order_key) and o.assigned_user_id=m.user_id))
  loop perform enqueue_agency_notification(new.organization_id,recipient,'comment',headline,new.body,order_key,project_key,event_key);end loop;
 end if;
 return new;
end $$;
drop trigger if exists work_notification on agency_work_orders;
create trigger work_notification after insert or update of assigned_user_id on agency_work_orders for each row execute function notify_agency_work();
drop trigger if exists work_notification on agency_order_comments;
create trigger work_notification after insert on agency_order_comments for each row execute function notify_agency_work();
drop trigger if exists work_notification on agency_project_comments;
create trigger work_notification after insert on agency_project_comments for each row execute function notify_agency_work();
create table if not exists agency_recurring_plans (
 id bigserial primary key,organization_id bigint not null references organizations(id),
 template_id bigint not null references agency_work_templates(id),project_id bigint not null references agency_projects(id),
 assigned_user_id bigint references users(id),created_by bigint not null references users(id),
 next_month date not null,active boolean not null default true,
 unique(organization_id,template_id,project_id)
);
do $$ declare t text; begin
 foreach t in array array['agency_notification_preferences','agency_notifications','agency_recurring_plans','agency_demo_sessions'] loop
 execute format('drop trigger if exists operation_audit on %I',t);
 execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
