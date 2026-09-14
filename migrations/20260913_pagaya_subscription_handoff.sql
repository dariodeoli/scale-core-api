-- Server-to-server PagaYa enrollment bridge. No trials, subscriptions, or access grants are created by this migration.
alter table organization_subscriptions add column if not exists pagaya_enrollment_id uuid unique;

create table if not exists subscription_pagaya_enrollments (
 id uuid primary key,
 organization_id bigint not null references organization_subscriptions(organization_id),
 user_id bigint not null references users(id),
 plan_code text not null check(plan_code='scale_monthly'),
 currency text not null check(currency in ('USD','PYG')),
 amount_minor integer not null,
 expires_at timestamptz not null,
 pagaya_checkout_session_id text unique,
 stripe_customer_id text unique,
 stripe_subscription_id text unique,
 status text not null default 'prepared' check(status in ('prepared','dispatching','pending','consumed','expired','failed')),
 consumed_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 check((currency='USD' and amount_minor=1000) or (currency='PYG' and amount_minor=50000)),
 check((status='consumed')=(consumed_at is not null))
);
create unique index if not exists subscription_one_open_pagaya_enrollment
 on subscription_pagaya_enrollments(organization_id) where status in ('prepared','dispatching','pending');

create table if not exists subscription_pagaya_callback_events (
 event_id text primary key,
 nonce uuid not null unique,
 enrollment_id uuid not null references subscription_pagaya_enrollments(id),
 received_at timestamptz not null default now(),
 processed_at timestamptz
);
