create or replace view client_payment_status as
select
  c.organization_id,
  c.id as client_id,
  c.name as client_name,
  i.currency,
  coalesce(sum(case when i.status in ('issued','partial','overdue') then i.total - i.paid_amount else 0 end), 0) as outstanding_amount,
  min(i.due_on) filter (where i.status in ('issued','partial','overdue') and i.due_on is not null) as next_due_on,
  greatest(0, coalesce(current_date - min(i.due_on) filter (where i.status in ('issued','partial','overdue') and i.due_on is not null), 0))::int as days_overdue,
  case
    when min(i.due_on) filter (where i.status in ('issued','partial','overdue') and i.due_on is not null) < current_date - 30 then 'severe'
    when min(i.due_on) filter (where i.status in ('issued','partial','overdue') and i.due_on is not null) < current_date then 'late'
    when min(i.due_on) filter (where i.status in ('issued','partial','overdue') and i.due_on is not null) <= current_date + 7 then 'due_soon'
    else 'up_to_date'
  end as payment_status
from agency_clients c
left join agency_invoices i on i.client_id = c.id and i.organization_id = c.organization_id
group by c.organization_id, c.id, c.name, i.currency;
