-- The first platform administrator is a deliberate, one-time bootstrap. The
-- configured email is never stored here: the audit only records the account
-- that was granted access after it already existed and had verified access.
create table if not exists platform_bootstrap_audit_log (
 id bigserial primary key,
 target_user_id bigint not null references users(id) on delete restrict,
 action text not null check(action='initial_admin_granted'),
 created_at timestamptz not null default now(),
 unique(target_user_id,action)
);

create index if not exists platform_bootstrap_audit_log_created_idx on platform_bootstrap_audit_log(created_at desc);
