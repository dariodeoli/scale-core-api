-- Email codes are isolated from enrollment verification: each code is tied to
-- one authenticated user and one destructive-action preview.
alter table destructive_auth_proofs drop constraint if exists destructive_auth_proofs_method_check;
alter table destructive_auth_proofs add constraint destructive_auth_proofs_method_check check(method in ('password','google','email'));

create table if not exists destructive_email_challenges (
  id bigserial primary key,
  code_hash text not null,
  preview_token_hash text not null references destructive_action_previews(token_hash) on delete restrict,
  user_id bigint not null references users(id) on delete restrict,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists destructive_email_challenges_preview_idx on destructive_email_challenges(preview_token_hash,user_id,expires_at);
