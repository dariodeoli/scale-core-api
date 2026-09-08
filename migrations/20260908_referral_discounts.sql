create table if not exists agency_referral_discounts (
 id bigserial primary key,organization_id bigint not null references organizations(id),
 invoice_id bigint not null references agency_invoices(id),referrer text not null,
 amount numeric(14,2) not null check(amount>0),reason text not null,
 status text not null default 'applied' check(status in ('applied','reversed')),
 created_by_user_id bigint not null references users(id),created_at timestamptz not null default now()
);
drop trigger if exists operation_audit on agency_referral_discounts;
create trigger operation_audit after insert or update or delete on agency_referral_discounts for each row execute function audit_agency_operation();
-- Serialize incoming payments with invoice discounts and outgoing cash movements.
create or replace function guard_agency_payment_insert() returns trigger language plpgsql as $$
declare i agency_invoices%rowtype; a bank_accounts%rowtype;
begin
 select * into i from agency_invoices where id=new.invoice_id and organization_id=new.organization_id for update;
 if not found or i.status in ('cancelled','draft') or new.amount>i.total-i.paid_amount then raise exception 'Invalid outstanding balance'; end if;
 select * into a from bank_accounts where id=new.account_id and organization_id=new.organization_id and active=true for update;
 if not found or a.currency<>i.currency then raise exception 'Invalid payment account'; end if;
 return new;
end $$;
drop trigger if exists payment_insert_guard on agency_payments;
create trigger payment_insert_guard before insert on agency_payments for each row execute function guard_agency_payment_insert();
create or replace function guard_account_transfer_insert() returns trigger language plpgsql as $$
declare source bank_accounts%rowtype; destination bank_accounts%rowtype;
begin
 perform id from bank_accounts where id in (new.from_account_id,new.to_account_id) order by id for update;
 select * into source from bank_accounts where id=new.from_account_id and organization_id=new.organization_id and active=true;
 if not found or source.balance<new.amount then raise exception 'Insufficient transfer balance'; end if;
 select * into destination from bank_accounts where id=new.to_account_id and organization_id=new.organization_id and active=true;
 if not found or source.currency<>destination.currency then raise exception 'Invalid transfer destination'; end if;
 return new;
end $$;
drop trigger if exists transfer_insert_guard on account_transfers;
create trigger transfer_insert_guard before insert on account_transfers for each row execute function guard_account_transfer_insert();
