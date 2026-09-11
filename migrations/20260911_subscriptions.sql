-- Optional SaaS billing only. No backfill, changes to agency invoices, or access grants.
create table if not exists organization_subscriptions (
 organization_id bigint primary key references organizations(id),
 currency text not null check(currency in ('USD','PYG')),
 trial_started_at timestamptz not null default now(),
 trial_ends_at timestamptz not null default (now()+interval '720 hours'),
 due_at timestamptz not null default (now()+interval '720 hours'),
 paid_through_at timestamptz,
 binding_token uuid not null unique,
 stripe_customer_id text unique,
 stripe_subscription_id text unique,
 stripe_status text,
 updated_at timestamptz not null default now(),
 check(trial_ends_at=trial_started_at+interval '720 hours'),
 check(due_at>=trial_ends_at),
 check(paid_through_at is null or due_at>=paid_through_at)
);
create table if not exists subscription_checkout_attempts (
 id uuid primary key,
 organization_id bigint not null references organization_subscriptions(organization_id),
 parameters jsonb not null,
 created_at timestamptz not null default now(),
 stripe_session_id text unique,
 closed boolean not null default false
);
create unique index if not exists subscription_one_open_checkout on subscription_checkout_attempts(organization_id) where not closed;
create table if not exists subscription_stripe_events (
 event_id text primary key,
 event_type text not null,
 event_created bigint not null,
 organization_id bigint references organization_subscriptions(organization_id),
 processed_at timestamptz not null default now()
);
create table if not exists subscription_paid_invoices (
 invoice_id text primary key,
 organization_id bigint not null references organization_subscriptions(organization_id),
 stripe_subscription_id text not null,
 period_start timestamptz not null,
 period_end timestamptz not null check(period_end>period_start),
 amount_minor integer not null,
 currency text not null check(currency in ('USD','PYG')),
 verified_at timestamptz not null default now(),
 check((currency='USD' and amount_minor=1000) or (currency='PYG' and amount_minor=50000))
);
