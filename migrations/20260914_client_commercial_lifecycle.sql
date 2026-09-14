-- Commercial terms are append-only snapshots. A replacement only closes the
-- previous effective term; it never rewrites its price, plan, or deliverables.
create table if not exists agency_client_commercial_terms (
 id bigserial primary key,
 organization_id bigint not null references organizations(id) on delete cascade,
 client_id bigint not null references agency_clients(id) on delete restrict,
 activation_date date not null,
 effective_from date not null,
 effective_until date,
 plan_name text not null,
 plan_version text not null,
 monthly_price numeric(14,2) not null check(monthly_price>=0),
 currency text not null check(currency in ('PYG','USD','EUR','BRL','ARS','MXN')),
 discount_type text not null default 'none' check(discount_type in ('none','percent','fixed')),
 discount_value numeric(14,2) not null default 0 check(discount_value>=0),
 discount_terms text not null default '',
 extras jsonb not null default '[]'::jsonb,
 deliverables jsonb not null default '[]'::jsonb,
 version integer not null default 1 check(version>=1),
 closed_at timestamptz,
 created_at timestamptz not null default now(),
 check(effective_until is null or effective_until>=effective_from),
 check((discount_type='none' and discount_value=0) or (discount_type='percent' and discount_value>0 and discount_value<=100) or (discount_type='fixed' and discount_value>0))
);
create unique index if not exists agency_client_commercial_terms_open_unique on agency_client_commercial_terms(organization_id,client_id) where effective_until is null;
create unique index if not exists agency_client_commercial_terms_effective_idx on agency_client_commercial_terms(organization_id,client_id,effective_from desc);

create or replace function guard_agency_client_commercial_term() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'Commercial terms are immutable' using errcode='23514'; end if;
 if not exists(select 1 from agency_clients c where c.id=new.client_id and c.organization_id=new.organization_id) then
  raise exception 'Commercial term client is outside the organization' using errcode='23514';
 end if;
 if tg_op='UPDATE' then
  if new.organization_id<>old.organization_id or new.client_id<>old.client_id or new.activation_date<>old.activation_date
   or new.effective_from<>old.effective_from or new.plan_name<>old.plan_name or new.plan_version<>old.plan_version
   or new.monthly_price<>old.monthly_price or new.currency<>old.currency or new.discount_type<>old.discount_type
   or new.discount_value<>old.discount_value or new.discount_terms<>old.discount_terms or new.extras<>old.extras
   or new.deliverables<>old.deliverables or old.effective_until is not null or new.effective_until is null
   or new.effective_until<old.effective_from or new.closed_at is null or new.version<>old.version+1 then
   raise exception 'Commercial terms are immutable; create an amendment' using errcode='23514';
  end if;
 end if;
 return new;
end $$;
drop trigger if exists agency_client_commercial_term_guard on agency_client_commercial_terms;
create trigger agency_client_commercial_term_guard before insert or update or delete on agency_client_commercial_terms for each row execute function guard_agency_client_commercial_term();
