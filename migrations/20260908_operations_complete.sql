alter table agency_collaborators add column if not exists currency text not null default 'PYG' check(currency in ('PYG','USD'));
alter table agency_collaborators add column if not exists ended_on date;
alter table agency_commissions add column if not exists basis text not null default 'fixed' check(basis in ('fixed','invoiced','collected'));
alter table agency_commissions add column if not exists base_amount numeric(14,2);
create table if not exists agency_payouts (
 id bigserial primary key, organization_id bigint not null references organizations(id),
 collaborator_id bigint references agency_collaborators(id), commission_id bigint unique references agency_commissions(id),
 account_id bigint not null references bank_accounts(id), amount numeric(14,2) not null check(amount>0),
 paid_on date not null, reference text not null, created_by_user_id bigint not null references users(id),
 created_at timestamptz not null default now(), check(collaborator_id is not null or commission_id is not null)
);
create table if not exists agency_operation_audit (
 id bigserial primary key, organization_id bigint, table_name text not null, action text not null,
 actor text, ip text, before_state jsonb, after_state jsonb, created_at timestamptz not null default now()
);
create or replace function audit_agency_operation() returns trigger language plpgsql as $$
begin
 insert into agency_operation_audit(organization_id,table_name,action,actor,ip,before_state,after_state)
 values(coalesce(new.organization_id,old.organization_id),tg_table_name,tg_op,current_setting('app.current_user',true),current_setting('app.current_ip',true),to_jsonb(old),to_jsonb(new));
 return coalesce(new,old);
end $$;
do $$ declare t text; begin
 foreach t in array array['agency_collaborators','agency_commissions','agency_project_comments','agency_payouts'] loop
 execute format('drop trigger if exists operation_audit on %I',t);
 execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
create table if not exists oauth_handoffs (
 token_hash text primary key,user_id bigint not null references users(id),organization_id bigint not null references organizations(id),
 expires_at timestamptz not null
);
