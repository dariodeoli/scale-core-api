-- Advanced physical-inventory controls. Existing inventory and reservation
-- records remain valid; this only adds durable, append-only evidence.
alter table agency_inventory add column if not exists last_verified_counted_quantity integer;
alter table agency_inventory_verifications add column if not exists counted_quantity integer not null default 1;

do $$ begin
 if not exists(select 1 from pg_constraint where conname='inventory_last_verified_count_valid') then
  alter table agency_inventory add constraint inventory_last_verified_count_valid
   check(last_verified_counted_quantity is null or last_verified_counted_quantity between 0 and 1);
 end if;
 if not exists(select 1 from pg_constraint where conname='inventory_verification_count_valid') then
  alter table agency_inventory_verifications add constraint inventory_verification_count_valid
   check(counted_quantity between 0 and 1);
 end if;
end $$;

create table if not exists agency_inventory_trace (
 id bigserial primary key,
 organization_id bigint not null references organizations(id),
 inventory_id bigint not null,
 reservation_id bigint,
 event_type text not null check(event_type in ('inventory.created','inventory.updated','stock.verified','reservation.reserved','reservation.updated','reservation.cancelled','loan.checked_out','loan.checked_in')),
 actor_user_id bigint references users(id),
 event_at timestamptz not null default now(),
 context jsonb not null default '{}'::jsonb check(jsonb_typeof(context)='object'),
 unique(id,organization_id),
 foreign key(inventory_id,organization_id) references agency_inventory(id,organization_id),
 foreign key(reservation_id,organization_id) references agency_inventory_reservations(id,organization_id)
);
create index if not exists inventory_trace_history on agency_inventory_trace(organization_id,inventory_id,event_at desc,id desc);

-- The printed code may be selected when the physical asset is first registered,
-- but must never be repurposed afterwards. The API also rejects that change.
create or replace function inventory_code_immutable() returns trigger language plpgsql as $$
begin
 if new.inventory_code is distinct from old.inventory_code then
  raise exception 'Inventory code is immutable' using errcode='55000';
 end if;
 return new;
end $$;
drop trigger if exists inventory_code_immutable on agency_inventory;
create trigger inventory_code_immutable before update on agency_inventory
 for each row execute function inventory_code_immutable();

-- Verification and trace rows are evidence, not editable business records.
create or replace function inventory_history_immutable() returns trigger language plpgsql as $$
begin
 raise exception 'Inventory history is immutable' using errcode='55000';
end $$;
drop trigger if exists inventory_verification_immutable on agency_inventory_verifications;
create trigger inventory_verification_immutable before update or delete on agency_inventory_verifications
 for each row execute function inventory_history_immutable();
drop trigger if exists inventory_trace_immutable on agency_inventory_trace;
create trigger inventory_trace_immutable before update or delete on agency_inventory_trace
 for each row execute function inventory_history_immutable();

do $$ declare t text;begin
 foreach t in array array['agency_inventory_trace'] loop
  execute format('drop trigger if exists operation_audit on %I',t);
  execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
