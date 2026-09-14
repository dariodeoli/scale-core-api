-- Google verifies identity first; company creation happens only after the
-- browser returns to registration and submits the required trial terms.
alter table oauth_states add column if not exists trial_registration boolean not null default false;

create table if not exists pending_trial_registrations (
 token_hash text primary key,
 email_normalized text not null check(email_normalized=lower(trim(email_normalized)) and length(email_normalized) between 3 and 254),
 full_name text,
 picture_url text,
 expires_at timestamptz not null,
 created_at timestamptz not null default now(),
 check(full_name is null or length(full_name)<=120),
 check(picture_url is null or length(picture_url)<=2048)
);
create index if not exists pending_trial_registrations_expiry_idx on pending_trial_registrations(expires_at);
