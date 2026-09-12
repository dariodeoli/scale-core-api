create table if not exists account_closure_requests (
  user_id bigint primary key references users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  recoverable_until timestamptz not null,
  cancelled_at timestamptz
);
create index if not exists account_closure_requests_recovery_idx on account_closure_requests(recoverable_until) where cancelled_at is null;
