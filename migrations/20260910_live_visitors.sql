-- Anonymous, ephemeral presence only. No identity, IP, user agent or browsing history.
create table if not exists live_visitor_sites (
 site_key text primary key,
 organization_id bigint not null references organizations(id) on delete cascade,
 label text not null,
 origins text[] not null,
 request_hosts text[] not null,
 enabled boolean not null default true,
 rate_started_at timestamptz not null default now(),
 rate_count integer not null default 0 check(rate_count >= 0)
);
insert into live_visitor_sites(site_key,organization_id,label,origins,request_hosts)
select 'scale-website',id,'Web de Scale',array['https://scaleparaguay.com','https://www.scaleparaguay.com'],array['admin.scaleparaguay.com']
from organizations where slug='scale' and active and demo_owner_user_id is null
on conflict(site_key) do nothing;
insert into live_visitor_sites(site_key,organization_id,label,origins,request_hosts)
select 'scale-os-landing',id,'Landing de Scale OS',array['https://sistema.scaleparaguay.com'],array['admin.scaleparaguay.com','sistema.scaleparaguay.com']
from organizations where slug='scale' and active and demo_owner_user_id is null
on conflict(site_key) do nothing;

create table if not exists live_visitor_sessions (
 site_key text not null references live_visitor_sites(site_key) on delete cascade,
 session_id uuid not null,
 first_seen_at timestamptz not null default now(),
 last_seen_at timestamptz not null default now(),
 expires_at timestamptz not null default now()+interval '90 seconds',
 primary key(site_key,session_id)
);
create index if not exists live_visitor_sessions_expiry on live_visitor_sessions(expires_at);
