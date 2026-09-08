alter table bank_accounts add column if not exists institution text;
alter table bank_accounts add column if not exists account_number text;
alter table bank_accounts add column if not exists holder_name text;
alter table bank_accounts add column if not exists custodian_user_id bigint references users(id) on delete set null;

alter table agency_payments add column if not exists received_by_user_id bigint references users(id) on delete set null;

create table if not exists account_transfers (
  id bigserial primary key,
  organization_id bigint not null references organizations(id) on delete cascade,
  from_account_id bigint not null references bank_accounts(id) on delete restrict,
  to_account_id bigint not null references bank_accounts(id) on delete restrict,
  amount numeric(14,2) not null check (amount > 0),
  transferred_on date not null default current_date,
  reference text,
  notes text,
  created_by_user_id bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (from_account_id <> to_account_id)
);
create index if not exists account_transfers_organization_idx on account_transfers(organization_id, transferred_on desc);

create or replace function sync_account_transfer() returns trigger language plpgsql as $$
begin
  if tg_op = 'UPDATE' then
    update bank_accounts set balance=balance+old.amount,updated_at=now() where id=old.from_account_id and organization_id=old.organization_id;
    update bank_accounts set balance=balance-old.amount,updated_at=now() where id=old.to_account_id and organization_id=old.organization_id;
  elsif tg_op = 'DELETE' then
    update bank_accounts set balance=balance+old.amount,updated_at=now() where id=old.from_account_id and organization_id=old.organization_id;
    update bank_accounts set balance=balance-old.amount,updated_at=now() where id=old.to_account_id and organization_id=old.organization_id;
    return old;
  end if;
  update bank_accounts set balance=balance-new.amount,updated_at=now() where id=new.from_account_id and organization_id=new.organization_id;
  update bank_accounts set balance=balance+new.amount,updated_at=now() where id=new.to_account_id and organization_id=new.organization_id;
  return new;
end $$;
drop trigger if exists account_transfers_sync on account_transfers;
create trigger account_transfers_sync after insert or update or delete on account_transfers for each row execute function sync_account_transfer();
