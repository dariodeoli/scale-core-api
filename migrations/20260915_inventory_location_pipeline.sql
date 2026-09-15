-- Track when each item last changed storage location; powers the pipeline cards.
alter table agency_inventory add column if not exists location_changed_at timestamptz;
update agency_inventory set location_changed_at=created_at where location_changed_at is null;
alter table agency_inventory_trace drop constraint if exists agency_inventory_trace_event_type_check;
alter table agency_inventory_trace add constraint agency_inventory_trace_event_type_check check(event_type in ('inventory.created','inventory.updated','stock.verified','reservation.reserved','reservation.updated','reservation.cancelled','loan.checked_out','loan.checked_in','location.changed'));
