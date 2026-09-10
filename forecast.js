import {visibleRecord} from './record-lifecycle.js';

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

export async function financialForecast({req,res,url,db,session,send}) {
 if(url.pathname!=='/api/agency/forecast')return false;
 try {
  const user=await session(req);
  if(!user)fail('No autenticado',401);
  if(!forecastRoles.includes(user.role))fail('Tu rol no permite ver saldos',403);
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
  send(res,200,{month,time_zone:forecastTimezone,records:rows,definition:{
   issued:'Totales con impuestos de facturas emitidas en el mes, incluidas las cobradas; excluye borradores y canceladas.',
   accepted_uninvoiced:'Presupuestos aceptados sin ninguna factura vinculada, estimados en el mes de aceptación. No tienen fecha de facturación confirmada.',
   exclusions:'Sin oportunidades comerciales, conversiones de moneda ni cobros previstos. Un presupuesto con factura vinculada, incluso borrador o cancelada, no se vuelve a sumar. Los aceptados sin fecha se informan aparte.'
  }});
 }catch(error){send(res,error.status||500,{error:error.status?error.message:'No se pudo cargar la previsión'});}
 return true;
}
