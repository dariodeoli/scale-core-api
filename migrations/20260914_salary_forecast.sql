alter table agency_collaborators add column if not exists monthly_salary_amount bigint;
alter table agency_collaborators add column if not exists monthly_salary_currency text;
alter table agency_collaborators drop constraint if exists agency_collaborators_monthly_salary_check;
alter table agency_collaborators add constraint agency_collaborators_monthly_salary_check check (
 (monthly_salary_amount is null and monthly_salary_currency is null)
 or (monthly_salary_amount is not null and monthly_salary_amount >= 0 and monthly_salary_currency in ('PYG','USD'))
);
create unique index if not exists agency_collaborators_id_organization_idx on agency_collaborators(id,organization_id);

create table if not exists agency_salary_month_overrides (
 organization_id bigint not null references organizations(id) on delete cascade,
 collaborator_id bigint not null,
 month date not null check (month=date_trunc('month',month)::date),
 amount bigint not null check (amount>=0),
 note text,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 primary key (organization_id,collaborator_id,month),
 foreign key (collaborator_id,organization_id) references agency_collaborators(id,organization_id) on delete cascade,
 check (note is null or char_length(note)<=1000)
);
create index if not exists agency_salary_month_overrides_month_idx on agency_salary_month_overrides(organization_id,month);
