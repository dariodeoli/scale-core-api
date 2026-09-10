create table if not exists scale_ruc_usage(month date primary key, used integer not null default 0 check(used between 0 and 100));
-- One authorized provider verification used during the September integration.
insert into scale_ruc_usage(month,used) values('2026-09-01',1) on conflict do nothing;
