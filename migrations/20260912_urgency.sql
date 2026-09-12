-- Unset stays NULL for existing and new records. No inferred/backfilled urgency.
alter table agency_projects add column if not exists urgency smallint;
alter table agency_work_orders add column if not exists urgency smallint;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='agency_projects_urgency_range') then
  alter table agency_projects add constraint agency_projects_urgency_range check(urgency between 1 and 5);
 end if;
 if not exists(select 1 from pg_constraint where conname='agency_work_orders_urgency_range') then
  alter table agency_work_orders add constraint agency_work_orders_urgency_range check(urgency between 1 and 5);
 end if;
end $$;
