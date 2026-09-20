import {fail,text,id,optId,option,amount,date,email} from './suite-validation.js';
import {currencies} from './currencies.js';
import {roleCan} from './permissions.js';
import {attributeActors} from './actor-identity.js';
import {companyCurrency,forecastMonth,forecastTimezone} from './forecast.js';
import { collaboratorAccess } from './collaborator-access.js';
import { profilePhoto } from './media-policy.js';
import {visibleRecord,assertRecordAvailable} from './record-lifecycle.js';
import {saveCommentMentions} from './comment-mentions.js';

// El importe del módulo delega en `amount` (límite, signo y redondeo compartidos)
// y solo agrega la regla de negocio: el cero no es un importe válido salvo que el
// campo lo admita explícitamente (compensación y comisión fija).
const money=(value,zero=false)=>{const n=amount(value);if(!zero&&n===0)fail('Importe inválido');return n;};
function monthlySalary(value) { const raw=typeof value==='string'?value.trim():value;if((typeof raw!=='number'&&typeof raw!=='string')||(typeof raw==='string'&&!/^\d+$/.test(raw)))fail('El salario mensual debe ser un importe entero válido');const n=Number(raw);if(!Number.isSafeInteger(n)||n<=0||n>999999999999)fail('El salario mensual debe ser un importe entero válido');return n; }
function salaryOverrideAmount(value) { const raw=typeof value==='string'?value.trim():value;if((typeof raw!=='number'&&typeof raw!=='string')||(typeof raw==='string'&&!/^-?\d+$/.test(raw)))fail('El ajuste del mes debe ser un importe entero distinto de cero');const n=Number(raw);if(!Number.isSafeInteger(n)||n===0||Math.abs(n)>999999999999)fail('El ajuste del mes debe ser un importe entero distinto de cero');return n; }
async function belongs(c,table,id,org) { if(!id)return;const row=(await c.query(`select * from ${table} where id=$1 and organization_id=$2`,[id,org])).rows[0];if(!row)fail('Registro no encontrado',404);await assertRecordAvailable(c,table,row); }
export async function operations({req,res,url,db,session,body,send,sendInvitation=async()=>false}) {
 const teamRoute=url.pathname==='/api/agency/team';
 const commentMatch=url.pathname.match(/^\/api\/agency\/projects\/(\d+)\/comments$/);
 const collaboratorMatch=url.pathname.match(/^\/api\/agency\/collaborators(?:\/(\d+))?$/);
 const salaryOverrideMatch=url.pathname.match(/^\/api\/agency\/collaborators\/(\d+)\/salary-overrides$/);
 const commissionMatch=url.pathname.match(/^\/api\/agency\/commissions(?:\/(\d+))?$/);
 const commissionMonthlyRoute=url.pathname==='/api/agency/commissions/monthly';
 const payoutRoute=url.pathname==='/api/agency/payouts';
 const discountMatch=url.pathname.match(/^\/api\/agency\/referral-discounts(?:\/(\d+))?$/);
 const jobMatch=url.pathname.match(/^\/api\/agency\/job-roles(?:\/(\d+))?$/);
 if(!teamRoute&&!commentMatch&&!collaboratorMatch&&!salaryOverrideMatch&&!commissionMatch&&!commissionMonthlyRoute&&!payoutRoute&&!discountMatch&&!jobMatch) return false;
 const user=await session(req);
 if(!user) {send(res,401,{error:'No autenticado'});return true;}
 // Comisiones y referidos siguen a `commissions.manage` (el toggle del panel);
 // `/payouts` también paga honorarios del equipo y queda en finance.view.
 const commissionsRoute=commissionMatch||commissionMonthlyRoute||discountMatch;
 const allowed=teamRoute&&req.method==='GET' ? true : commentMatch ? req.method==='GET'||user.role!=='viewer' : jobMatch&&req.method!=='GET' ? roleCan(user,'members.manage') : collaboratorMatch ? roleCan(user,'members.manage')||roleCan(user,'finance.view') : commissionsRoute ? roleCan(user,'commissions.manage') : roleCan(user,'finance.view');
 if(!allowed) {send(res,403,{error:'Tu rol no permite esta operación'});return true;}
 const c=await db.connect();
 try {
  await c.query('begin');
  await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
  const org=user.organization_id;
  let result, status=200, notifyEmail=null;
  const withoutSalary=row=>{if(roleCan(user,'salary.view'))return row;return {...row,compensation_amount:null,monthly_salary_amount:null,monthly_salary_currency:null,payment_day:null,invoices_company:null};};
  if(teamRoute){
   if(req.method!=='GET')fail('Método no permitido',405);
   // Every member reaches the team directory, but only finance keeps the full
   // record. Directory roles receive photo, name and cargo and nothing else:
   // no salaries, no contact data, no access state.
   if(!roleCan(user,'finance.view')&&!roleCan(user,'members.manage')){
    const members=(await c.query(`select u.id::text as id,coalesce(nullif(p.full_name,''),u.email) as full_name,p.photo_url,m.role from organization_members m join users u on u.id=m.user_id left join agency_user_profiles p on p.user_id=u.id and p.organization_id=m.organization_id where m.organization_id=$1 and m.active and m.removed_at is null order by full_name`,[org])).rows;
    const extra=(await c.query(`select c.id::text as id,c.full_name,c.photo_url,c.job_title from agency_collaborators c where c.organization_id=$1 and c.user_id is null and ${visibleRecord('c','collaborators')} order by c.full_name`,[org])).rows;
    result={directory:[...members,...extra.map(person=>({id:person.id,full_name:person.full_name,photo_url:person.photo_url,role:'',cargo:person.job_title||''}))]};
   }else{
   const collaborators=(await c.query(`select c.*,u.email as access_email from agency_collaborators c left join users u on u.id=c.user_id where c.organization_id=$1 and ${visibleRecord('c','collaborators')} order by c.active desc,c.full_name`,[org])).rows;
   const members=(await c.query('select u.id,u.email,m.role,m.active,m.removed_at,p.full_name,p.photo_url from organization_members m join users u on u.id=m.user_id left join agency_user_profiles p on p.user_id=u.id and p.organization_id=m.organization_id where m.organization_id=$1 order by u.email',[org])).rows;
   const archivedProfiles=(await c.query("select c.id,c.user_id,c.email from agency_collaborators c join agency_archived_records a on a.organization_id=c.organization_id and a.record_id=c.id and a.kind='collaborators' where c.organization_id=$1",[org])).rows;
   result={collaborators:collaborators.map(withoutSalary),members,archivedProfiles};
   }
  }else if(jobMatch) {
   await c.query('select ensure_agency_job_catalog($1)',[org]);
   if(req.method==='GET')result={roles:(await c.query('select * from agency_job_roles where organization_id=$1 order by active desc,name',[org])).rows};
   else if(req.method==='POST'&&!jobMatch[1]) {const name=text((await body(req)).name,120);if(!name)fail('Ingresá el cargo');result={role:(await c.query('insert into agency_job_roles(organization_id,name) values($1,$2) returning *',[org,name])).rows[0]};status=201;}
   else if(req.method==='PATCH'&&jobMatch[1]) {const b=await body(req),name=text(b.name,120);if(!name)fail('Ingresá el cargo');const j=(await c.query('update agency_job_roles set name=$1,active=$2 where id=$3 and organization_id=$4 returning *',[name,b.active!==false,jobMatch[1],org])).rows[0];if(!j)fail('Cargo no encontrado',404);await c.query('update agency_collaborators set job_title=$1 where job_role_id=$2 and organization_id=$3',[name,j.id,org]);result={role:j};}
   else fail('Método no permitido',405);
  }else if(discountMatch) {
   if(req.method==='GET')result={discounts:(await c.query('select d.*,i.number as invoice_number,i.currency,a.name as client_name from agency_referral_discounts d join agency_invoices i on i.id=d.invoice_id join agency_clients a on a.id=i.client_id where d.organization_id=$1 order by d.created_at desc',[org])).rows};
   else if(req.method==='POST'||(req.method==='PATCH'&&discountMatch[1])) {
    const b=await body(req);let existing,invoiceId;
    if(discountMatch[1]){existing=(await c.query('select * from agency_referral_discounts where id=$1 and organization_id=$2 for update',[discountMatch[1],org])).rows[0];if(!existing||existing.status!=='applied')fail('Descuento no disponible para revertir',409);invoiceId=existing.invoice_id;}
    else invoiceId=id(b.invoice_id);
    const i=(await c.query('select * from agency_invoices where id=$1 and organization_id=$2 for update',[invoiceId,org])).rows[0];if(!i)fail('Factura no encontrada',404);if(i.status==='cancelled')fail('Factura cancelada');
    const discountAmount=existing?Number(existing.amount):money(b.amount);const total=Math.round((Number(i.total)+(existing?discountAmount:-discountAmount))*100)/100;
    if(total<Number(i.paid_amount)||total<0)fail('El descuento supera el saldo pendiente');
    if(existing)result={discount:(await c.query("update agency_referral_discounts set status='reversed' where id=$1 and organization_id=$2 returning *",[existing.id,org])).rows[0]};
    else{const referrer=text(b.referrer,120),reason=text(b.reason,500);if(!referrer||!reason)fail('Indicá quién refirió y el motivo');result={discount:(await c.query('insert into agency_referral_discounts(organization_id,invoice_id,referrer,amount,reason,created_by_user_id) values($1,$2,$3,$4,$5,$6) returning *',[org,invoiceId,referrer,discountAmount,reason,user.id])).rows[0]};status=201;}
    await c.query("update agency_invoices set total=$1,status=case when paid_amount >= $1 then 'paid' when paid_amount>0 then 'partial' else 'issued' end,updated_at=now() where id=$2 and organization_id=$3",[total,invoiceId,org]);
   }else fail('Método no permitido',405);
  } else if(commentMatch) {
   await belongs(c,'agency_projects',commentMatch[1],org);
   if(req.method==='GET') result={comments:(await c.query(`select c.*,u.email as author_email,coalesce((select jsonb_agg(m.mentioned_user_id::text order by m.mentioned_user_id) from agency_project_comment_mentions m where m.organization_id=c.organization_id and m.project_comment_id=c.id),'[]'::jsonb) as mentioned_user_ids from agency_project_comments c left join users u on u.id=c.author_user_id where c.organization_id=$1 and c.project_id=$2 order by c.created_at,c.id`,[org,commentMatch[1]])).rows};
   else if(req.method==='POST') {
    const incoming=await body(req),commentBody=text(incoming.body);if(!commentBody) fail('Escribí un comentario');
    const comment=(await c.query('insert into agency_project_comments(organization_id,project_id,author_user_id,body) values($1,$2,$3,$4) returning *',[org,commentMatch[1],user.id,commentBody])).rows[0];
    await saveCommentMentions(c,{organizationId:org,commentKind:'project',commentId:comment.id,mentionedUserIds:incoming.mentioned_user_ids,projectId:commentMatch[1],title:'Nuevo comentario de proyecto',body:commentBody});
    result={comment};status=201;
   }
   else fail('Método no permitido',405);
  } else if(salaryOverrideMatch) {
   // El ajuste mensual es dato salarial: verlo o cambiarlo exige salary.view,
   // la misma capacidad que protege la ficha del colaborador (más abajo) y el
   // enmascarado de lectura. Sin esto, un rol con finance.view sin salary.view
   // editaba (y leía) salarios que la previsión le muestra en null.
   if(!roleCan(user,'salary.view'))fail(req.method==='GET'?'Tu rol no permite ver salarios':'Tu rol no permite editar salarios',403);
   const collaborator=(await c.query('select * from agency_collaborators where id=$1 and organization_id=$2 for update',[salaryOverrideMatch[1],org])).rows[0];
   if(!collaborator)fail('Colaborador no encontrado',404);
   await assertRecordAvailable(c,'agency_collaborators',collaborator);
   if(req.method==='GET'){
    const month=forecastMonth(url.searchParams.get('month'));
    result={month,override:(await c.query('select amount::text as amount,note from agency_salary_month_overrides where organization_id=$1 and collaborator_id=$2 and month=$3::date',[org,collaborator.id,`${month}-01`])).rows[0]||null};
   } else if(req.method==='PATCH'){
    const b=await body(req),month=forecastMonth(b.month),overrideAmount=salaryOverrideAmount(b.amount);
    result={month,override:(await c.query(`insert into agency_salary_month_overrides(organization_id,collaborator_id,month,amount,note)
     values($1,$2,$3::date,$4,$5) on conflict(organization_id,collaborator_id,month) do update set amount=excluded.amount,note=excluded.note,updated_at=now()
     returning amount::text as amount,note`,[org,collaborator.id,`${month}-01`,overrideAmount,text(b.note||'',1000)||null])).rows[0]};
   } else if(req.method==='DELETE'){
    const month=forecastMonth(url.searchParams.get('month'));
    await c.query('delete from agency_salary_month_overrides where organization_id=$1 and collaborator_id=$2 and month=$3::date',[org,collaborator.id,`${month}-01`]);result={month,override:null};
   } else fail('Método no permitido',405);
  } else if(collaboratorMatch) {
   if(req.method==='GET') result={collaborators:(await c.query(`select c.*,u.email as access_email from agency_collaborators c left join users u on u.id=c.user_id where c.organization_id=$1 and ${visibleRecord('c','collaborators')} order by c.active desc,c.full_name`,[org])).rows.map(withoutSalary)};
   else if(req.method==='POST'||(req.method==='PATCH'&&collaboratorMatch[1])) {
    let previous={};if(collaboratorMatch[1]){previous=(await c.query('select * from agency_collaborators where id=$1 and organization_id=$2 for update',[collaboratorMatch[1],org])).rows[0];if(!previous)fail('Registro no encontrado',404);await assertRecordAvailable(c,'agency_collaborators',previous);}
    const incoming=await body(req), b={compensation_type:'fixed',compensation_amount:0,active:true,...previous,...incoming};
    if(!roleCan(user,'salary.view')&&(Object.hasOwn(incoming,'compensation_amount')||Object.hasOwn(incoming,'monthly_salary_amount')||Object.hasOwn(incoming,'monthly_salary_currency')||Object.hasOwn(incoming,'payment_day')||Object.hasOwn(incoming,'invoices_company')))fail('Tu rol no permite editar salarios',403);
    if(!collaboratorMatch[1]&&b.currency===undefined)b.currency=await companyCurrency(c,org);
    const name=text(b.full_name,120);if(name.length<2) fail('Ingresá el nombre');
    for(const key of ['started_on','ended_on'])if(b[key] instanceof Date)b[key]=b[key].toISOString().slice(0,10);
    const contact=email(b.email);let uid=optId(b.user_id);
    if(!collaboratorMatch[1]&&contact){
     await c.query('select id from organizations where id=$1 for update',[org]);
     if((await c.query('select id from agency_collaborators where organization_id=$1 and lower(trim(email))=$2',[org,contact])).rows.length)fail('Esta persona ya tiene un perfil en la empresa. Buscalo en Equipo o restauralo desde Papelera.',409);
    }
    if(uid&&String(uid)!==String(previous.user_id||'')&&!roleCan(user,'members.manage'))fail('Solo administración puede vincular accesos',403);
    if(uid&&!(await c.query('select 1 from organization_members where organization_id=$1 and user_id=$2',[org,uid])).rows.length) fail('El acceso debe pertenecer a esta empresa');
    if(uid&&contact){const linked=(await c.query('select email from users where id=$1',[uid])).rows[0];if(linked.email!==contact){if(incoming.user_id)fail('El acceso debe coincidir con el correo de contacto');uid=null;}}
    const jobId=optId(b.job_role_id);let jobTitle=text(b.job_title||'',120);
    if(Object.hasOwn(incoming,'job_role_id')&&!jobId)jobTitle='';
    if(jobId){const j=(await c.query('select * from agency_job_roles where id=$1 and organization_id=$2',[jobId,org])).rows[0];if(!j||(!j.active&&String(jobId)!==String(previous.job_role_id)))fail('Elegí un cargo activo de esta empresa');jobTitle=j.name;}
    const photo=Object.hasOwn(incoming,'photo_url') ? await profilePhoto(incoming.photo_url) : previous.photo_url || null;
    const day=b.payment_day?Number(b.payment_day):null;if(day!==null&&(!Number.isInteger(day)||day<1||day>31)) fail('Día de pago inválido');
    const start=date(b.started_on),end=date(b.ended_on);if(start&&end&&end<start) fail('La salida no puede ser anterior al ingreso');
    const access=await collaboratorAccess(c,{email:contact,org,actorRole:user.demo_owner_user_id?'finance':user.role,active:b.active!==false,previousUserId:uid});uid=access.userId;notifyEmail=access.notifyEmail;
    // Administration may set the member photo from the team directory. The photo
    // lives in the personal identity, so an authorized org context updates it and
    // every organization copy syncs from there; removal keeps its tombstone.
    if(Object.hasOwn(incoming,'photo_url')&&uid){
      await c.query("select set_config('app.current_organization',$1,true),set_config('app.identity_admin','true',true)",[String(org)]);
      await c.query(`insert into user_personal_identities(user_id,full_name,photo_url,photo_removed_at)
        select $1,$2,$3,case when $3::text is null then now() else null end from organization_person_identity where user_id=$1 and organization_id=$4 and not is_demo
        on conflict(user_id) do update set photo_url=excluded.photo_url,photo_removed_at=excluded.photo_removed_at,updated_at=now()`,[uid,name,photo||null,org]);
    }
    const salaryAmount=Object.hasOwn(incoming,'monthly_salary_amount')?monthlySalary(incoming.monthly_salary_amount):previous.monthly_salary_amount??null,salaryCurrency=salaryAmount===null?null:option(b.monthly_salary_currency||'PYG',currencies);
    const values=[org,uid,name,contact,photo||null,jobTitle,option(b.compensation_type,['fixed','variable','hourly','per_project']),money(b.compensation_amount,true),Boolean(b.invoices_company),start,day,b.active!==false,text(b.notes||''),option(b.currency,currencies),end,salaryAmount,salaryCurrency];
    if(collaboratorMatch[1]) {await belongs(c,'agency_collaborators',collaboratorMatch[1],org);values.push(collaboratorMatch[1]);result={collaborator:(await c.query('update agency_collaborators set user_id=$2,full_name=$3,email=$4,photo_url=$5,job_title=$6,compensation_type=$7,compensation_amount=$8,invoices_company=$9,started_on=$10,payment_day=$11,active=$12,notes=$13,currency=$14,ended_on=$15,monthly_salary_amount=$16,monthly_salary_currency=$17,updated_at=now() where organization_id=$1 and id=$18 returning *',values)).rows[0]};}
    else {result={collaborator:(await c.query('insert into agency_collaborators(organization_id,user_id,full_name,email,photo_url,job_title,compensation_type,compensation_amount,invoices_company,started_on,payment_day,active,notes,currency,ended_on,monthly_salary_amount,monthly_salary_currency) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) returning *',values)).rows[0]};status=201;}
    result.collaborator=(await c.query('update agency_collaborators set job_role_id=$1 where id=$2 and organization_id=$3 returning *',[jobId,result.collaborator.id,org])).rows[0];result.access={status:access.status};result.collaborator=withoutSalary(result.collaborator);
   } else fail('Método no permitido',405);
  } else if(commissionMonthlyRoute) {
   if(req.method!=='GET')fail('Método no permitido',405);
   const month=forecastMonth(url.searchParams.get('month'));
   const [expected,recorded]=await Promise.all([
    c.query(`select r.id::text as recipient_id,r.full_name as name,t.currency,coalesce(sum(case when t.commission_mode='percentage' then round(coalesce(t.recurring_amount,round(case when t.discount_type='percent' then t.monthly_price*(1-t.discount_value/100) when t.discount_type='fixed' then greatest(t.monthly_price-t.discount_value,0) else t.monthly_price end)::bigint)*t.commission_value/100.0,0) when t.commission_mode='fixed' then t.commission_value else 0 end),0)::text as expected_amount
     from agency_client_commercial_terms t join agency_clients c on c.organization_id=t.organization_id and c.id=t.client_id
     join agency_collaborators r on r.organization_id=t.organization_id and r.id=t.commission_recipient_id
     where t.organization_id=$1 and t.starts_on<($2::date+interval '1 month')::date and c.active=true and r.active=true and ${visibleRecord('c','clients')} and ${visibleRecord('r','collaborators')}
     group by r.id,r.full_name,t.currency order by r.full_name,t.currency`,[org,`${month}-01`]),
    c.query(`select x.collaborator_id::text as recipient_id,
      case when x.collaborator_id is null then x.beneficiary_name else c.full_name end as name,x.currency,
      coalesce(sum(x.amount) filter(where x.status='pending'),0)::text as pending_amount,
      coalesce(sum(x.amount) filter(where x.status='approved'),0)::text as approved_amount,
      coalesce(sum(x.amount) filter(where x.status='paid'),0)::text as paid_amount,
      coalesce(sum(x.amount),0)::text as recorded_amount
     from agency_commissions x
     left join agency_invoices i on i.id=x.invoice_id and i.organization_id=x.organization_id
     left join agency_collaborators c on c.id=x.collaborator_id
     where x.organization_id=$1 and x.status in ('pending','approved','paid')
      and coalesce(i.issued_on,x.due_on,x.paid_on,(x.created_at at time zone $3)::date)>=$2::date
      and coalesce(i.issued_on,x.due_on,x.paid_on,(x.created_at at time zone $3)::date)<($2::date+interval '1 month')::date
     group by x.collaborator_id,x.currency,case when x.collaborator_id is null then x.beneficiary_name else c.full_name end`,[org,`${month}-01`,forecastTimezone])
   ]);
   const byKey=new Map();
   for(const row of [...expected.rows,...recorded.rows]){
    const linked=row.recipient_id!==null&&row.recipient_id!==undefined;
    const key=`${linked?String(row.recipient_id):`unlinked:${String(row.name)}`}\u0000${row.currency}`;
    const current=byKey.get(key);
    if(current){
     current.expected_amount+=row.expected_amount===undefined?0:Number(row.expected_amount);
     current.recorded_amount+=row.recorded_amount===undefined?0:Number(row.recorded_amount);
     current.approved_amount+=row.approved_amount===undefined?0:Number(row.approved_amount);
     current.paid_amount+=row.paid_amount===undefined?0:Number(row.paid_amount);
     current.pending_amount+=row.pending_amount===undefined?0:Number(row.pending_amount);
     continue;
    }
    byKey.set(key,{recipient_id:linked?String(row.recipient_id):null,name:row.name??null,currency:row.currency,
     expected_amount:row.expected_amount===undefined?0:Number(row.expected_amount),
     recorded_amount:row.recorded_amount===undefined?0:Number(row.recorded_amount),
     approved_amount:row.approved_amount===undefined?0:Number(row.approved_amount),
     paid_amount:row.paid_amount===undefined?0:Number(row.paid_amount),
     pending_amount:row.pending_amount===undefined?0:Number(row.pending_amount)});
   }
   const records=[...byKey.values()]
    .filter(row=>row.expected_amount!==0||row.recorded_amount!==0||row.approved_amount!==0||row.paid_amount!==0||row.pending_amount!==0)
    .map(row=>({recipient_id:row.recipient_id,name:row.name,currency:row.currency,expected_amount:row.expected_amount,recorded_amount:row.recorded_amount,approved_amount:row.approved_amount,paid_amount:row.paid_amount,pending_amount:row.pending_amount}))
    .sort((a,b)=>String(a.name||'').localeCompare(String(b.name||''))||a.currency.localeCompare(b.currency));
   result={month,records};
  } else if(commissionMatch) {
   if(req.method==='GET') result={commissions:(await c.query('select x.*,i.number as invoice_number,c.full_name as collaborator_name from agency_commissions x left join agency_invoices i on i.id=x.invoice_id left join agency_collaborators c on c.id=x.collaborator_id where x.organization_id=$1 order by x.created_at desc',[org])).rows};
   else if(req.method==='POST') {
    const b=await body(req), invoice=optId(b.invoice_id),collaborator=optId(b.collaborator_id),basis=option(b.basis,['fixed','invoiced','collected']);
    await belongs(c,'agency_collaborators',collaborator,org);await belongs(c,'agency_invoices',invoice,org);
    let base=null,percent=null,commissionAmount=money(b.amount,true),currency=invoice?null:option(b.currency===undefined?await companyCurrency(c,org):b.currency,currencies);
    if(invoice) {const i=(await c.query('select * from agency_invoices where id=$1 and organization_id=$2 for update',[invoice,org])).rows[0];currency=i.currency;base=Number(basis==='collected'?i.paid_amount:i.total);if(i.status==='cancelled') fail('Factura cancelada');}
    if(basis!=='fixed') {if(!invoice) fail('Elegí una factura para calcular el porcentaje');percent=money(b.percentage);if(percent>100) fail('Porcentaje máximo: 100');commissionAmount=Math.round(base*percent)/100;}
    if(commissionAmount<=0) fail('La comisión debe ser mayor a cero');
    const name=text(b.beneficiary_name,120);if(!name) fail('Ingresá el beneficiario');
    result={commission:(await c.query('insert into agency_commissions(organization_id,invoice_id,collaborator_id,kind,beneficiary_name,percentage,amount,currency,due_on,notes,basis,base_amount) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',[org,invoice,collaborator,option(b.kind,['sales','referral']),name,percent,commissionAmount,currency,date(b.due_on),text(b.notes||''),basis,base])).rows[0]};status=201;
   } else if(req.method==='PATCH'&&commissionMatch[1]) {
    const b=await body(req), next=option(b.status,['approved','cancelled']);
    const row=(await c.query("update agency_commissions set status=$1 where id=$2 and organization_id=$3 and status in ('pending','approved') returning *",[next,commissionMatch[1],org])).rows[0];if(!row) fail('La comisión no está disponible para cambiar de estado',409);result={commission:row};
   } else fail('Método no permitido',405);
  } else if(payoutRoute) {
   if(req.method==='GET') result={payouts:(await c.query('select p.*,a.name as account_name,a.currency,c.full_name as collaborator_name,x.beneficiary_name,u.email as created_by_email from agency_payouts p join bank_accounts a on a.id=p.account_id left join agency_collaborators c on c.id=p.collaborator_id left join agency_commissions x on x.id=p.commission_id left join users u on u.id=p.created_by_user_id where p.organization_id=$1 order by p.paid_on desc,p.id desc',[org])).rows};
   else if(req.method==='POST') {
    const b=await body(req),commission=optId(b.commission_id),collaborator=optId(b.collaborator_id),account=id(b.account_id);
    if(Boolean(commission)===Boolean(collaborator)) fail('Elegí una comisión o un colaborador');
    let payoutAmount=money(b.amount),currency;
    if(commission) {const x=(await c.query('select * from agency_commissions where id=$1 and organization_id=$2 for update',[commission,org])).rows[0];if(!x) fail('Comisión no encontrada',404);if(x.status!=='approved') fail('La comisión debe estar aprobada y sin pagar',409);payoutAmount=Number(x.amount);currency=x.currency;}
    else {const x=(await c.query('select * from agency_collaborators where id=$1 and organization_id=$2',[collaborator,org])).rows[0];if(!x) fail('Colaborador no encontrado',404);currency=x.currency;}
    const a=(await c.query('select * from bank_accounts where id=$1 and organization_id=$2 and active=true for update',[account,org])).rows[0];if(!a||a.currency!==currency) fail('La cuenta debe estar activa y usar la misma moneda');if(Number(a.balance)<payoutAmount) fail('Saldo insuficiente');
    const reference=text(b.reference,180),paid=date(b.paid_on);if(!reference||!paid) fail('Indicá fecha y referencia del pago');
    result={payout:(await c.query('insert into agency_payouts(organization_id,collaborator_id,commission_id,account_id,amount,paid_on,reference,created_by_user_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[org,collaborator,commission,account,payoutAmount,paid,reference,user.id])).rows[0]};
    await c.query('update bank_accounts set balance=balance-$1,updated_at=now() where id=$2 and organization_id=$3',[payoutAmount,account,org]);
    if(commission) await c.query("update agency_commissions set status='paid',paid_on=$1 where id=$2 and organization_id=$3",[paid,commission,org]);status=201;
   } else fail('Método no permitido',405);
  }
  await attributeActors(c,org,[
   {rows:result.comments||result.comment,userId:'author_user_id',fallback:['author_email']},
   {rows:[...(result.payouts||[]),result.payout,...(result.discounts||[]),result.discount],userId:'created_by_user_id',fallback:['created_by_email']},
  ]);
  await c.query('commit');
  if(notifyEmail)result.access.emailSent=await sendInvitation(notifyEmail,user.organization_name||'tu empresa','viewer').catch(()=>false);
  send(res,status,result);
 } catch(error) {await c.query('rollback');console.error(JSON.stringify({event:'operations_error',path:url.pathname,code:error.code||error.status||500}));send(res,error.code==='23505'?409:error.status||500,{error:error.code==='23505'?'Ya existe un registro con esos datos':error.status?error.message:'No se pudo completar la operación'});}
 finally {c.release();}
 return true;
}
