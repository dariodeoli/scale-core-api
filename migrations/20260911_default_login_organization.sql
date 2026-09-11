create table if not exists user_login_preferences (
 user_id bigint primary key references users(id) on delete cascade,
 default_organization_id bigint references organizations(id) on delete set null,
 updated_at timestamptz not null default now()
);
-- Only ordinary OAuth handoffs may reselect a login company. Invitations and
-- trial registrations keep their explicit destination, including pending access.
alter table oauth_handoffs add column if not exists normal_login boolean not null default false;
