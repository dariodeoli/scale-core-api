-- Colaborador: operational role for the whole workflow without finance, salaries, access or activity.
do $$
declare target record;
begin
  for target in
    select conname, conrelid::regclass as tbl
    from pg_constraint
    where contype='c'
      and conrelid in ('agency_invite_links'::regclass,'sessions'::regclass,'agency_role_permissions'::regclass)
      and pg_get_constraintdef(oid) like '%viewer%'
  loop
    execute format('alter table %s drop constraint %I', target.tbl, target.conname);
  end loop;
end $$;
alter table agency_invite_links add constraint agency_invite_links_role_check check (role in ('owner','admin','management','finance','sales','production','editor','viewer','collaborator'));
alter table sessions add constraint sessions_demo_role_check check (demo_role in ('owner','admin','management','finance','sales','production','editor','viewer','collaborator'));
alter table agency_role_permissions add constraint agency_role_permissions_role_check check (role in ('owner','admin','management','finance','sales','production','editor','viewer','collaborator'));
-- Archiving keeps clients and projects listed inside a collapsed capsule instead of removing them.
alter table agency_projects add column if not exists active boolean not null default true;
