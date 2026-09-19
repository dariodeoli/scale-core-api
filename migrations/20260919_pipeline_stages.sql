-- Editable pipeline stages per company. Slugs stay stable so historical leads
-- keep their column even when a label, position or active state changes.
create table if not exists agency_pipeline_stages (
 id bigserial primary key,
 organization_id bigint not null references organizations(id),
 slug text not null,
 label text not null,
 position integer not null default 0,
 active boolean not null default true,
 kind text not null default 'open',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(organization_id,slug),
 unique(id,organization_id),
 check(slug ~ '^[a-z0-9][a-z0-9_-]{0,39}$'),
 check(length(trim(label)) between 2 and 60),
 check(position between 0 and 9999),
 check(kind in ('open','won','lost'))
);
create index if not exists agency_pipeline_stages_order
 on agency_pipeline_stages(organization_id,position,id);

-- Seed the stages that shipped fixed in code, one set per existing company.
insert into agency_pipeline_stages(organization_id,slug,label,position,kind)
select o.id,s.slug,s.label,s.position,s.kind
from organizations o
cross join (values
 ('lead','Lead',0,'open'),
 ('contacted','Contactado',1,'open'),
 ('proposal','Propuesta',2,'open'),
 ('negotiation','Negociación',3,'open'),
 ('won','Ganado',4,'won'),
 ('lost','Perdido',5,'lost')
) as s(slug,label,position,kind)
on conflict(organization_id,slug) do nothing;

-- Stages are validated against each company's active rows in the API; legacy
-- leads keep their slug readable even after a stage is deactivated.
alter table agency_leads drop constraint if exists agency_leads_stage_check;
do $$ begin
 if not exists(select 1 from pg_constraint where conname='agency_leads_stage_length') then
  alter table agency_leads add constraint agency_leads_stage_length
   check(length(trim(stage)) between 1 and 40);
 end if;
end $$;

do $$ begin
 if not exists(select 1 from pg_trigger where tgname='operation_audit' and tgrelid='agency_pipeline_stages'::regclass) then
  create trigger operation_audit after insert or update or delete on agency_pipeline_stages
   for each row execute function audit_agency_operation();
 end if;
end $$;
