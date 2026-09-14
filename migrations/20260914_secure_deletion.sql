-- Reversible tenant retention and account anonymization for destructive actions.
alter table users add column if not exists deleted_at timestamptz;
alter table users add column if not exists anonymized_at timestamptz;

alter table organizations add column if not exists deleted_at timestamptz;
alter table organizations add column if not exists deleted_by_user_id bigint references users(id) on delete restrict;

alter table oauth_states add column if not exists recent_auth_preview_hash text;
alter table oauth_states add column if not exists recent_auth_user_id bigint references users(id) on delete restrict;

create table if not exists destructive_action_previews (
  token_hash text primary key,
  user_id bigint not null references users(id) on delete restrict,
  action text not null check(action in ('account.delete','organization.delete')),
  organization_id bigint references organizations(id) on delete restrict,
  state_hash text not null,
  confirmation text not null,
  payload jsonb not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  check((action='account.delete' and organization_id is null) or (action='organization.delete' and organization_id is not null))
);
create index if not exists destructive_action_previews_user_idx on destructive_action_previews(user_id,expires_at);

create table if not exists destructive_auth_proofs (
  token_hash text primary key,
  preview_token_hash text not null references destructive_action_previews(token_hash) on delete restrict,
  user_id bigint not null references users(id) on delete restrict,
  action text not null check(action in ('account.delete','organization.delete')),
  organization_id bigint references organizations(id) on delete restrict,
  method text not null check(method in ('password','google')),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists destructive_auth_proofs_user_idx on destructive_auth_proofs(user_id,expires_at);

create table if not exists destructive_google_handoffs (
  token_hash text primary key,
  preview_token_hash text not null references destructive_action_previews(token_hash) on delete restrict,
  user_id bigint not null references users(id) on delete restrict,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
