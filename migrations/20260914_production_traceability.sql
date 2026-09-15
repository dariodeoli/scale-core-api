-- Additive production traceability: work-order types, optional due time,
-- checklist completion attribution, client-visible named links and comment
-- deep-links on notifications. Requires agency_suite (work orders),
-- work_checklists, drive_links (named links), notifications (enqueue) and
-- order comments (comment mentions). No backfill: all columns nullable or
-- defaulted, so existing rows degrade gracefully.
alter table agency_work_orders add column if not exists work_type text;
alter table agency_work_orders add column if not exists due_time time;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='agency_work_orders_work_type_check') then
  alter table agency_work_orders add constraint agency_work_orders_work_type_check
   check(work_type is null or work_type in ('video','reedicion','foto','produccion','entregable'));
 end if;
end $$;
alter table agency_work_checklist_items add column if not exists completed_at timestamptz;
alter table agency_work_checklist_items add column if not exists completed_by_user_id bigint references users(id) on delete set null;
alter table agency_work_order_links add column if not exists visible_to_client boolean not null default false;
alter table agency_notifications add column if not exists comment_id bigint references agency_order_comments(id) on delete set null;
-- The mention path passes the comment key so the inbox can deep-link to the
-- exact comment. Existing call sites keep working through the default; the
-- previous 8-argument signature is replaced so calls never become ambiguous.
drop function if exists enqueue_agency_notification(bigint,bigint,text,text,text,bigint,bigint,text);
create or replace function enqueue_agency_notification(org bigint,recipient bigint,category text,subject text,content text,order_key bigint,project_key bigint,dedupe text,comment_key bigint default null)
 returns void language plpgsql as $$
begin
 if recipient is null or recipient::text=coalesce(current_setting('app.current_user',true),'') then return;end if;
 if not exists(select 1 from organization_members m join organizations o on o.id=m.organization_id where m.organization_id=org and m.user_id=recipient and m.active and m.removed_at is null and o.active and o.demo_owner_user_id is null)then return;end if;
 if exists(select 1 from agency_notification_preferences p where p.organization_id=org and p.user_id=recipient and not case category when 'assignment' then p.assignment when 'comment' then p.comment else p.due end)then return;end if;
 insert into agency_notifications(organization_id,user_id,kind,title,body,work_order_id,project_id,dedupe_key,comment_id)
 values(org,recipient,category,subject,left(content,1000),order_key,project_key,dedupe,comment_key) on conflict do nothing;
end $$;
