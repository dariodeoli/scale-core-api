alter table oauth_states add column if not exists client_portal_login boolean not null default false;
alter table oauth_states add column if not exists client_portal_invite_id bigint references client_portal_invites(id) on delete cascade;
