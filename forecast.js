import {fail} from './suite-validation.js';
import {visibleRecord} from './record-lifecycle.js';
import {roleCan} from './permissions.js';

export const forecastRoles = ['owner','admin','finance'];
export const forecastTimezone = 'America/Asuncion';

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

// Per-person salaries and monthly adjustments are sensitive fields (salary.view).
// A role with finance.view but without salary.view keeps the planning aggregates
// (currency totals the forecast exists to project) and the identity, and receives
// the per-person amounts as null — the same contract operations.js applies to the
// team directory through withoutSalary.
const projectMembers=(members,canSeeSalary)=>canSeeSalary?members.map(member=>projectMoney(member,['base_amount','override_amount'])):members.map(member=>({...member,base_amount:null,override_amount:null}));
const projectPersonnel=(rows,canSeeSalary)=>rows.map(row=>({...projectMoney(row,['base_amount','override_amount','expected_end_of_month_expense']),members:projectMembers(row.members||[],canSeeSalary)}));
const projectPersonnelTotals=rows=>rows.map(row=>projectMoney(row,['base_amount','override_amount','expected_end_of_month_expense']));

const monthSeries=(start,count)=>Array.from({length:count},(_,offset)=>{const [year,index]=start.split('-').map(Number);const total=index-1+offset;return `${year+Math.floor(total/12)}-${String((total%12)+1).padStart(2,'0')}`;});

const forecastSnapshot=async(db,organizationId,label)=>{
 // A single database snapshot and numeric sums avoid races and float rounding.
 // Any linked invoice suppresses the quote, including draft/cancelled invoices:
 // cancelling an invoice must not silently revive its quote as expected billing.
 const records=await db.query(`
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
  from entries group by currency order by currency`,[organizationId,`${label}-01`,forecastTimezone]);
 const personnel=await db.query(`
  with included as (
   select c.id as collaborator_id,c.user_id as user_id,
    coalesce(nullif(c.full_name,''),u.email) as name,
    p.photo_url as photo_url,
    c.currency as currency,c.compensation_type as compensation_type,
    case when c.compensation_type='fixed' and c.compensation_amount>0 then c.compensation_amount else 0 end as base_amount,
    coalesce((select sum(o.amount) from agency_salary_month_overrides o where o.organization_id=c.organization_id and o.collaborator_id=c.id and o.month=$2::date),0) as override_amount
   from agency_collaborators c
   left join users u on u.id=c.user_id
   left join agency_user_profiles p on p.user_id=c.user_id and p.organization_id=c.organization_id
   where c.organization_id=$1 and c.active=true and ${visibleRecord('c','collaborators')}
    and (c.started_on is null or c.started_on<($2::date+interval '1 month')::date)
    and (c.ended_on is null or c.ended_on>=$2::date)
  )
  select currency,count(*)::int as included_headcount,
   count(*) filter(where base_amount>0)::int as base_count,
   coalesce(sum(base_amount),0)::text as base_amount,
   count(*) filter(where override_amount<>0)::int as override_count,
   coalesce(sum(override_amount),0)::text as override_amount,
   coalesce(sum(base_amount+override_amount),0)::text as expected_end_of_month_expense,
   json_agg(json_build_object('collaborator_id',collaborator_id,'user_id',user_id,'name',name,'photo_url',photo_url,'currency',currency,'compensation_type',compensation_type,'base_amount',base_amount,'override_amount',override_amount) order by name,collaborator_id) as members
  from included group by currency order by currency`,[organizationId,`${label}-01`]);
 const [contractedRecurring,collectedActual,commissionForecast,plannedExpenses]=await Promise.all([
  db.query(`select t.currency,count(*)::int as client_count,coalesce(sum(coalesce(t.recurring_amount,round(case when t.discount_type='percent' then t.monthly_price*(1-t.discount_value/100) when t.discount_type='fixed' then greatest(t.monthly_price-t.discount_value,0) else t.monthly_price end)::bigint)),0)::text as amount
   from agency_client_commercial_terms t join agency_clients c on c.organization_id=t.organization_id and c.id=t.client_id
   where t.organization_id=$1 and t.cadence='monthly' and t.starts_on<($2::date+interval '1 month')::date and (t.ends_on is null or t.ends_on>=$2::date) and c.active=true and ${visibleRecord('c','clients')}
   group by t.currency order by t.currency`,[organizationId,`${label}-01`]),
  db.query(`with movements as (
    select a.currency,p.amount,p.received_on as booked_on from agency_payments p join bank_accounts a on a.id=p.account_id and a.organization_id=p.organization_id where p.organization_id=$1
    union all
    select a.currency,-p.amount,r.reversed_on from agency_payment_reversals r join agency_payments p on p.id=r.payment_id and p.organization_id=r.organization_id join bank_accounts a on a.id=p.account_id and a.organization_id=p.organization_id where r.organization_id=$1
   ) select currency,coalesce(sum(amount),0)::text as amount from movements where booked_on>=$2::date and booked_on<($2::date+interval '1 month')::date group by currency order by currency`,[organizationId,`${label}-01`]),
  db.query(`select t.currency,count(*)::int as client_count,coalesce(sum(case when t.commission_mode='percentage' then round(coalesce(t.recurring_amount,round(case when t.discount_type='percent' then t.monthly_price*(1-t.discount_value/100) when t.discount_type='fixed' then greatest(t.monthly_price-t.discount_value,0) else t.monthly_price end)::bigint)*t.commission_value/100.0,0) when t.commission_mode='fixed' then t.commission_value else 0 end),0)::text as amount
   from agency_client_commercial_terms t join agency_clients c on c.organization_id=t.organization_id and c.id=t.client_id
   join agency_collaborators r on r.organization_id=t.organization_id and r.id=t.commission_recipient_id
   where t.organization_id=$1 and t.cadence='monthly' and t.starts_on<($2::date+interval '1 month')::date and (t.ends_on is null or t.ends_on>=$2::date) and c.active=true and r.active=true and ${visibleRecord('c','clients')} and ${visibleRecord('r','collaborators')}
   group by t.currency order by t.currency`,[organizationId,`${label}-01`]),
  db.query(`select currency,count(*)::int as expense_count,count(*) filter(where kind='fixed')::int as fixed_count,count(*) filter(where kind='variable' or kind is null)::int as variable_count,coalesce(sum(amount),0)::text as amount from agency_planned_expenses
   where organization_id=$1 and ((cadence='monthly' and effective_month=$2::date) or (cadence='recurring' and effective_month<=$2::date))
   group by currency order by currency`,[organizationId,`${label}-01`])
 ]);
 return {records,personnel,contractedRecurring,collectedActual,commissionForecast,plannedExpenses};
};

const projectionFor=(snapshots,openingBalance)=>{
 const months=snapshots.map(({label,records,personnel,collectedActual,commissionForecast,plannedExpenses})=>({
  label,
  issued:records.rows.map(row=>projectMoney(row,['issued_total','accepted_uninvoiced_total','expected_total'])),
  personnel:projectPersonnelTotals(personnel.rows),
  collected:collectedActual.rows.map(row=>projectMoney(row,['amount'])),
  commissions:commissionForecast.rows.map(row=>projectMoney(row,['amount'])),
  planned:plannedExpenses.rows.map(row=>projectMoney(row,['amount']))
 }));
 const amount=(rows,currency,key='amount')=>Number(rows.find(row=>row.currency===currency)?.[key]??0);
 const opening=(currency)=>Number(openingBalance.find(row=>row.currency===currency)?.amount??0);
 const currencies=[...new Set([...months.flatMap(snapshot=>[...snapshot.issued,...snapshot.personnel,...snapshot.collected,...snapshot.commissions,...snapshot.planned].map(row=>row.currency)),...openingBalance.map(row=>row.currency)])].sort();
 const relevant=currencies.filter(currency=>months.some(snapshot=>amount(snapshot.issued,currency,'issued_total')+amount(snapshot.issued,currency,'accepted_uninvoiced_total')!==0||amount(snapshot.personnel,currency,'expected_end_of_month_expense')!==0||amount(snapshot.collected,currency)!==0||amount(snapshot.commissions,currency)!==0||amount(snapshot.planned,currency)!==0||opening(currency)!==0));
 const carry=new Map(),records=[];
 for(const snapshot of months)for(const currency of relevant){
  const expected=amount(snapshot.issued,currency,'issued_total')+amount(snapshot.issued,currency,'accepted_uninvoiced_total');
  const personnel=amount(snapshot.personnel,currency,'expected_end_of_month_expense');
  const planned=amount(snapshot.planned,currency);
  const commission=amount(snapshot.commissions,currency);
  const collected=amount(snapshot.collected,currency);
  const projectedCash=(carry.get(currency)??opening(currency))+(collected!==0?collected:expected)-personnel-planned-commission;
  carry.set(currency,projectedCash);
  records.push({month:snapshot.label,currency,projected_cash:projectedCash,projected_result:expected-personnel-planned-commission,collected,expected,personnel,planned_expenses:planned,commission_forecast:commission});
 }
 return records;
};

export async function financialForecast({req,res,url,db,session,send}) {
 if(url.pathname!=='/api/agency/forecast')return false;
 try {
  const user=await session(req);
  if(!user)fail('No autenticado',401);
  if(!roleCan(user,'finance.view'))fail('Tu rol no permite ver saldos',403);
  if(req.method!=='GET')fail('Método no permitido',405);
  const month=forecastMonth(url.searchParams.get('month'));
  const monthsParam=url.searchParams.get('months')??'1';
  if(!/^(?:[1-9]|1[0-2])$/.test(monthsParam))fail('months debe estar entre 1 y 12');
  const months=Number(monthsParam);
  const snapshots=[];
  for(const label of monthSeries(month,months))snapshots.push({label,...await forecastSnapshot(db,user.organization_id,label)});
  const first=snapshots[0];
  const projectedRecords=first.records.rows.map(row=>projectMoney(row,['issued_total','accepted_uninvoiced_total','expected_total']));
  const invoiced=projectedRecords.filter(row=>row.issued_total!==0).map(row=>({currency:row.currency,amount:row.issued_total,invoice_count:row.invoice_count}));
  const projectedPersonnel=projectPersonnel(first.personnel.rows,roleCan(user,'salary.view'));
  const projectedSeries=series=>series.rows.map(row=>projectMoney(row,['amount']));
  const openingBalance=projectedSeries(await db.query('select currency,coalesce(sum(balance),0)::text as amount from bank_accounts where organization_id=$1 and active=true group by currency order by currency',[user.organization_id]));
  const contractedClients=(await db.query(`
   with bounds as (select $2::date as start_on,($2::date+interval '1 month')::date as end_on),
   terms as (
    select t.client_id,t.currency,t.invoice_required,t.ends_on::text as ends_on,
     coalesce(t.recurring_amount,round(case when t.discount_type='percent' then t.monthly_price*(1-t.discount_value/100) when t.discount_type='fixed' then greatest(t.monthly_price-t.discount_value,0) else t.monthly_price end)::bigint) as contracted_amount
    from agency_client_commercial_terms t join agency_clients c on c.organization_id=t.organization_id and c.id=t.client_id
    where t.organization_id=$1 and t.starts_on<($2::date+interval '1 month')::date and (t.ends_on is null or t.ends_on>=$2::date) and c.active=true and ${visibleRecord('c','clients')}
   ), invoiced as (
    select i.client_id,i.currency,coalesce(sum(i.total),0) as invoiced_amount
    from agency_invoices i cross join bounds d
    where i.organization_id=$1 and i.status in ('issued','partial','paid','overdue') and i.issued_on>=d.start_on and i.issued_on<d.end_on
    group by i.client_id,i.currency
   )
   select t.client_id::text as client_id,c.name as client_name,t.currency,t.contracted_amount,coalesce(i.invoiced_amount,0) as invoiced_amount,t.invoice_required,t.ends_on,
    (t.invoice_required and coalesce(i.invoiced_amount,0)=0) as missing_invoice
   from terms t join agency_clients c on c.id=t.client_id and c.organization_id=$1
   left join invoiced i on i.client_id=t.client_id and i.currency=t.currency
   order by c.name,t.currency`,[user.organization_id,`${month}-01`])).rows.map(row=>projectMoney(row,['contracted_amount','invoiced_amount']));
  const projection=projectionFor(snapshots,openingBalance);
  send(res,200,{month,months,time_zone:forecastTimezone,records:projectedRecords,
   contracted_recurring:{month,records:projectedSeries(first.contractedRecurring)},
   invoiced:{month,records:invoiced},
   collected_actual:{month,records:projectedSeries(first.collectedActual)},
   personnel:{month,included_headcount:projectedPersonnel.reduce((count,row)=>count+row.included_headcount,0),records:projectedPersonnel},
   commission_forecast:{month,records:projectedSeries(first.commissionForecast)},
   planned_expenses:{month,records:projectedSeries(first.plannedExpenses)},
   opening_balance:{month,records:openingBalance},
   contracted_clients:{month,records:contractedClients},
   projection:{months,records:projection},definition:{
    issued:'Totales con impuestos de facturas emitidas en el mes, incluidas las cobradas; excluye borradores y canceladas.',
    accepted_uninvoiced:'Presupuestos aceptados sin ninguna factura vinculada, estimados en el mes de aceptación. No tienen fecha de facturación confirmada.',
    exclusions:'Sin oportunidades comerciales, conversiones de moneda ni cobros previstos. Un presupuesto con factura vinculada, incluso borrador o cancelada, no se vuelve a sumar. Los aceptados sin fecha se informan aparte.',
    contracted_recurring:'Solo acuerdos mensuales fijos de clientes activos al cierre del mes: empezaron antes de fin de mes y no tienen fecha de fin, o su fin cae dentro del mes. Contratos por única vez o cada varios meses no se proyectan como ingreso mensual. Es ingreso contractual y no representa una factura ni un cobro.',
    invoiced:'Facturas emitidas en el mes. Se informa por separado del ingreso contractual y de los cobros.',
    collected_actual:'Cobros efectivamente registrados por fecha de cobro, menos reversiones registradas en el mes. No se suma al ingreso contractual.',
    personnel:'Incluye colaboradores activos dentro de las fechas laborales de cada mes. El salario base corresponde a la modalidad fijo mensual con importe acordado; los ajustes del mes son extras o descuentos por persona para ese mes. No incluye pagos, comisiones ni compensaciones de otras modalidades.',
    commission_forecast:'Comisiones previstas de acuerdos vigentes de clientes y destinatarios activos; las porcentuales se redondean al entero más cercano.',
    planned_expenses:'Gastos mensuales del mes seleccionado y gastos recurrentes vigentes desde su mes efectivo; no son pagos reales.',
    opening_balance:'Saldo actual de las cuentas activas por moneda; es la base de caja del primer mes de la proyección.',
    projected_cash:'Caja proyectada: parte del saldo de cuentas activas y acumula cada mes los cobros registrados (o la facturación esperada si el mes no tiene cobros) menos personal, gastos planificados y comisiones.',
    projected_result:'Resultado estimado: emitido más aceptado sin factura del mes, menos personal, gastos planificados y comisiones; sigue el resultado estimado del panel.',
    contracted_clients:'Contratos vigentes por cliente con lo facturado en el mes seleccionado. Sin factura marca contratos con facturación requerida y sin factura emitida en el mes.'
   }});
 }catch(error){send(res,error.status||500,{error:error.status?error.message:'No se pudo cargar la previsión'});}
 return true;
}
