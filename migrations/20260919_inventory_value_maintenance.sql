-- Purchase value and depreciation inputs per unit, plus an append-only
-- maintenance log. Depreciation is computed on read; nothing here rewrites
-- value, status, reservations or custodian history.
alter table agency_inventory add column if not exists purchase_value numeric(14,2);
alter table agency_inventory add column if not exists purchase_date date;
alter table agency_inventory add column if not exists depreciation_method text not null default 'none';
alter table agency_inventory add column if not exists useful_life_months integer;
alter table agency_inventory add column if not exists residual_value numeric(14,2) not null default 0;

do $$ begin
 if not exists(select 1 from pg_constraint where conname='inventory_purchase_value_valid') then
  alter table agency_inventory add constraint inventory_purchase_value_valid
   check(purchase_value is null or purchase_value between 0 and 999999999999);
 end if;
 if not exists(select 1 from pg_constraint where conname='inventory_depreciation_method_valid') then
  alter table agency_inventory add constraint inventory_depreciation_method_valid
   check(depreciation_method in ('none','linear'));
 end if;
 if not exists(select 1 from pg_constraint where conname='inventory_useful_life_valid') then
  alter table agency_inventory add constraint inventory_useful_life_valid
   check(useful_life_months is null or useful_life_months between 1 and 600);
 end if;
 if not exists(select 1 from pg_constraint where conname='inventory_residual_within_purchase') then
  alter table agency_inventory add constraint inventory_residual_within_purchase
   check((purchase_value is null and residual_value=0) or (purchase_value is not null and residual_value between 0 and purchase_value));
 end if;
end $$;

create table if not exists agency_inventory_maintenance (
 id bigserial primary key,
 organization_id bigint not null references organizations(id),
 inventory_id bigint not null,
 maintenance_date date not null,
 kind text not null check(length(trim(kind)) between 2 and 80),
 description text not null default '' check(length(description)<=2000),
 cost numeric(14,2) not null default 0 check(cost between 0 and 999999999999),
 currency text not null default 'PYG' check(currency in ('PYG','USD','EUR','BRL','ARS','MXN')),
 responsible_user_id bigint,
 created_by_user_id bigint not null,
 voided_at timestamptz,
 voided_by_user_id bigint,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(id,organization_id),
 foreign key(inventory_id,organization_id) references agency_inventory(id,organization_id),
 foreign key(organization_id,responsible_user_id) references organization_members(organization_id,user_id),
 foreign key(organization_id,created_by_user_id) references organization_members(organization_id,user_id),
 foreign key(organization_id,voided_by_user_id) references organization_members(organization_id,user_id)
);
create index if not exists inventory_maintenance_history
 on agency_inventory_maintenance(organization_id,inventory_id,maintenance_date desc,id desc);

do $$ declare t text;begin
 foreach t in array array['agency_inventory','agency_inventory_maintenance'] loop
  execute format('drop trigger if exists operation_audit on %I',t);
  execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
