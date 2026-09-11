-- Explicit Google-verified onboarding only. Existing memberships are untouched.
alter table oauth_states add column if not exists trial_company text;
alter table oauth_states add column if not exists trial_currency text check(trial_currency in ('USD','PYG'));
alter table oauth_handoffs add column if not exists trial_registration boolean not null default false;
create table if not exists os_trial_registrations (
 user_id bigint primary key references users(id),
 organization_id bigint unique not null references organizations(id),
 consent_version text not null,
 created_at timestamptz not null default now()
);
