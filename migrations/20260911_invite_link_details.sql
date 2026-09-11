alter table agency_invite_links add column if not exists token_ciphertext text;
alter table organization_members add column if not exists invite_link_id bigint references agency_invite_links(id);
