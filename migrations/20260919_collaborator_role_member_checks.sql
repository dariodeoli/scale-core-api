-- The collaborator role must also pass the baseline checks on members and users;
-- the loop repairs every role check in case an earlier widening never applied.
do $$
declare target record;
begin
  for target in
    select conname, conrelid::regclass as tbl
    from pg_constraint
    where contype='c'
      and conrelid in (select oid from pg_class where relkind='r' and relname in ('organization_members','users','agency_invite_links','sessions','agency_role_permissions'))
      and pg_get_constraintdef(oid) like '%viewer%'
  loop
    execute format('alter table %s drop constraint %I', target.tbl, target.conname);
  end loop;
end $$;
alter table organization_members add constraint organization_members_role_check check (role in ('owner','admin','management','finance','sales','production','editor','viewer','collaborator'));
alter table users add constraint users_role_check check (role in ('owner','admin','management','finance','sales','production','editor','viewer','collaborator'));
alter table agency_invite_links add constraint agency_invite_links_role_check check (role in ('owner','admin','management','finance','sales','production','editor','viewer','collaborator'));
alter table sessions add constraint sessions_demo_role_check check (demo_role in ('owner','admin','management','finance','sales','production','editor','viewer','collaborator'));
alter table agency_role_permissions add constraint agency_role_permissions_role_check check (role in ('owner','admin','management','finance','sales','production','editor','viewer','collaborator'));
