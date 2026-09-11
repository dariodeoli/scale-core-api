alter table agency_invite_links add column if not exists click_count integer not null default 0;
alter table agency_invite_links add column if not exists account_count integer not null default 0;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='agency_invite_links_metrics_nonnegative') then
  alter table agency_invite_links add constraint agency_invite_links_metrics_nonnegative check(click_count>=0 and account_count>=0);
 end if;
end $$;
