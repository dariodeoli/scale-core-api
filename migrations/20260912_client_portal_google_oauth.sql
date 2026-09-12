alter table oauth_states add column if not exists client_portal_login boolean not null default false;
