-- Local credentials are verified separately from Google OAuth.  Tokens are
-- stored only as SHA-256 digests, so a database read cannot be used as a link.
alter table users add column if not exists email_verified_at timestamptz;

-- Preserve access for pre-existing, password-based members during this
-- migration. New local accounts never receive this backfill because they have
-- no membership until they finish the verified flow below.
update users u set email_verified_at=coalesce(u.email_verified_at,u.created_at)
where u.email_verified_at is null
  and u.password_hash not like '!%'
  and exists (
    select 1 from organization_members m
    where m.user_id=u.id and m.active=true and m.removed_at is null
  );

create table if not exists auth_email_verifications (
  id bigserial primary key,
  user_id bigint not null references users(id) on delete cascade,
  purpose text not null check (purpose in ('trial','invite')),
  token_hash text not null unique,
  invite_link_id bigint references agency_invite_links(id) on delete cascade,
  payload jsonb not null default '{}'::jsonb,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  used_at timestamptz,
  check ((purpose='invite') = (invite_link_id is not null))
);
create index if not exists auth_email_verifications_user_idx on auth_email_verifications(user_id,purpose,expires_at desc);
