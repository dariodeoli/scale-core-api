-- Preserve drive_url as the primary legacy link and store additional links in order.
alter table agency_projects add column if not exists drive_links jsonb not null default '[]'::jsonb;
alter table agency_work_orders add column if not exists drive_links jsonb not null default '[]'::jsonb;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='agency_projects_drive_links_array') then
  alter table agency_projects add constraint agency_projects_drive_links_array check(jsonb_typeof(drive_links)='array');
 end if;
 if not exists(select 1 from pg_constraint where conname='agency_work_orders_drive_links_array') then
  alter table agency_work_orders add constraint agency_work_orders_drive_links_array check(jsonb_typeof(drive_links)='array');
 end if;
end $$;
