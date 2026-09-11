-- Reporting begins at observation, never at a legacy client's created_at.
alter table agency_clients add column if not exists customer_kind text not null default 'unknown'
 check(customer_kind in ('unknown','company','professional','individual','other'));
alter table agency_clients add column if not exists service_plan_id bigint;
alter table agency_clients add column if not exists relationship_started_on date;
alter table agency_clients add column if not exists reporting_version bigint not null default 1;
create unique index if not exists agency_plans_reporting_tenant_id on agency_plans(organization_id,id);
create unique index if not exists agency_clients_reporting_tenant_id on agency_clients(organization_id,id);
do $$ begin
 if not exists(select 1 from pg_constraint where conname='agency_clients_reporting_plan_fk') then
  alter table agency_clients add constraint agency_clients_reporting_plan_fk foreign key(organization_id,service_plan_id) references agency_plans(organization_id,id);
 end if;
end $$;

create table if not exists agency_reporting_coverage (
 organization_id bigint primary key references organizations(id),history_since timestamptz not null default now()
);
create table if not exists agency_client_reporting_events (
 id bigserial primary key,organization_id bigint not null references organizations(id),client_id bigint not null,
 event_at timestamptz not null default clock_timestamp(),recorded_at timestamptz not null default clock_timestamp(),
 event_kind text not null check(event_kind in ('observed','created','changed','archived','restored')),
 active boolean not null,lifecycle_status text not null check(lifecycle_status in ('active','paused','cancelled','expired','inactive')),
 archived boolean not null,customer_kind text not null check(customer_kind in ('unknown','company','professional','individual','other')),
 service_plan_id bigint,service_plan_name text,relationship_started_on date,
 foreign key(organization_id,client_id) references agency_clients(organization_id,id),
 check((service_plan_id is null)=(service_plan_name is null))
);
create index if not exists agency_reporting_events_timeline on agency_client_reporting_events(organization_id,client_id,event_at desc,id desc);
create index if not exists agency_reporting_events_month on agency_client_reporting_events(organization_id,event_at);

insert into agency_reporting_coverage(organization_id) select id from organizations on conflict do nothing;
insert into agency_client_reporting_events(organization_id,client_id,event_at,event_kind,active,lifecycle_status,archived,customer_kind,service_plan_id,service_plan_name,relationship_started_on)
 select c.organization_id,c.id,now(),'observed',c.active,c.lifecycle_status,
 exists(select 1 from agency_archived_records a where a.organization_id=c.organization_id and a.kind='clients' and a.record_id=c.id),
 c.customer_kind,c.service_plan_id,p.name,c.relationship_started_on
 from agency_clients c left join agency_plans p on p.organization_id=c.organization_id and p.id=c.service_plan_id
 where c.organization_id is not null and not exists(select 1 from agency_client_reporting_events e where e.organization_id=c.organization_id and e.client_id=c.id);

create or replace function agency_reporting_org_created() returns trigger language plpgsql as $$ begin
 insert into agency_reporting_coverage(organization_id) values(new.id) on conflict do nothing;return new;
end $$;
drop trigger if exists agency_reporting_org_created on organizations;
create trigger agency_reporting_org_created after insert on organizations for each row execute function agency_reporting_org_created();

create or replace function agency_reporting_client_guard() returns trigger language plpgsql as $$ begin
 if tg_op='INSERT' then
  new.relationship_started_on:=coalesce(new.relationship_started_on,(clock_timestamp() at time zone 'America/Asuncion')::date);
 else
  if new.organization_id is distinct from old.organization_id then raise exception 'Reporting clients cannot change tenant';end if;
  new.reporting_version:=old.reporting_version+1;
 end if;
 if new.relationship_started_on>(clock_timestamp() at time zone 'America/Asuncion')::date then raise exception 'Relationship start cannot be in the future';end if;
 return new;
end $$;
drop trigger if exists agency_reporting_client_guard on agency_clients;
create trigger agency_reporting_client_guard before insert or update on agency_clients for each row execute function agency_reporting_client_guard();

create or replace function agency_reporting_client_snapshot() returns trigger language plpgsql as $$ begin
 if tg_op='UPDATE' and row(new.active,new.lifecycle_status,new.customer_kind,new.service_plan_id,new.relationship_started_on)
  is not distinct from row(old.active,old.lifecycle_status,old.customer_kind,old.service_plan_id,old.relationship_started_on) then return new;end if;
 insert into agency_client_reporting_events(organization_id,client_id,event_kind,active,lifecycle_status,archived,customer_kind,service_plan_id,service_plan_name,relationship_started_on)
 select new.organization_id,new.id,case when tg_op='INSERT' then 'created' else 'changed' end,new.active,new.lifecycle_status,
 exists(select 1 from agency_archived_records a where a.organization_id=new.organization_id and a.kind='clients' and a.record_id=new.id),
 new.customer_kind,new.service_plan_id,p.name,new.relationship_started_on
 from (select 1) x left join agency_plans p on p.organization_id=new.organization_id and p.id=new.service_plan_id;
 return new;
end $$;
drop trigger if exists agency_reporting_client_snapshot on agency_clients;
create trigger agency_reporting_client_snapshot after insert or update on agency_clients for each row execute function agency_reporting_client_snapshot();

create or replace function agency_reporting_archive_snapshot() returns trigger language plpgsql as $$
declare org bigint;key bigint;kind text;c agency_clients%rowtype;
begin
 if tg_op='DELETE' then org:=old.organization_id;key:=old.record_id;kind:=old.kind;
 else org:=new.organization_id;key:=new.record_id;kind:=new.kind;end if;
 if kind<>'clients' then return null;end if;
 if tg_op='UPDATE' then
  if row(new.organization_id,new.record_id,new.kind) is distinct from row(old.organization_id,old.record_id,old.kind) then raise exception 'Archive identity is immutable';end if;
  return null;
 end if;
 select * into c from agency_clients where organization_id=org and id=key for update;
 if not found then raise exception 'Invalid archived reporting client';end if;
 update agency_clients set updated_at=clock_timestamp() where organization_id=org and id=key;
 insert into agency_client_reporting_events(organization_id,client_id,event_kind,active,lifecycle_status,archived,customer_kind,service_plan_id,service_plan_name,relationship_started_on)
 select org,key,case when tg_op='DELETE' then 'restored' else 'archived' end,c.active,c.lifecycle_status,tg_op<>'DELETE',
 c.customer_kind,c.service_plan_id,p.name,c.relationship_started_on
 from (select 1) x left join agency_plans p on p.organization_id=org and p.id=c.service_plan_id;
 return null;
end $$;
drop trigger if exists agency_reporting_archive_snapshot on agency_archived_records;
create trigger agency_reporting_archive_snapshot after insert or update or delete on agency_archived_records for each row execute function agency_reporting_archive_snapshot();

create or replace function agency_reporting_events_immutable() returns trigger language plpgsql as $$ begin
 raise exception 'Client reporting events are append-only';
end $$;
drop trigger if exists agency_reporting_events_immutable on agency_client_reporting_events;
create trigger agency_reporting_events_immutable before update or delete on agency_client_reporting_events for each row execute function agency_reporting_events_immutable();
