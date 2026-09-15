-- Commercial terms: commission is optional. A contract can exist without a
-- commission (mode 'none', no recipient and no value), so plan and recurring
-- amount alone are enough to project contracted income.
alter table agency_client_commercial_terms alter column commission_recipient_id drop not null;
alter table agency_client_commercial_terms alter column commission_value drop not null;
alter table agency_client_commercial_terms drop constraint if exists agency_client_commercial_terms_commission_mode_check;
alter table agency_client_commercial_terms drop constraint if exists agency_client_commercial_terms_commission_value_check;
alter table agency_client_commercial_terms drop constraint if exists agency_client_commercial_terms_commission_terms_check;
alter table agency_client_commercial_terms add constraint agency_client_commercial_terms_commission_mode_check check(commission_mode in ('percentage','fixed','none'));
alter table agency_client_commercial_terms add constraint agency_client_commercial_terms_commission_terms_check check(
 (commission_mode='none' and commission_recipient_id is null and commission_value is null)
 or (commission_mode<>'none' and commission_recipient_id is not null and commission_value>0 and (commission_mode<>'percentage' or commission_value between 1 and 100))
);
-- The lifecycle guard kept any open-row UPDATE from the terms contract out, so
-- a second edit of the same client's terms failed. Open-row edits (identity and
-- lifecycle fields unchanged, no version bump) now belong to the terms
-- contract; closing updates keep the strict amendment rules.
create or replace function guard_agency_client_commercial_term() returns trigger language plpgsql as $$
begin
 if tg_op='DELETE' then raise exception 'Commercial terms are immutable' using errcode='23514'; end if;
 if not exists(select 1 from agency_clients c where c.id=new.client_id and c.organization_id=new.organization_id) then
  raise exception 'Commercial term client is outside the organization' using errcode='23514';
 end if;
 if tg_op='UPDATE' then
  if old.effective_until is not null then
   raise exception 'Commercial terms are immutable; create an amendment' using errcode='23514';
  end if;
  if new.effective_until is null then
   if new.organization_id<>old.organization_id or new.client_id<>old.client_id
    or new.activation_date<>old.activation_date or new.effective_from<>old.effective_from
    or new.plan_name<>old.plan_name or new.plan_version<>old.plan_version
    or new.monthly_price<>old.monthly_price or new.discount_type<>old.discount_type
    or new.discount_value<>old.discount_value or new.discount_terms<>old.discount_terms
    or new.extras<>old.extras or new.deliverables<>old.deliverables
    or new.version<>old.version then
    raise exception 'Commercial terms are immutable; create an amendment' using errcode='23514';
   end if;
  else
   if new.organization_id<>old.organization_id or new.client_id<>old.client_id or new.activation_date<>old.activation_date
    or new.effective_from<>old.effective_from or new.plan_name<>old.plan_name or new.plan_version<>old.plan_version
    or new.monthly_price<>old.monthly_price or new.currency<>old.currency or new.discount_type<>old.discount_type
    or new.discount_value<>old.discount_value or new.discount_terms<>old.discount_terms or new.extras<>old.extras
    or new.deliverables<>old.deliverables or new.effective_until<old.effective_from or new.closed_at is null
    or new.version<>old.version+1 then
    raise exception 'Commercial terms are immutable; create an amendment' using errcode='23514';
   end if;
  end if;
 end if;
 return new;
end $$;

