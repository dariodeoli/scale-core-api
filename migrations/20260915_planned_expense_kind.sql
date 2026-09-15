-- Fixed versus variable planned expenses. Additive: the column stays null
-- for existing rows and clients treat null as variable, so nothing is
-- backfilled and old readers degrade gracefully.
alter table agency_planned_expenses add column if not exists kind text;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='agency_planned_expenses_kind_check') then
  alter table agency_planned_expenses add constraint agency_planned_expenses_kind_check
   check(kind is null or kind in ('fixed','variable'));
 end if;
end $$;
