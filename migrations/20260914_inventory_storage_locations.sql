-- Reusable tenant-scoped inventory storage places. Existing shelf text remains a
-- compatible fallback for imports, archived templates and free-form locations.
create table if not exists agency_inventory_storage_locations (
 id bigserial primary key,
 organization_id bigint not null references organizations(id),
 name text not null check(length(trim(name)) between 1 and 100),
 active boolean not null default true,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(id,organization_id)
);
create unique index if not exists inventory_storage_location_name_key
 on agency_inventory_storage_locations(organization_id,lower(trim(name)));

alter table agency_inventory add column if not exists storage_location_id bigint;
create index if not exists inventory_storage_location_lookup
 on agency_inventory(organization_id,storage_location_id) where storage_location_id is not null;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='inventory_storage_location_tenant_fk') then
  alter table agency_inventory add constraint inventory_storage_location_tenant_fk
   foreign key(storage_location_id,organization_id)
   references agency_inventory_storage_locations(id,organization_id);
 end if;
end $$;

-- Preserve every legacy shelf verbatim while creating one normalized template
-- per tenant/name. Rows with no shelf remain intentionally untemplated.
insert into agency_inventory_storage_locations(organization_id,name)
 select organization_id,min(trim(storage_shelf))
 from agency_inventory
 where nullif(trim(storage_shelf),'') is not null
 group by organization_id,lower(trim(storage_shelf))
 on conflict do nothing;
update agency_inventory i
 set storage_location_id=l.id
 from agency_inventory_storage_locations l
 where l.organization_id=i.organization_id
   and i.storage_location_id is null
   and nullif(trim(i.storage_shelf),'') is not null
   and lower(trim(l.name))=lower(trim(i.storage_shelf));

-- Optional responsible person for the place: any active member of the tenant.
alter table agency_inventory_storage_locations add column if not exists responsible_user_id bigint references users(id) on delete set null;
