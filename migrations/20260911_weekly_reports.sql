-- Personal declarations, never inferred from assignments or presence.
create table if not exists agency_weekly_reports (
 organization_id bigint not null references organizations(id),
 user_id bigint not null references users(id),
 week_start date not null check(extract(isodow from week_start)=1),
 metrics jsonb not null,
 notes text not null default '' check(length(notes)<=3000),
 version integer not null default 1 check(version>0),
 updated_at timestamptz not null default now(),
 primary key(organization_id,user_id,week_start)
);
