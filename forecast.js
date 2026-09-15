import {visibleRecord} from './record-lifecycle.js';
import {roleCan} from './permissions.js';

export const forecastRoles = ['owner','admin','finance'];
export const forecastTimezone = 'America/Asuncion';
const fail = (message,status=400) => { throw Object.assign(new Error(message),{status}); };

// Also used by creation routes: the caller must pass its authenticated tenant.
export async function companyCurrency(db,organizationId) {
 const row=(await db.query('select default_currency from agency_settings where organization_id=$1',[organizationId])).rows[0];
 return row?.default_currency || 'PYG';
}

export function forecastMonth(value,now=new Date()) {
 if(value===null||value===undefined) {
  const parts=new Intl.DateTimeFormat('en-US',{timeZone:forecastTimezone,year:'numeric',month:'2-digit'}).formatToParts(now);
  value=`${parts.find(p=>p.type==='year').value}-${parts.find(p=>p.type==='month').value}`;
 }
 if(typeof value!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)||Number(value.slice(0,4))<1900||Number(value.slice(0,4))>9998)fail('Elegí un mes válido (AAAA-MM)');
 return value;
}

// Monetary source columns are numeric and can contain legacy fractional values.
// The public API is whole-money only, so project values after calculating them
// without changing the stored historical transaction.
export function wholeMoney(value) {
 const match=String(value).match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
 if(!match)throw new Error('No se pudo proyectar un importe entero seguro');
 let amount=BigInt(match[2]);
 if(match[3]?.[0]>='5')amount+=1n;
 if(match[1]==='-')amount=-amount;
 if(amount>BigInt(Number.MAX_SAFE_INTEGER)||amount<BigInt(Number.MIN_SAFE_INTEGER))throw new Error('El importe supera el rango entero seguro');
 return Number(amount);
}

const projectMoney=(record,fields)=>Object.fromEntries(Object.entries(record).map(([key,value])=>[key,fields.includes(key)?wholeMoney(value):value]));

export async function financialForecast({req,res,url,db,session,send}) {
 if(url.pathname!=='/api/agency/forecast')return false;
 try {
  const user=await session(req);
  if(!user)fail('No autenticado',401);
  if(!roleCan(user,'finance.view'))fail('Tu rol no permite ver saldos',403);
  if(req.method!=='GET')fail('Método no permitido',405);
  const month=forecastMonth(url.searchParams.get('month'));
  // A single database snapshot and numeric sums avoid races and float rounding.
  // Any linked invoice suppresses the quote, including draft/cancelled invoices:
  // cancelling an invoice must not silently revive its quote as expected billing.
  const {rows}=await db.query(`
   with bounds as (select $2::date as start_on,($2::date+interval '1 month')::date as end_on),
   pending as (
    select b.currency,b.total,(b.accepted_at at time zone $3)::date as accepted_on
    from agency_budgets b
    where b.organization_id=$1 and b.status='accepted' and ${visibleRecord('b','budgets')}
     and not exists(select 1 from agency_invoices i where i.organization_id=b.organization_id and i.budget_id=b.id)
   ), entries as (
    select i.currency,i.total as issued,0::numeric as pending,1 as invoice_count,0 as budget_count,0 as undated_count
    from agency_invoices i cross join bounds d
    where i.organization_id=$1 and i.status in ('issued','partial','paid','overdue')
     and i.issued_on>=d.start_on and i.issued_on<d.end_on
    union all
    select p.currency,0,p.total,0,1,0 from pending p cross join bounds d
    where p.accepted_on>=d.start_on and p.accepted_on<d.end_on
    union all
    select p.currency,0,0,0,0,1 from pending p where p.accepted_on is null
   )
   select currency,sum(issued)::text as issued_total,sum(pending)::text as accepted_uninvoiced_total,
    sum(issued+pending)::text as expected_total,sum(invoice_count)::int as invoice_count,
    sum(budget_count)::int as budget_count,sum(undated_count)::int as undated_budget_count
   from entries group by currency order by currency`,[user.organization_id,`${month}-01`,forecastTimezone]);
  const personnel=(await db.query(`
   with included as (
    select c.monthly_salary_currency as currency,c.monthly_salary_amount as base_amount,o.amount as override_amount
    from agency_collaborators c
    left join agency_salary_month_overrides o on o.organization_id=c.organization_id and o.collaborator_id=c.id and o.month=$2::date
    where c.organization_id=$1 and c.active=true and c.monthly_salary_amount is not null and ${visibleRecord('c','collaborators')}
     and (c.started_on is null or c.started_on<($2::date+interval '1 month')::date)
     and (c.ended_on is null or c.ended_on>=$2::date)
   )
   select currency,count(*)::int as included_headcount,
    count(*) filter(where override_amount is null)::int as base_count,
    coalesce(sum(base_amount) filter(where override_amount is null),0)::text as base_amount,
    count(*) filter(where override_amount is not null)::int as override_count,
    coalesce(sum(override_amount) filter(where override_amount is not null),0)::text as override_amount,
    coalesce(sum(coalesce(override_amount,base_amount)),0)::text as expected_end_of_month_expense
   from included group by currency order by currency`,[user.organization_id,`${month}-01`])).rows;
  const [contractedRecurring,collectedActual,commissionForecast,plannedExpenses]=await Promise.all([
   db.query(`select t.currency,count(*)::int as client_count,coalesce(sum(coalesce(t.recurring_amount,round(case when t.discount_type='percent' then t.monthly_price*(1-t.discount_value/100) when t.discount_type='fixed' then greatest(t.monthly_price-t.discount_value,0) else t.monthly_price end)::bigint)),0)::text as amount
    from agency_client_commercial_terms t join agency_clients c on c.organization_id=t.organization_id and c.id=t.client_id
    where t.organization_id=$1 and t.starts_on<($2::date+interval '1 month')::date and c.active=true and ${visibleRecord('c','clients')}
    group by t.currency order by t.currency`,[user.organization_id,`${month}-01`]),
   db.query(`with movements as (
     select a.currency,p.amount,p.received_on as booked_on from agency_payments p join bank_accounts a on a.id=p.account_id and a.organization_id=p.organization_id where p.organization_id=$1
     union all
     select a.currency,-p.amount,r.reversed_on from agency_payment_reversals r join agency_payments p on p.id=r.payment_id and p.organization_id=r.organization_id join bank_accounts a on a.id=p.account_id and a.organization_id=p.organization_id where r.organization_id=$1
    ) select currency,coalesce(sum(amount),0)::text as amount from movements where booked_on>=$2::date and booked_on<($2::date+interval '1 month')::date group by currency order by currency`,[user.organization_id,`${month}-01`]),
   db.query(`select t.currency,count(*)::int as client_count,coalesce(sum(case when t.commission_mode='percentage' then round(coalesce(t.recurring_amount,round(case when t.discount_type='percent' then t.monthly_price*(1-t.discount_value/100) when t.discount_type='fixed' then greatest(t.monthly_price-t.discount_value,0) else t.monthly_price end)::bigint)*t.commission_value/100.0,0) when t.commission_mode='fixed' then t.commission_value else 0 end),0)::text as amount
    from agency_client_commercial_terms t join agency_clients c on c.organization_id=t.organization_id and c.id=t.client_id
    join agency_collaborators r on r.organization_id=t.organization_id and r.id=t.commission_recipient_id
    where t.organization_id=$1 and t.starts_on<($2::date+interval '1 month')::date and c.active=true and r.active=true and ${visibleRecord('c','clients')} and ${visibleRecord('r','collaborators')}
    group by t.currency order by t.currency`,[user.organization_id,`${month}-01`]),
   db.query(`select currency,count(*)::int as expense_count,coalesce(sum(amount),0)::text as amount from agency_planned_expenses
    where organization_id=$1 and ((cadence='monthly' and effective_month=$2::date) or (cadence='recurring' and effective_month<=$2::date))
    group by currency order by currency`,[user.organization_id,`${month}-01`])
  ]);
  const projectedRecords=rows.map(row=>projectMoney(row,['issued_total','accepted_uninvoiced_total','expected_total']));
  const invoiced=projectedRecords.filter(row=>row.issued_total!==0).map(row=>({currency:row.currency,amount:row.issued_total,invoice_count:row.invoice_count}));
  const projectedPersonnel=personnel.map(row=>projectMoney(row,['base_amount','override_amount','expected_end_of_month_expense']));
  const projectedSeries=series=>series.rows.map(row=>projectMoney(row,['amount']));
  send(res,200,{month,time_zone:forecastTimezone,records:projectedRecords,
   contracted_recurring:{month,records:projectedSeries(contractedRecurring)},
   invoiced:{month,records:invoiced},
   collected_actual:{month,records:projectedSeries(collectedActual)},
   personnel:{month,included_headcount:projectedPersonnel.reduce((count,row)=>count+row.included_headcount,0),records:projectedPersonnel},
   commission_forecast:{month,records:projectedSeries(commissionForecast)},
   planned_expenses:{month,records:projectedSeries(plannedExpenses)},definition:{
   issued:'Totales con impuestos de facturas emitidas en el mes, incluidas las cobradas; excluye borradores y canceladas.',
   accepted_uninvoiced:'Presupuestos aceptados sin ninguna factura vinculada, estimados en el mes de aceptación. No tienen fecha de facturación confirmada.',
   exclusions:'Sin oportunidades comerciales, conversiones de moneda ni cobros previstos. Un presupuesto con factura vinculada, incluso borrador o cancelada, no se vuelve a sumar. Los aceptados sin fecha se informan aparte.',
   contracted_recurring:'Acuerdos vigentes de clientes activos al cierre del mes. Es ingreso contractual recurrente y no representa una factura ni un cobro.',
   invoiced:'Facturas emitidas en el mes. Se informa por separado del ingreso contractual y de los cobros.',
   collected_actual:'Cobros efectivamente registrados por fecha de cobro, menos reversiones registradas en el mes. No se suma al ingreso contractual.',
   personnel:'Solo incluye colaboradores activos dentro de las fechas laborales, con salario mensual recurrente configurado. Un ajuste del mes reemplaza ese salario; no incluye pagos, comisiones ni compensaciones variables.',
   commission_forecast:'Comisiones previstas de acuerdos vigentes de clientes y destinatarios activos; las porcentuales se redondean al entero más cercano.',
   planned_expenses:'Gastos mensuales del mes seleccionado y gastos recurrentes vigentes desde su mes efectivo; no son pagos reales.'
  }});
 }catch(error){send(res,error.status||500,{error:error.status?error.message:'No se pudo cargar la previsión'});}
 return true;
}
