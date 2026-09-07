create table if not exists users (
  id bigserial primary key,
  email text unique not null,
  password_hash text not null,
  role text not null default 'admin' check (role in ('admin','viewer')),
  created_at timestamptz not null default now()
);
create table if not exists sessions (
  id text primary key,
  user_id bigint not null references users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists sessions_expiry_idx on sessions(expires_at);
create table if not exists events (
  id bigserial primary key,
  name text not null,
  event_date date not null default current_date,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists events_name_date_idx on events(name,event_date);
