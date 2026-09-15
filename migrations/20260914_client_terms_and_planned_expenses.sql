-- Commercial agreements and planning inputs are operational metadata, never invoices or payments.
create unique index if not exists agency_clients_commercial_terms_tenant_id on agency_clients(organization_id,id);
create unique index if not exists agency_plans_commercial_terms_tenant_id on agency_plans(organization_id,id);
create unique index if not exists agency_collaborators_commercial_terms_tenant_id on agency_collaborators(organization_id,id);

create table if not exists agency_client_commercial_terms (
 organization_id bigint not null references organizations(id) on delete cascade,
 client_id bigint not null,
 plan_id bigint not null,
 recurring_amount bigint not null check(recurring_amount>0),
 currency text not null check(currency in ('PYG','USD')),
 starts_on date not null,
 invoice_required boolean not null,
 commission_recipient_id bigint not null,
 commission_mode text not null check(commission_mode in ('percentage','fixed')),
 commission_value bigint not null check(commission_value>0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key(organization_id,client_id),
 foreign key(organization_id,client_id) references agency_clients(organization_id,id) on delete cascade,
 foreign key(organization_id,plan_id) references agency_plans(organization_id,id),
 foreign key(organization_id,commission_recipient_id) references agency_collaborators(organization_id,id),
 check(commission_mode<>'percentage' or commission_value between 1 and 100)
);
-- The earlier commercial lifecycle migration creates this table without
-- starts_on. Preserve its effective-date semantics when upgrading it before
-- creating the forecast index that reads the new column.
alter table agency_client_commercial_terms add column if not exists starts_on date;
update agency_client_commercial_terms set starts_on=effective_from where starts_on is null;
alter table agency_client_commercial_terms alter column starts_on set not null;
create index if not exists agency_client_commercial_terms_forecast_idx on agency_client_commercial_terms(organization_id,currency,starts_on);
-- Reconcile the two commercial-term contracts: when the lifecycle migration
-- created the table first, the create-if-not-exists above never applied its
-- forecast columns. Add them idempotently so forecasting joins both worlds.
alter table agency_client_commercial_terms add column if not exists plan_id bigint;
alter table agency_client_commercial_terms add column if not exists recurring_amount bigint;
alter table agency_client_commercial_terms add column if not exists invoice_required boolean not null default false;
alter table agency_client_commercial_terms add column if not exists commission_recipient_id bigint;
alter table agency_client_commercial_terms add column if not exists commission_mode text;
alter table agency_client_commercial_terms add column if not exists commission_value bigint;
alter table agency_client_commercial_terms add column if not exists updated_at timestamptz not null default now();
-- The terms contract writes a single effective row without lifecycle values.
-- Relax the lifecycle-only required columns so both contracts can write.
alter table agency_client_commercial_terms alter column activation_date drop not null;
alter table agency_client_commercial_terms alter column effective_from drop not null;
alter table agency_client_commercial_terms alter column plan_name drop not null;
alter table agency_client_commercial_terms alter column plan_version drop not null;
alter table agency_client_commercial_terms alter column monthly_price drop not null;
-- Existing lifecycle terms expose their net monthly value through price and
-- discount; project it into recurring_amount so recurring/commission queries
-- include terms created before this reconciliation.
update agency_client_commercial_terms set recurring_amount=round(case when discount_type='percent' then monthly_price*(1-discount_value/100) when discount_type='fixed' then greatest(monthly_price-discount_value,0) else monthly_price end)::bigint where recurring_amount is null;

create table if not exists agency_planned_expenses (
 id bigserial primary key,
 organization_id bigint not null references organizations(id) on delete cascade,
 cadence text not null check(cadence in ('monthly','recurring')),
 effective_month date not null check(effective_month=date_trunc('month',effective_month)::date),
 category text not null check(char_length(trim(category)) between 1 and 120),
 amount bigint not null check(amount>0),
 currency text not null check(currency in ('PYG','USD')),
 note text check(note is null or char_length(note)<=1000),
 created_by_user_id bigint not null references users(id),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create index if not exists agency_planned_expenses_forecast_idx on agency_planned_expenses(organization_id,effective_month,cadence,currency);

do $$ declare t text; begin
 foreach t in array array['agency_client_commercial_terms','agency_planned_expenses'] loop
  execute format('drop trigger if exists operation_audit on %I',t);
  execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
