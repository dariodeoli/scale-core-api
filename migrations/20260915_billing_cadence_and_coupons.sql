-- Billing cadence on commercial terms: fixed monthly, every X months, or one-time.
alter table agency_client_commercial_terms add column if not exists cadence text not null default 'monthly';
alter table agency_client_commercial_terms add column if not exists interval_months integer not null default 1;
alter table agency_client_commercial_terms drop constraint if exists agency_client_commercial_terms_cadence_check;
alter table agency_client_commercial_terms add constraint agency_client_commercial_terms_cadence_check check(cadence in ('monthly','interval','once'));
alter table agency_client_commercial_terms drop constraint if exists agency_client_commercial_terms_interval_months_check;
alter table agency_client_commercial_terms add constraint agency_client_commercial_terms_interval_months_check check(interval_months between 1 and 24);

-- Coupon redemptions: a code grants one free month to a single organization once.
-- Guarded: focused test suites may load the treasury/cadence subset without the
-- platform-admin migration that creates platform_coupons.
do $$ begin
 if to_regclass('public.platform_coupons') is not null then
  create table if not exists platform_coupon_redemptions (
   id bigserial primary key,
   coupon_id bigint not null references platform_coupons(id) on delete restrict,
   organization_id bigint not null references organizations(id) on delete cascade,
   months_granted integer not null default 1 check(months_granted between 1 and 12),
   redeemed_by_user_id bigint not null references users(id) on delete restrict,
   created_at timestamptz not null default now(),
   unique(coupon_id,organization_id)
  );
  create index if not exists platform_coupon_redemptions_org_idx on platform_coupon_redemptions(organization_id,created_at desc);
 end if;
end $$;
