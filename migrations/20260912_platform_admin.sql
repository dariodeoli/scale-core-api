-- Global administration is deliberately separate from organization membership.
-- An agency owner never becomes a platform administrator by implication.
create table if not exists platform_administrators (
 user_id bigint primary key references users(id) on delete restrict,
 active boolean not null default true,
 created_at timestamptz not null default now(),
 created_by_user_id bigint references users(id) on delete set null
);

create table if not exists platform_coupons (
 id bigserial primary key,
 code text not null unique check(code ~ '^[A-Z0-9_-]{3,40}$'),
 discount_type text not null check(discount_type in ('percent','fixed')),
 discount_value numeric(12,2) not null check(discount_value > 0),
 currency text check(currency in ('USD','PYG')),
 active boolean not null default true,
 max_redemptions integer check(max_redemptions is null or max_redemptions > 0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 created_by_user_id bigint not null references users(id) on delete restrict,
 check((discount_type='percent' and discount_value<=100 and currency is null) or (discount_type='fixed' and currency is not null))
);

create table if not exists platform_audit_log (
 id bigserial primary key,
 actor_user_id bigint not null references users(id) on delete restrict,
 action text not null check(length(action) between 3 and 80),
 target_type text not null check(length(target_type) between 3 and 80),
 target_id text not null check(length(target_id) between 1 and 120),
 created_at timestamptz not null default now()
);

create index if not exists platform_coupons_active_created on platform_coupons(active,created_at desc);
create index if not exists platform_audit_log_actor_created on platform_audit_log(actor_user_id,created_at desc);
