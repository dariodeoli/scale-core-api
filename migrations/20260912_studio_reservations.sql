-- Studio bookings are deliberately independent from inventory reservations.
-- A booking may refer to a project, but it never checks out equipment or
-- changes any inventory availability/location record.
create table if not exists agency_studio_spaces (
 id bigserial primary key,
 organization_id bigint not null references organizations(id),
 name text not null check(length(trim(name)) between 2 and 120),
 scenario text not null default '' check(length(trim(scenario)) <= 120),
 notes text not null default '' check(length(notes) <= 2000),
 active boolean not null default true,
 created_by_user_id bigint not null,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(id,organization_id),
 foreign key(organization_id,created_by_user_id) references organization_members(organization_id,user_id)
);
create unique index if not exists studio_space_name_key on agency_studio_spaces(organization_id,lower(trim(name)));
-- The composite relation prevents a reservation from pointing to a project in
-- another organization. The original project primary key is global, but a
-- composite unique index is required by PostgreSQL for this tenant FK.
create unique index if not exists studio_project_tenant_key on agency_projects(id,organization_id);

create table if not exists agency_studio_reservations (
 id bigserial primary key,
 organization_id bigint not null references organizations(id),
 space_id bigint not null,
 project_id bigint,
 title text not null check(length(trim(title)) between 2 and 160),
 production_type text not null check(production_type in ('video','podcast','ads','fotografia','streaming','otro')),
 starts_at timestamptz not null,
 ends_at timestamptz not null check(ends_at > starts_at),
 status text not null default 'reserved' check(status in ('reserved','cancelled')),
 notes text not null default '' check(length(notes) <= 2000),
 created_by_user_id bigint not null,
 cancelled_at timestamptz,
 cancelled_by_user_id bigint references users(id),
 version integer not null default 0,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(id,organization_id),
 foreign key(space_id,organization_id) references agency_studio_spaces(id,organization_id),
 foreign key(project_id,organization_id) references agency_projects(id,organization_id),
 foreign key(organization_id,created_by_user_id) references organization_members(organization_id,user_id),
 -- Half-open ranges allow a session to start exactly when the prior one ends.
 constraint studio_space_no_overlapping_reservations exclude using gist
  (int8range(space_id,space_id,'[]') with &&,tstzrange(starts_at,ends_at,'[)') with &&)
  where(status='reserved')
);
create index if not exists studio_reservation_calendar on agency_studio_reservations(organization_id,starts_at,ends_at);

create table if not exists agency_studio_reservation_members (
 organization_id bigint not null,
 reservation_id bigint not null,
 user_id bigint not null,
 primary key(reservation_id,user_id),
 foreign key(reservation_id,organization_id) references agency_studio_reservations(id,organization_id),
 foreign key(organization_id,user_id) references organization_members(organization_id,user_id)
);

create or replace function studio_reservation_schedule() returns trigger language plpgsql as $$
begin
 if old.status <> new.status and not(old.status='reserved' and new.status='cancelled') then
  raise exception 'Invalid studio reservation transition' using errcode='23514';
 end if;
 if old.status <> 'reserved' and (new.space_id <> old.space_id or new.project_id is distinct from old.project_id or new.starts_at <> old.starts_at or new.ends_at <> old.ends_at) then
  raise exception 'Only active studio reservations can be rescheduled' using errcode='23514';
 end if;
 return new;
end $$;
drop trigger if exists studio_reservation_schedule on agency_studio_reservations;
create trigger studio_reservation_schedule before update on agency_studio_reservations for each row execute function studio_reservation_schedule();

do $$ declare t text; begin
 foreach t in array array['agency_studio_spaces','agency_studio_reservations','agency_studio_reservation_members'] loop
  execute format('drop trigger if exists operation_audit on %I',t);
  execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
