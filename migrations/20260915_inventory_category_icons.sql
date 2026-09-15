-- Optional icon keys for inventory categories. Null keeps the plain text chip;
-- values map to the shared frontend registry and are validated on write.
alter table agency_inventory_categories add column if not exists icon text;
