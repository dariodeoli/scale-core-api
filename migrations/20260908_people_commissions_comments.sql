create table if not exists agency_collaborators (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  user_id bigint references users(id) on delete set null,
  full_name text not null,
  email text,
  photo_url text,
  job_title text,
  compensation_type text not null default 'fixed' check (compensation_type in ('fixed','variable','hourly','per_project')),
  compensation_amount numeric(14,2) not null default 0,
  invoices_company boolean not null default false,
  started_on date,
  payment_day smallint check (payment_day between 1 and 31),
  active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists agency_collaborators_org_idx on agency_collaborators(organization_id,active);
create table if not exists agency_commissions (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  invoice_id bigint references agency_invoices(id) on delete set null,
  collaborator_id bigint references agency_collaborators(id) on delete set null,
  kind text not null check (kind in ('sales','referral')),
  beneficiary_name text not null,
  percentage numeric(5,2), amount numeric(14,2) not null,
  currency text not null default 'PYG' check (currency in ('PYG','USD')),
  status text not null default 'pending' check (status in ('pending','approved','paid','cancelled')),
  due_on date, paid_on date, notes text, created_at timestamptz not null default now()
);
create index if not exists agency_commissions_org_idx on agency_commissions(organization_id,status,due_on);
create table if not exists agency_project_comments (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  project_id bigint not null references agency_projects(id) on delete cascade,
  author_user_id bigint references users(id) on delete set null,
  body text not null check (char_length(trim(body)) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists agency_project_comments_project_idx on agency_project_comments(project_id,created_at desc);
