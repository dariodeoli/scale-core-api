-- Inventory controls: a stable identifier per physical unit and an append-only
-- record of stock checks. This migration never changes reservation rows.
alter table agency_inventory add column if not exists inventory_code text;
alter table agency_inventory add column if not exists last_verified_at timestamptz;
alter table agency_inventory add column if not exists last_verified_by_user_id bigint;
alter table agency_inventory add column if not exists last_verification_result text;
alter table agency_inventory add column if not exists last_verification_differences text not null default '';
alter table agency_inventory_reservations add column if not exists checkout_note text not null default '';
alter table agency_inventory_reservations add column if not exists return_note text not null default '';

update agency_inventory
set inventory_code='INV-'||lpad(id::text,4,'0')
where nullif(trim(inventory_code),'') is null;

alter table agency_inventory alter column inventory_code set not null;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='inventory_code_not_blank') then
  alter table agency_inventory add constraint inventory_code_not_blank
   check(length(trim(inventory_code)) between 1 and 60);
 end if;
 if not exists(select 1 from pg_constraint where conname='inventory_last_verification_result_valid') then
  alter table agency_inventory add constraint inventory_last_verification_result_valid
   check(last_verification_result is null or last_verification_result in ('confirmed','difference','missing'));
 end if;
 if not exists(select 1 from pg_constraint where conname='inventory_verified_by_tenant_fk') then
  alter table agency_inventory add constraint inventory_verified_by_tenant_fk
   foreign key(organization_id,last_verified_by_user_id)
   references organization_members(organization_id,user_id);
 end if;
end $$;
create unique index if not exists inventory_code_tenant_key
 on agency_inventory(organization_id,lower(trim(inventory_code)));

create table if not exists agency_inventory_verifications (
 id bigserial primary key,
 organization_id bigint not null references organizations(id),
 inventory_id bigint not null,
 verified_by_user_id bigint not null,
 verified_at timestamptz not null default now(),
 result text not null check(result in ('confirmed','difference','missing')),
 differences text not null default '' check(length(differences)<=2000),
 note text not null default '' check(length(note)<=2000),
 adjusted boolean not null default false,
 before_state jsonb not null,
 after_state jsonb not null,
 unique(id,organization_id),
 foreign key(inventory_id,organization_id) references agency_inventory(id,organization_id),
 foreign key(organization_id,verified_by_user_id) references organization_members(organization_id,user_id)
);
create index if not exists inventory_verifications_history
 on agency_inventory_verifications(organization_id,inventory_id,verified_at desc,id desc);

-- Inserts receive the serial id before this trigger runs, so new units obtain
-- the same stable, printable format as the backfill above.
create or replace function inventory_assign_code() returns trigger language plpgsql as $$
begin
 if nullif(trim(new.inventory_code),'') is null then
  new.inventory_code='INV-'||lpad(new.id::text,4,'0');
 end if;
 return new;
end $$;
drop trigger if exists inventory_assign_code on agency_inventory;
create trigger inventory_assign_code before insert on agency_inventory
 for each row execute function inventory_assign_code();

do $$ declare t text;begin
 foreach t in array array['agency_inventory','agency_inventory_verifications'] loop
  execute format('drop trigger if exists operation_audit on %I',t);
  execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
