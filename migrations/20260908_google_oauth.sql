create table if not exists oauth_states (
  state text primary key,
  organization_slug text not null,
  redirect_uri text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists oauth_states_expiry_idx on oauth_states(expires_at);
