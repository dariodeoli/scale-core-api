-- Platform-operated controls are isolated from agency roles and payment-provider state.
-- They never create a Stripe customer, subscription, checkout, invoice, or charge.
alter table platform_coupons add column if not exists lifetime_eligible boolean not null default false;
alter table platform_audit_log add column if not exists metadata jsonb not null default '{}'::jsonb;

-- A manual state is an explicit operational entitlement override. It is separate
-- from Stripe's observed status and must always identify the platform operator.
create table if not exists platform_subscription_states (
 organization_id bigint primary key references organization_subscriptions(organization_id) on delete cascade,
 state text not null check(state in ('active','suspended')),
 reason text not null check(length(reason) between 3 and 280),
 expires_at timestamptz,
 updated_by_user_id bigint not null references users(id) on delete restrict,
 updated_at timestamptz not null default now()
);
create index if not exists platform_subscription_states_updated_idx on platform_subscription_states(updated_at desc);
