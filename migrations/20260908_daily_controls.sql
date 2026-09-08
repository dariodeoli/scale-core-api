-- Additive migrations. Original receipts stay immutable; reversals are separate entries.
alter table account_transfers add column if not exists received_amount numeric(14,2) check(received_amount>0);
alter table account_transfers add column if not exists exchange_rate numeric(20,8) check(exchange_rate>0);
alter table account_transfers add column if not exists request_key text;
alter table agency_payments add column if not exists request_key text;
create unique index if not exists transfers_request_unique on account_transfers(organization_id,request_key) where request_key is not null;
create unique index if not exists payments_request_unique on agency_payments(organization_id,request_key) where request_key is not null;
create table if not exists agency_payment_reversals (
 id bigserial primary key, organization_id bigint not null references organizations(id),
 payment_id bigint not null unique references agency_payments(id), reason text not null,
 reversed_on date not null default current_date, created_by_user_id bigint not null references users(id),
 created_at timestamptz not null default now()
);
create or replace function sync_agency_payment() returns trigger language plpgsql as $$
declare total_paid numeric(14,2); invoice_total numeric(14,2); invoice_key bigint; org bigint;
begin
 invoice_key:=coalesce(new.invoice_id,old.invoice_id);org:=coalesce(new.organization_id,old.organization_id);
 if tg_op='INSERT' then
  update bank_accounts set balance=balance+new.amount,updated_at=now() where id=new.account_id and organization_id=org;
 else raise exception 'Receipts are immutable; register a reversal'; end if;
 select coalesce(sum(p.amount),0) into total_paid from agency_payments p where p.invoice_id=invoice_key and p.organization_id=org and not exists(select 1 from agency_payment_reversals r where r.payment_id=p.id);
 select total into invoice_total from agency_invoices where id=invoice_key;
 update agency_invoices set paid_amount=total_paid,status=case when total_paid>=invoice_total then 'paid' when total_paid>0 then 'partial' else 'issued' end,updated_at=now() where id=invoice_key;
 return new;
end $$;
create or replace function sync_payment_reversal() returns trigger language plpgsql as $$
declare p agency_payments%rowtype; a bank_accounts%rowtype;
begin
 if tg_op<>'INSERT' then raise exception 'Reversals are immutable';end if;
 select * into p from agency_payments where id=new.payment_id and organization_id=new.organization_id for update;
 if not found then raise exception 'Invalid receipt';end if;
 perform id from agency_invoices where id=p.invoice_id for update;
 select * into a from bank_accounts where id=p.account_id and organization_id=p.organization_id for update;
 if a.balance<p.amount then raise exception 'Insufficient balance to reverse receipt';end if;
 update bank_accounts set balance=balance-p.amount,updated_at=now() where id=a.id;
 update agency_invoices set paid_amount=paid_amount-p.amount,status=case when paid_amount-p.amount>=total then 'paid' when paid_amount-p.amount>0 then 'partial' else 'issued' end,updated_at=now() where id=p.invoice_id;
 return new;
end $$;
drop trigger if exists payment_reversal_sync on agency_payment_reversals;
create trigger payment_reversal_sync after insert or update or delete on agency_payment_reversals for each row execute function sync_payment_reversal();
create or replace function guard_account_transfer_insert() returns trigger language plpgsql as $$
declare source bank_accounts%rowtype; destination bank_accounts%rowtype;
begin
 perform id from bank_accounts where id in(new.from_account_id,new.to_account_id) order by id for update;
 select * into source from bank_accounts where id=new.from_account_id and organization_id=new.organization_id and active=true;
 if not found or source.balance<new.amount then raise exception 'Insufficient transfer balance';end if;
 select * into destination from bank_accounts where id=new.to_account_id and organization_id=new.organization_id and active=true;
 if not found then raise exception 'Invalid transfer destination';end if;
 if source.currency=destination.currency then new.received_amount:=new.amount;new.exchange_rate:=1;
 elsif new.received_amount is null or new.received_amount<=0 then raise exception 'Destination amount required';
 else new.exchange_rate:=new.received_amount/new.amount;end if;
 return new;
end $$;
create or replace function sync_account_transfer() returns trigger language plpgsql as $$
begin
 if tg_op<>'INSERT' then raise exception 'Transfers are immutable';end if;
 update bank_accounts set balance=balance-new.amount,updated_at=now() where id=new.from_account_id and organization_id=new.organization_id;
 update bank_accounts set balance=balance+coalesce(new.received_amount,new.amount),updated_at=now() where id=new.to_account_id and organization_id=new.organization_id;
 return new;
end $$;
create table if not exists agency_statement_lines (
 id bigserial primary key,organization_id bigint not null references organizations(id),
 account_id bigint not null references bank_accounts(id),external_id text not null,booked_on date not null,
 amount numeric(14,2) not null check(amount<>0),reference text not null default '',
 created_by_user_id bigint not null references users(id),created_at timestamptz not null default now(),
 unique(account_id,external_id)
);
create table if not exists agency_reconciliation_matches (
 id bigserial primary key,organization_id bigint not null references organizations(id),
 statement_line_id bigint not null unique references agency_statement_lines(id),account_id bigint not null references bank_accounts(id),
 movement_type text not null,movement_id bigint not null,created_by_user_id bigint not null references users(id),
 created_at timestamptz not null default now(),unique(account_id,movement_type,movement_id)
);
create or replace view agency_cash_movements as
 select p.organization_id,p.account_id,'payment'::text as movement_type,p.id as movement_id,p.received_on as booked_on,p.amount,coalesce(p.reference,'') as reference from agency_payments p
 union all select r.organization_id,p.account_id,'reversal',r.id,r.reversed_on,-p.amount,r.reason from agency_payment_reversals r join agency_payments p on p.id=r.payment_id
 union all select t.organization_id,t.from_account_id,'transfer_out',t.id,t.transferred_on,-t.amount,coalesce(t.reference,'') from account_transfers t
 union all select t.organization_id,t.to_account_id,'transfer_in',t.id,t.transferred_on,coalesce(t.received_amount,t.amount),coalesce(t.reference,'') from account_transfers t
 union all select p.organization_id,p.account_id,'payout',p.id,p.paid_on,-p.amount,p.reference from agency_payouts p;
create table if not exists agency_content_reviews (
 id bigserial primary key,organization_id bigint not null references organizations(id),
 work_order_id bigint not null references agency_work_orders(id),token_hash text not null unique,
 title text not null,asset_url text not null,version_stamp text not null,
 status text not null default 'pending' check(status in('pending','approved','changes','revoked')),
 expires_at timestamptz not null,reviewer_name text,feedback text,responded_at timestamptz,
 created_by_user_id bigint not null references users(id),created_at timestamptz not null default now()
);
alter table agency_budgets add column if not exists sections jsonb;
-- Only attribute historical INSERTs when the original record itself captured its author.
update agency_operation_audit set actor=coalesce(after_state->>'created_by_user_id',after_state->>'author_user_id')
 where nullif(actor,'') is null and action='INSERT' and coalesce(after_state->>'created_by_user_id',after_state->>'author_user_id') is not null;
do $$ declare t text;begin
 foreach t in array array['agency_payment_reversals','agency_statement_lines','agency_reconciliation_matches','agency_content_reviews','agency_settings','agency_exchange_rates'] loop
 execute format('drop trigger if exists operation_audit on %I',t);
 execute format('create trigger operation_audit after insert or update or delete on %I for each row execute function audit_agency_operation()',t);
 end loop;
end $$;
