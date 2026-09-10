alter table agency_clients add column if not exists social_links jsonb not null default '{}'::jsonb check(jsonb_typeof(social_links)='object');
