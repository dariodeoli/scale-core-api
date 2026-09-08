create table if not exists agency_job_catalogs (
 organization_id bigint primary key references organizations(id), initialized_at timestamptz not null default now()
);
create table if not exists agency_job_roles (
 id bigserial primary key, organization_id bigint not null references organizations(id),
 name text not null check(length(trim(name)) between 1 and 120), active boolean not null default true,
 created_at timestamptz not null default now()
);
create unique index if not exists agency_job_roles_name on agency_job_roles(organization_id,lower(name));
create or replace function ensure_agency_job_catalog(org bigint) returns void language sql as $$
 with initialized as (
  insert into agency_job_catalogs(organization_id) values(org) on conflict do nothing returning organization_id
 ) insert into agency_job_roles(organization_id,name)
 select organization_id,title from initialized cross join unnest(array['Editor audiovisual','Diseñador gráfico','Community manager','Ejecutivo de cuentas','Productor','Cámara','Fotógrafo','Redactor','Trafficker','Administración','Comercial','Dirección']) as title
 on conflict do nothing;
$$;
select ensure_agency_job_catalog(id) from organizations;
alter table agency_collaborators add column if not exists job_role_id bigint references agency_job_roles(id);
insert into agency_job_roles(organization_id,name)
 select distinct organization_id,trim(job_title) from agency_collaborators where job_role_id is null and length(trim(job_title))>0
 on conflict do nothing;
update agency_collaborators c set job_role_id=j.id from agency_job_roles j
 where c.job_role_id is null and c.organization_id=j.organization_id and lower(trim(c.job_title))=lower(j.name);
drop trigger if exists operation_audit on agency_job_roles;
create trigger operation_audit after insert or update or delete on agency_job_roles for each row execute function audit_agency_operation();
