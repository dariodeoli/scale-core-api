import { collaboratorAccess } from './collaborator-access.js';
import { profilePhoto } from './media-policy.js';
const financeRoles = ['owner','admin','finance'];
function fail(message, status=400) { throw Object.assign(new Error(message),{status}); }
const text = (value, max=2000) => typeof value==='string' && value.length<=max ? value.trim() : fail('Texto inválido');
const identifier = value => /^\d+$/.test(String(value)) && Number(value)>0 ? String(value) : fail('Identificador inválido');
const optionalId = value => value===null || value===undefined || value==='' ? null : identifier(value);
function money(value, zero=false) { const n=Number(value); if(!Number.isFinite(n)||n<0||(!zero&&n===0)||n>999999999999) fail('Importe inválido'); return Math.round(n*100)/100; }
function date(value) { if(!value) return null; const parsed=new Date(value); if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(parsed.getTime())||parsed.toISOString().slice(0,10)!==value) fail('Fecha inválida'); return value; }
const option = (value, choices) => choices.includes(value) ? value : fail('Opción inválida');
const email = value => !value ? null : /^\S+@\S+\.\S+$/.test(value) ? text(value,254).toLowerCase() : fail('Email inválido');
async function belongs(c,table,id,org) { if(id && !(await c.query(`select id from ${table} where id=$1 and organization_id=$2`,[id,org])).rows.length) fail('Registro no encontrado',404); }
export async function operations({req,res,url,db,session,body,send,sendInvitation=async()=>false}) {
 const commentMatch=url.pathname.match(/^\/api\/agency\/projects\/(\d+)\/comments$/);
 const collaboratorMatch=url.pathname.match(/^\/api\/agency\/collaborators(?:\/(\d+))?$/);
 const commissionMatch=url.pathname.match(/^\/api\/agency\/commissions(?:\/(\d+))?$/);
 const payoutRoute=url.pathname==='/api/agency/payouts';
 const discountMatch=url.pathname.match(/^\/api\/agency\/referral-discounts(?:\/(\d+))?$/);
 const jobMatch=url.pathname.match(/^\/api\/agency\/job-roles(?:\/(\d+))?$/);
 if(!commentMatch&&!collaboratorMatch&&!commissionMatch&&!payoutRoute&&!discountMatch&&!jobMatch) return false;
 const user=await session(req);
 if(!user) {send(res,401,{error:'No autenticado'});return true;}
 const allowed=commentMatch ? req.method==='GET'||user.role!=='viewer' : jobMatch&&req.method!=='GET' ? ['owner','admin'].includes(user.role) : financeRoles.includes(user.role);
 if(!allowed) {send(res,403,{error:'Tu rol no permite esta operación'});return true;}
 const c=await db.connect();
 try {
  await c.query('begin');
  await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
  const org=user.organization_id;
  let result, status=200, notifyEmail=null;
  if(jobMatch) {
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
    else invoiceId=identifier(b.invoice_id);
    const i=(await c.query('select * from agency_invoices where id=$1 and organization_id=$2 for update',[invoiceId,org])).rows[0];if(!i)fail('Factura no encontrada',404);if(i.status==='cancelled')fail('Factura cancelada');
    const amount=existing?Number(existing.amount):money(b.amount);const total=Math.round((Number(i.total)+(existing?amount:-amount))*100)/100;
    if(total<Number(i.paid_amount)||total<0)fail('El descuento supera el saldo pendiente');
    if(existing)result={discount:(await c.query("update agency_referral_discounts set status='reversed' where id=$1 and organization_id=$2 returning *",[existing.id,org])).rows[0]};
    else{const referrer=text(b.referrer,120),reason=text(b.reason,500);if(!referrer||!reason)fail('Indicá quién refirió y el motivo');result={discount:(await c.query('insert into agency_referral_discounts(organization_id,invoice_id,referrer,amount,reason,created_by_user_id) values($1,$2,$3,$4,$5,$6) returning *',[org,invoiceId,referrer,amount,reason,user.id])).rows[0]};status=201;}
    await c.query("update agency_invoices set total=$1,status=case when paid_amount >= $1 then 'paid' when paid_amount>0 then 'partial' else 'issued' end,updated_at=now() where id=$2 and organization_id=$3",[total,invoiceId,org]);
   }else fail('Método no permitido',405);
  } else if(commentMatch) {
   await belongs(c,'agency_projects',commentMatch[1],org);
   if(req.method==='GET') result={comments:(await c.query('select c.*,u.email as author_email from agency_project_comments c left join users u on u.id=c.author_user_id where c.organization_id=$1 and c.project_id=$2 order by c.created_at,c.id',[org,commentMatch[1]])).rows};
   else if(req.method==='POST') {const b=text((await body(req)).body);if(!b) fail('Escribí un comentario');result={comment:(await c.query('insert into agency_project_comments(organization_id,project_id,author_user_id,body) values($1,$2,$3,$4) returning *',[org,commentMatch[1],user.id,b])).rows[0]};status=201;}
   else fail('Método no permitido',405);
  } else if(collaboratorMatch) {
   if(req.method==='GET') result={collaborators:(await c.query('select c.*,u.email as access_email from agency_collaborators c left join users u on u.id=c.user_id where c.organization_id=$1 order by c.active desc,c.full_name',[org])).rows};
   else if(req.method==='POST'||(req.method==='PATCH'&&collaboratorMatch[1])) {
    let previous={};if(collaboratorMatch[1]){previous=(await c.query('select * from agency_collaborators where id=$1 and organization_id=$2 for update',[collaboratorMatch[1],org])).rows[0];if(!previous)fail('Registro no encontrado',404);}
    const incoming=await body(req), b={compensation_type:'fixed',compensation_amount:0,currency:'PYG',active:true,...previous,...incoming};
    const name=text(b.full_name,120);if(name.length<2) fail('Ingresá el nombre');
    for(const key of ['started_on','ended_on'])if(b[key] instanceof Date)b[key]=b[key].toISOString().slice(0,10);
    const contact=email(b.email);let uid=optionalId(b.user_id);
    if(uid&&String(uid)!==String(previous.user_id||'')&&!['owner','admin'].includes(user.role))fail('Solo administración puede vincular accesos',403);
    if(uid&&!(await c.query('select 1 from organization_members where organization_id=$1 and user_id=$2',[org,uid])).rows.length) fail('El acceso debe pertenecer a esta empresa');
    if(uid&&contact){const linked=(await c.query('select email from users where id=$1',[uid])).rows[0];if(linked.email!==contact){if(incoming.user_id)fail('El acceso debe coincidir con el correo de contacto');uid=null;}}
    const jobId=optionalId(b.job_role_id);let jobTitle=text(b.job_title||'',120);
    if(Object.hasOwn(incoming,'job_role_id')&&!jobId)jobTitle='';
    if(jobId){const j=(await c.query('select * from agency_job_roles where id=$1 and organization_id=$2',[jobId,org])).rows[0];if(!j||(!j.active&&String(jobId)!==String(previous.job_role_id)))fail('Elegí un cargo activo de esta empresa');jobTitle=j.name;}
    const photo=Object.hasOwn(incoming,'photo_url') ? await profilePhoto(incoming.photo_url) : previous.photo_url || null;
    const day=b.payment_day?Number(b.payment_day):null;if(day!==null&&(!Number.isInteger(day)||day<1||day>31)) fail('Día de pago inválido');
    const start=date(b.started_on),end=date(b.ended_on);if(start&&end&&end<start) fail('La salida no puede ser anterior al ingreso');
    const access=await collaboratorAccess(c,{email:contact,org,actorRole:user.role,active:b.active!==false,previousUserId:uid});uid=access.userId;notifyEmail=access.notifyEmail;
    const values=[org,uid,name,contact,photo||null,jobTitle,option(b.compensation_type,['fixed','variable','hourly','per_project']),money(b.compensation_amount,true),Boolean(b.invoices_company),start,day,b.active!==false,text(b.notes||''),option(b.currency,['PYG','USD']),end];
    if(collaboratorMatch[1]) {await belongs(c,'agency_collaborators',collaboratorMatch[1],org);values.push(collaboratorMatch[1]);result={collaborator:(await c.query('update agency_collaborators set user_id=$2,full_name=$3,email=$4,photo_url=$5,job_title=$6,compensation_type=$7,compensation_amount=$8,invoices_company=$9,started_on=$10,payment_day=$11,active=$12,notes=$13,currency=$14,ended_on=$15,updated_at=now() where organization_id=$1 and id=$16 returning *',values)).rows[0]};}
    else {result={collaborator:(await c.query('insert into agency_collaborators(organization_id,user_id,full_name,email,photo_url,job_title,compensation_type,compensation_amount,invoices_company,started_on,payment_day,active,notes,currency,ended_on) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *',values)).rows[0]};status=201;}
    result.collaborator=(await c.query('update agency_collaborators set job_role_id=$1 where id=$2 and organization_id=$3 returning *',[jobId,result.collaborator.id,org])).rows[0];result.access={status:access.status};
   } else fail('Método no permitido',405);
  } else if(commissionMatch) {
   if(req.method==='GET') result={commissions:(await c.query('select x.*,i.number as invoice_number,c.full_name as collaborator_name from agency_commissions x left join agency_invoices i on i.id=x.invoice_id left join agency_collaborators c on c.id=x.collaborator_id where x.organization_id=$1 order by x.created_at desc',[org])).rows};
   else if(req.method==='POST') {
    const b=await body(req), invoice=optionalId(b.invoice_id),collaborator=optionalId(b.collaborator_id),basis=option(b.basis,['fixed','invoiced','collected']);
    await belongs(c,'agency_collaborators',collaborator,org);await belongs(c,'agency_invoices',invoice,org);
    let base=null,percent=null,amount=money(b.amount,true),currency=option(b.currency,['PYG','USD']);
    if(invoice) {const i=(await c.query('select * from agency_invoices where id=$1 and organization_id=$2 for update',[invoice,org])).rows[0];currency=i.currency;base=Number(basis==='collected'?i.paid_amount:i.total);if(i.status==='cancelled') fail('Factura cancelada');}
    if(basis!=='fixed') {if(!invoice) fail('Elegí una factura para calcular el porcentaje');percent=money(b.percentage);if(percent>100) fail('Porcentaje máximo: 100');amount=Math.round(base*percent)/100;}
    if(amount<=0) fail('La comisión debe ser mayor a cero');
    const name=text(b.beneficiary_name,120);if(!name) fail('Ingresá el beneficiario');
    result={commission:(await c.query('insert into agency_commissions(organization_id,invoice_id,collaborator_id,kind,beneficiary_name,percentage,amount,currency,due_on,notes,basis,base_amount) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning *',[org,invoice,collaborator,option(b.kind,['sales','referral']),name,percent,amount,currency,date(b.due_on),text(b.notes||''),basis,base])).rows[0]};status=201;
   } else if(req.method==='PATCH'&&commissionMatch[1]) {
    const b=await body(req), next=option(b.status,['approved','cancelled']);
    const row=(await c.query("update agency_commissions set status=$1 where id=$2 and organization_id=$3 and status in ('pending','approved') returning *",[next,commissionMatch[1],org])).rows[0];if(!row) fail('La comisión no está disponible para cambiar de estado',409);result={commission:row};
   } else fail('Método no permitido',405);
  } else if(payoutRoute) {
   if(req.method==='GET') result={payouts:(await c.query('select p.*,a.name as account_name,a.currency,c.full_name as collaborator_name,x.beneficiary_name,u.email as created_by_email from agency_payouts p join bank_accounts a on a.id=p.account_id left join agency_collaborators c on c.id=p.collaborator_id left join agency_commissions x on x.id=p.commission_id left join users u on u.id=p.created_by_user_id where p.organization_id=$1 order by p.paid_on desc,p.id desc',[org])).rows};
   else if(req.method==='POST') {
    const b=await body(req),commission=optionalId(b.commission_id),collaborator=optionalId(b.collaborator_id),account=identifier(b.account_id);
    if(Boolean(commission)===Boolean(collaborator)) fail('Elegí una comisión o un colaborador');
    let amount=money(b.amount),currency;
    if(commission) {const x=(await c.query('select * from agency_commissions where id=$1 and organization_id=$2 for update',[commission,org])).rows[0];if(!x) fail('Comisión no encontrada',404);if(x.status!=='approved') fail('La comisión debe estar aprobada y sin pagar',409);amount=Number(x.amount);currency=x.currency;}
    else {const x=(await c.query('select * from agency_collaborators where id=$1 and organization_id=$2',[collaborator,org])).rows[0];if(!x) fail('Colaborador no encontrado',404);currency=x.currency;}
    const a=(await c.query('select * from bank_accounts where id=$1 and organization_id=$2 and active=true for update',[account,org])).rows[0];if(!a||a.currency!==currency) fail('La cuenta debe estar activa y usar la misma moneda');if(Number(a.balance)<amount) fail('Saldo insuficiente');
    const reference=text(b.reference,180),paid=date(b.paid_on);if(!reference||!paid) fail('Indicá fecha y referencia del pago');
    result={payout:(await c.query('insert into agency_payouts(organization_id,collaborator_id,commission_id,account_id,amount,paid_on,reference,created_by_user_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[org,collaborator,commission,account,amount,paid,reference,user.id])).rows[0]};
    await c.query('update bank_accounts set balance=balance-$1,updated_at=now() where id=$2 and organization_id=$3',[amount,account,org]);
    if(commission) await c.query("update agency_commissions set status='paid',paid_on=$1 where id=$2 and organization_id=$3",[paid,commission,org]);status=201;
   } else fail('Método no permitido',405);
  }
  await c.query('commit');
  if(notifyEmail)result.access.emailSent=await sendInvitation(notifyEmail,user.organization_name||'tu empresa','viewer').catch(()=>false);
  send(res,status,result);
 } catch(error) {await c.query('rollback');console.error(JSON.stringify({event:'operations_error',path:url.pathname,code:error.code||error.status||500}));send(res,error.code==='23505'?409:error.status||500,{error:error.code==='23505'?'Ya existe un registro con esos datos':error.status?error.message:'No se pudo completar la operación'});}
 finally {c.release();}
 return true;
}
