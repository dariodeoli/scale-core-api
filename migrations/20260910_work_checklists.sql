-- Additive, empty checklists only. Never derives items from descriptions or imports.
-- Requires agency_suite (availability), operations_complete (audit), and work orders.
create unique index if not exists work_checklist_order_tenant_key on agency_work_orders(id,organization_id);
create table if not exists agency_work_checklists (
 organization_id bigint not null,work_order_id bigint not null,
 version bigint not null default 0 check(version>=0),
 primary key(organization_id,work_order_id),
 foreign key(work_order_id,organization_id) references agency_work_orders(id,organization_id) on delete cascade
);
create table if not exists agency_work_checklist_items (
 id bigserial primary key,organization_id bigint not null,work_order_id bigint not null,
 text text not null check(length(trim(text)) between 1 and 500),
 completed boolean not null default false,
 created_by_user_id bigint not null references users(id),
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 foreign key(organization_id,work_order_id) references agency_work_checklists(organization_id,work_order_id) on delete cascade
);
create index if not exists work_checklist_items_order on agency_work_checklist_items(organization_id,work_order_id,id);
do $$ declare t text;begin
 foreach t in array array['agency_work_checklists','agency_work_checklist_items'] loop
  execute format('drop trigger if exists operation_audit on %I',t);
  execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
