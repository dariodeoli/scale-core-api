alter table agency_clients add column if not exists lifecycle_status text;
update agency_clients set lifecycle_status=case when active then 'active' else 'inactive' end where lifecycle_status is null;
alter table agency_clients alter column lifecycle_status set default 'active';
alter table agency_clients alter column lifecycle_status set not null;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='agency_clients_lifecycle_status_check') then
  alter table agency_clients add constraint agency_clients_lifecycle_status_check check(lifecycle_status in ('active','paused','cancelled','expired','inactive'));
 end if;
end $$;
