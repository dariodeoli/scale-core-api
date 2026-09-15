-- Real expenses debit accounts. Original expenses stay immutable; reversals are separate entries.
create table if not exists agency_expenses (
 id bigserial primary key,
 organization_id bigint not null references organizations(id) on delete cascade,
 account_id bigint not null references bank_accounts(id) on delete restrict,
 category text not null,
 kind text,
 amount bigint not null check(amount>0),
 currency text not null,
 paid_on date not null default current_date,
 reference text not null default '',
 created_by_user_id bigint references users(id),
 created_at timestamptz not null default now()
);
create index if not exists agency_expenses_month_idx on agency_expenses(organization_id,paid_on);
create table if not exists agency_expense_reversals (
 id bigserial primary key, organization_id bigint not null references organizations(id),
 expense_id bigint not null unique references agency_expenses(id), reason text not null,
 reversed_on date not null default current_date, created_by_user_id bigint not null references users(id),
 created_at timestamptz not null default now()
);
create or replace function sync_agency_expense() returns trigger language plpgsql as $$
declare a bank_accounts%rowtype;
begin
 if tg_op<>'INSERT' then raise exception 'Expenses are immutable; register a reversal'; end if;
 select * into a from bank_accounts where id=new.account_id and organization_id=new.organization_id and active=true for update;
 if not found then raise exception 'Invalid expense account'; end if;
 if a.currency<>new.currency then raise exception 'Account currency mismatch'; end if;
 if a.balance<new.amount then raise exception 'Insufficient balance'; end if;
 update bank_accounts set balance=balance-new.amount,updated_at=now() where id=a.id;
 return new;
end $$;
create or replace function sync_expense_reversal() returns trigger language plpgsql as $$
declare e agency_expenses%rowtype; a bank_accounts%rowtype;
begin
 if tg_op<>'INSERT' then raise exception 'Reversals are immutable'; end if;
 select * into e from agency_expenses where id=new.expense_id and organization_id=new.organization_id for update;
 if not found then raise exception 'Invalid expense'; end if;
 select * into a from bank_accounts where id=e.account_id and organization_id=e.organization_id for update;
 if not found then raise exception 'Invalid expense account'; end if;
 update bank_accounts set balance=balance+e.amount,updated_at=now() where id=a.id;
 return new;
end $$;
create or replace view agency_cash_movements as
 select p.organization_id,p.account_id,'payment'::text as movement_type,p.id as movement_id,p.received_on as booked_on,p.amount,coalesce(p.reference,'') as reference from agency_payments p
 union all select r.organization_id,p.account_id,'reversal',r.id,r.reversed_on,-p.amount,r.reason from agency_payment_reversals r join agency_payments p on p.id=r.payment_id
 union all select t.organization_id,t.from_account_id,'transfer_out',t.id,t.transferred_on,-t.amount,coalesce(t.reference,'') from account_transfers t
 union all select t.organization_id,t.to_account_id,'transfer_in',t.id,t.transferred_on,coalesce(t.received_amount,t.amount),coalesce(t.reference,'') from account_transfers t
 union all select p.organization_id,p.account_id,'payout',p.id,p.paid_on,-p.amount,p.reference from agency_payouts p
 union all select e.organization_id,e.account_id,'expense',e.id,e.paid_on,-e.amount,e.reference from agency_expenses e
 union all select r.organization_id,e.account_id,'expense_reversal',r.id,r.reversed_on,e.amount,r.reason from agency_expense_reversals r join agency_expenses e on e.id=r.expense_id;
drop trigger if exists agency_expense_sync on agency_expenses;
create trigger agency_expense_sync after insert or update or delete on agency_expenses for each row execute function sync_agency_expense();
drop trigger if exists expense_reversal_sync on agency_expense_reversals;
create trigger expense_reversal_sync after insert or update or delete on agency_expense_reversals for each row execute function sync_expense_reversal();
do $$ declare t text;begin
 foreach t in array array['agency_expenses','agency_expense_reversals'] loop
  execute format('drop trigger if exists operation_audit on %I',t);
  execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
  end loop;
end $$;
