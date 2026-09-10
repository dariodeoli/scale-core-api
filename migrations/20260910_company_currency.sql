-- Only the preference changes. Existing monetary records retain their currency.
alter table agency_settings add column if not exists default_currency text not null default 'PYG'
 check (default_currency in ('PYG','USD','EUR','BRL','ARS','MXN'));
create index if not exists agency_invoices_forecast_month_idx on agency_invoices(organization_id,issued_on);
create index if not exists agency_invoices_forecast_budget_idx on agency_invoices(organization_id,budget_id) where budget_id is not null;
create index if not exists agency_budgets_forecast_month_idx on agency_budgets(organization_id,accepted_at) where status='accepted';
