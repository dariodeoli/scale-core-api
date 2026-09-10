-- Requires agency_suite, daily_controls, productivity and company_currency.
-- No extensions, external tracking, or production/project mutations.
create table if not exists agency_inventory_categories (
 id bigserial primary key,organization_id bigint not null references organizations(id),
 name text not null check(length(trim(name)) between 1 and 80),active boolean not null default true,
 created_at timestamptz not null default now(),unique(id,organization_id)
);
create unique index if not exists inventory_category_name_key on agency_inventory_categories(organization_id,lower(trim(name)));
insert into agency_inventory_categories(organization_id,name)
 select organization_id,min(trim(category)) from agency_inventory where nullif(trim(category),'') is not null group by organization_id,lower(trim(category)) on conflict do nothing;
insert into agency_inventory_categories(organization_id,name)
 select o.id,v.name from organizations o cross join (values('Cámara'),('Lente'),('Audio'),('Iluminación'),('Computación'),('Accesorio'),('Otro')) v(name) on conflict do nothing;
alter table agency_inventory add column if not exists category_id bigint;
alter table agency_inventory add column if not exists storage_shelf text not null default '';
alter table agency_inventory add column if not exists storage_row text not null default '';
create unique index if not exists inventory_tenant_key on agency_inventory(id,organization_id);
create unique index if not exists inventory_project_tenant_key on agency_projects(id,organization_id);
do $$ begin
 if not exists(select 1 from pg_constraint where conname='inventory_category_tenant_fk') then
  alter table agency_inventory add constraint inventory_category_tenant_fk foreign key(category_id,organization_id) references agency_inventory_categories(id,organization_id);
 end if;
end $$;
update agency_inventory i set category_id=c.id from agency_inventory_categories c where c.organization_id=i.organization_id and lower(trim(c.name))=lower(trim(i.category)) and i.category_id is null;

create table if not exists agency_inventory_reservations (
 id bigserial primary key,organization_id bigint not null references organizations(id),
 project_id bigint not null,title text not null check(length(trim(title)) between 2 and 160),
 starts_at timestamptz not null,ends_at timestamptz not null check(ends_at>starts_at),
 status text not null default 'reserved' check(status in ('reserved','checked_out','returned','cancelled')),
 created_by_user_id bigint not null,return_user_id bigint not null,custodian_user_id bigint,
 checked_out_at timestamptz,returned_at timestamptz,cancelled_at timestamptz,
 checked_out_by_user_id bigint references users(id),returned_by_user_id bigint references users(id),
 notes text not null default '',version integer not null default 0,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(id,organization_id),
 foreign key(project_id,organization_id) references agency_projects(id,organization_id),
 foreign key(organization_id,created_by_user_id) references organization_members(organization_id,user_id),
 foreign key(organization_id,return_user_id) references organization_members(organization_id,user_id),
 foreign key(organization_id,custodian_user_id) references organization_members(organization_id,user_id)
);
create table if not exists agency_inventory_reservation_members (
 organization_id bigint not null,reservation_id bigint not null,user_id bigint not null,
 primary key(reservation_id,user_id),
 foreign key(reservation_id,organization_id) references agency_inventory_reservations(id,organization_id),
 foreign key(organization_id,user_id) references organization_members(organization_id,user_id)
);
create table if not exists agency_inventory_reservation_items (
 organization_id bigint not null,reservation_id bigint not null,inventory_id bigint not null,
 starts_at timestamptz not null,ends_at timestamptz not null,status text not null,
 primary key(reservation_id,inventory_id),
 foreign key(reservation_id,organization_id) references agency_inventory_reservations(id,organization_id),
 foreign key(inventory_id,organization_id) references agency_inventory(id,organization_id),
 check(ends_at>starts_at),check(status in ('reserved','checked_out','returned','cancelled')),
 -- Native range GiST handles both dimensions without btree_gist. A shared
 -- boundary is allowed: [start,end). This constraint arbitrates concurrent writes.
 constraint inventory_no_overlapping_reservations exclude using gist
  (int8range(inventory_id,inventory_id,'[]') with &&,tstzrange(starts_at,ends_at,'[)') with &&)
  where(status in ('reserved','checked_out'))
);
create unique index if not exists inventory_one_checkout on agency_inventory_reservation_items(inventory_id) where status='checked_out';
create index if not exists inventory_reservation_calendar on agency_inventory_reservations(organization_id,starts_at,ends_at);

create or replace function inventory_item_schedule() returns trigger language plpgsql as $$
begin
 select r.starts_at,r.ends_at,r.status into new.starts_at,new.ends_at,new.status
  from agency_inventory_reservations r where r.id=new.reservation_id and r.organization_id=new.organization_id;
 if not found then raise exception 'Reservation not found' using errcode='23503';end if;
 return new;
end $$;
drop trigger if exists inventory_item_schedule on agency_inventory_reservation_items;
create trigger inventory_item_schedule before insert or update on agency_inventory_reservation_items for each row execute function inventory_item_schedule();
create or replace function inventory_reservation_schedule() returns trigger language plpgsql as $$
begin
 if old.status<>new.status and not((old.status='reserved' and new.status in ('checked_out','cancelled')) or (old.status='checked_out' and new.status='returned')) then
  raise exception 'Invalid inventory transition' using errcode='23514';
 end if;
 if old.status<>'reserved' and (new.starts_at<>old.starts_at or new.ends_at<>old.ends_at or new.project_id<>old.project_id) then
  raise exception 'Only reserved equipment can be rescheduled' using errcode='23514';
 end if;
 update agency_inventory_reservation_items set starts_at=new.starts_at,ends_at=new.ends_at,status=new.status where reservation_id=new.id and organization_id=new.organization_id;
 return new;
end $$;
drop trigger if exists inventory_reservation_schedule on agency_inventory_reservations;
create trigger inventory_reservation_schedule after update on agency_inventory_reservations for each row execute function inventory_reservation_schedule();

-- Also protects legacy archive endpoints: reservations must be closed first.
create or replace function inventory_archive_guard() returns trigger language plpgsql as $$
begin
 if new.kind='inventory' and exists(select 1 from agency_inventory_reservation_items where organization_id=new.organization_id and inventory_id=new.record_id and status in ('reserved','checked_out')) then
  raise exception 'Equipment has an open reservation' using errcode='23514';
 end if;return new;
end $$;
drop trigger if exists inventory_archive_guard on agency_archived_records;
create trigger inventory_archive_guard before insert or update on agency_archived_records for each row execute function inventory_archive_guard();
do $$ declare t text;begin
 foreach t in array array['agency_inventory_categories','agency_inventory_reservations','agency_inventory_reservation_members','agency_inventory_reservation_items'] loop
  execute format('drop trigger if exists operation_audit on %I',t);
  execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
