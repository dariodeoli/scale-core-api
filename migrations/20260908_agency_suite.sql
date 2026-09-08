alter table organization_members add column if not exists active boolean not null default true;
alter table organization_members add column if not exists removed_at timestamptz;
create table if not exists agency_archived_records (
 organization_id bigint not null references organizations(id),kind text not null,
 record_id bigint not null,removed_by bigint references users(id),removed_at timestamptz not null default now(),
 primary key(organization_id,kind,record_id)
);
alter table agency_projects add column if not exists approval_levels smallint not null default 1 check(approval_levels between 1 and 3);
alter table agency_work_orders add column if not exists approval_step smallint not null default 0;
alter table agency_budgets add column if not exists share_enabled boolean not null default false;
alter table agency_budgets add column if not exists accepted_by text;
alter table agency_budgets add column if not exists accepted_at timestamptz;
alter table agency_budgets add column if not exists revision integer not null default 1;
create table if not exists agency_plans (
 id bigserial primary key,organization_id bigint not null references organizations(id),name text not null,
 currency text not null default 'PYG' check(currency in ('PYG','USD')),items jsonb not null default '[]',
 notes text,active boolean not null default true,created_at timestamptz not null default now()
);
create table if not exists agency_leads (
 id bigserial primary key,organization_id bigint not null references organizations(id),name text not null,
 email text,phone text,stage text not null default 'lead' check(stage in ('lead','contacted','proposal','negotiation','won','lost')),
 amount numeric(14,2) not null default 0 check(amount>=0),currency text not null default 'PYG' check(currency in ('PYG','USD')),
 probability smallint not null default 10 check(probability between 0 and 100),notes text,
 client_id bigint references agency_clients(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists agency_inventory (
 id bigserial primary key,organization_id bigint not null references organizations(id),name text not null,
 serial_number text,category text,custodian_user_id bigint references users(id),
 value numeric(14,2) not null default 0 check(value>=0),currency text not null default 'PYG' check(currency in ('PYG','USD')),
 status text not null default 'available' check(status in ('available','in_use','maintenance','retired')),
 acquired_on date,notes text,created_at timestamptz not null default now()
);
create table if not exists agency_exchange_rates (
 organization_id bigint not null references organizations(id),rate_date date not null,usd_to_pyg numeric(14,4) not null check(usd_to_pyg>0),
 primary key(organization_id,rate_date)
);
create table if not exists agency_settings (
 organization_id bigint primary key references organizations(id),legal_name text,tax_id text,address text,phone text,
 onboarding_completed boolean not null default false
);
create table if not exists password_resets (
 token_hash text primary key,user_id bigint not null references users(id),expires_at timestamptz not null,created_at timestamptz not null default now()
);
create table if not exists auth_throttles (key text primary key,count integer not null default 1,expires_at timestamptz not null);
do $$ declare t text;begin
 foreach t in array array['agency_archived_records','agency_plans','agency_leads','agency_inventory','agency_clients','agency_projects','agency_work_orders','agency_budgets','organization_members','bank_accounts','agency_payments','account_transfers','agency_invoices'] loop
  execute format('drop trigger if exists operation_audit on %I',t);
  execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
