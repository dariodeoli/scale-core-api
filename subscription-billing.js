import {createHmac,timingSafeEqual,randomUUID} from 'node:crypto';

const DAY=86400000,GRACE=2*DAY,VERSION='2025-03-31.basil';
const plans={USD:{amount:10,minor:1000},PYG:{amount:50000,minor:50000}};
const fail=(message,status=400,code='BILLING_INVALID')=>{throw Object.assign(new Error(message),{status,code});};
const orgId=value=>{if(!/^[1-9]\d{0,18}$/.test(String(value))||BigInt(value)>9223372036854775807n)fail('Empresa inválida');return String(value);};
const objectId=(value,prefix)=>{const id=typeof value==='object'&&value?value.id:value;if(typeof id!=='string'||!new RegExp(`^${prefix}_[A-Za-z0-9_]+$`).test(id))fail('Referencia de Stripe inválida');return id;};
const iso=value=>value==null?null:new Date(value).toISOString();
const demo=org=>Boolean(org.demo_owner_user_id||org.demo_source_id||org.slug==='scale-demo-controles-20260908');
function config(){
 const env=process.env,key=env.STRIPE_SECRET_KEY||'',whsec=env.STRIPE_WEBHOOK_SECRET||'';
 let origin=null;
 try{const parsed=new URL(env.BILLING_APP_ORIGIN);if(parsed.protocol==='https:'&&!parsed.username&&!parsed.password&&parsed.pathname==='/'&&!parsed.search&&!parsed.hash)origin=parsed.origin;}catch{}
 const prices={USD:env.STRIPE_PRICE_USD,PYG:env.STRIPE_PRICE_PYG},product=env.STRIPE_PRODUCT_ID;
 const ready=env.STRIPE_BILLING_ENABLED==='true'&&/^sk_(test|live)_[A-Za-z0-9]+$/.test(key)&&/^whsec_[A-Za-z0-9]+$/.test(whsec)&&Object.values(prices).every(p=>/^price_[A-Za-z0-9]+$/.test(p||''))&&prices.USD!==prices.PYG&&/^prod_[A-Za-z0-9]+$/.test(product||'')&&Boolean(origin);
 return {ready,key,whsec,prices,product,origin,live:key.startsWith('sk_live_')};
}
function configured(){const cfg=config();if(!cfg.ready)fail('Cobro por Stripe todavía no configurado',503,'BILLING_NOT_CONFIGURED');return cfg;}

async function actor(db,user,owner=false){
 if(!user)fail('No autenticado',401,'BILLING_UNAUTHENTICATED');
 const row=(await db.query(`select o.*,m.role as member_role from organizations o join organization_members m on m.organization_id=o.id
  where o.id=$1 and m.user_id=$2 and o.active and m.active and m.removed_at is null`,[orgId(user.organization_id),orgId(user.id)])).rows[0];
 if(!row)fail('Sin acceso activo a esta empresa',403,'BILLING_FORBIDDEN');
 if(owner&&(user.role!=='owner'||row.member_role!=='owner'))fail('Solo el owner puede gestionar la suscripción',403,'BILLING_OWNER_REQUIRED');
 return row;
}

// Call explicitly for NEW organizations, preferably on the signup transaction's
// client. It never enrolls existing organizations implicitly, and never resets.
export async function startTrial(db,organizationId,currency='USD'){
 if(!Object.hasOwn(plans,currency))fail('La suscripción admite USD o PYG');
 const id=orgId(organizationId);
 const org=(await db.query('select * from organizations where id=$1',[id])).rows[0];
 if(!org)fail('Empresa no encontrada',404);
 if(demo(org))return null;
 await db.query(`insert into organization_subscriptions(organization_id,currency,binding_token) values($1,$2,$3) on conflict(organization_id) do nothing`,[id,currency,randomUUID()]);
 const row=(await db.query('select currency,trial_ends_at from organization_subscriptions where organization_id=$1',[id])).rows[0];
 return {currency:row.currency,trialEndsAt:iso(row.trial_ends_at)};
}

export async function subscriptionState(db,user,now=new Date()){
 const org=await actor(db,user),isDemo=demo(org);
 const row=isDemo?null:(await db.query('select * from organization_subscriptions where organization_id=$1',[org.id])).rows[0];
 const currency=row?.currency||'USD',timestamp=new Date(now).getTime();if(!Number.isFinite(timestamp))fail('Fecha inválida');
 let status=isDemo?'demo':'unmanaged',due=null,suspend=null,remaining=null;
 if(row){
  due=new Date(row.due_at).getTime();suspend=due+GRACE;
  status=timestamp<new Date(row.trial_ends_at).getTime()?'trialing':row.paid_through_at&&timestamp<new Date(row.paid_through_at).getTime()?'active':timestamp<suspend?'grace':'suspended';
  remaining=Math.max(0,Math.ceil(((status==='trialing'?new Date(row.trial_ends_at).getTime():status==='active'?due:suspend)-timestamp)/DAY));
 }
 const canManage=!isDemo&&user.role==='owner'&&org.member_role==='owner',checkoutReady=Boolean(row&&!isDemo&&config().ready);
 // Availability only: never expose provider IDs or infer a paid entitlement.
 const portalReady=Boolean(canManage&&checkoutReady&&row?.stripe_customer_id&&row?.stripe_subscription_id);
 return {status,hasAccess:status!=='suspended',currency,amount:plans[currency].amount,trialEndsAt:row?iso(row.trial_ends_at):null,dueAt:iso(due),suspendAt:iso(suspend),daysRemaining:remaining,
  canManage,checkoutReady,portalReady};
}

async function transaction(db,work){const c=await db.connect();try{await c.query('begin');const result=await work(c);await c.query('commit');return result;}catch(error){await c.query('rollback');throw error;}finally{c.release();}}
async function locked(c,id){const row=(await c.query('select * from organization_subscriptions where organization_id=$1 for update',[id])).rows[0];if(!row)fail('Esta empresa no está adherida al cobro por suscripción',409,'BILLING_UNMANAGED');return row;}
async function stripe(cfg,path,parameters=null,key=null){
 // The host is not configurable. Never use URLs from clients, webhooks or Stripe
 // metadata as fetch targets. Do not follow redirects carrying authorization.
 const headers={Authorization:`Bearer ${cfg.key}`,'Stripe-Version':VERSION};
 if(parameters){headers['Content-Type']='application/x-www-form-urlencoded';if(key)headers['Idempotency-Key']=key;}
 let response,result;
 try{response=await fetch(`https://api.stripe.com/v1/${path}`,{method:parameters?'POST':'GET',headers,...(parameters?{body:new URLSearchParams(parameters)}:{}),redirect:'error',signal:AbortSignal.timeout(8000)});result=await response.json();}catch{fail('Stripe no respondió; reintentá sin crear otra operación',503,'BILLING_PROVIDER_UNAVAILABLE');}
 if(!response.ok)fail('No se pudo verificar la operación en Stripe',503,'BILLING_PROVIDER_UNAVAILABLE');
 return result;
}
function sameMode(value,cfg){if(value.livemode!==cfg.live)fail('Modo Stripe incompatible',409,'BILLING_BINDING_MISMATCH');}
function priceValid(price,row,cfg){
 sameMode(price,cfg);
 if(price.id!==cfg.prices[row.currency]||objectId(price.product,'prod')!==cfg.product||price.currency!==row.currency.toLowerCase()||price.unit_amount!==plans[row.currency].minor||price.type!=='recurring'||price.billing_scheme!=='per_unit'||price.recurring?.interval!=='month'||price.recurring?.interval_count!==1||price.recurring?.usage_type!=='licensed'||price.transform_quantity||price.custom_unit_amount)fail('El precio configurado no corresponde al plan mensual',409,'BILLING_PRICE_MISMATCH');
}
function stripeUrl(value,host){let url;try{url=new URL(value);}catch{fail('Stripe no devolvió un enlace válido',503);}if(url.protocol!=='https:'||url.hostname!==host||url.port||url.username||url.password)fail('Stripe no devolvió un enlace válido',503);return url.href;}
function metadata(row,attempt){return {'metadata[organization_id]':String(row.organization_id),'metadata[binding_token]':row.binding_token,'metadata[attempt_id]':attempt};}
function subscriptionValid(sub,row,cfg,customer){
 sameMode(sub,cfg);objectId(sub.id,'sub');
 if(objectId(sub.customer,'cus')!==customer||sub.metadata?.organization_id!==String(row.organization_id)||sub.metadata?.binding_token!==row.binding_token||row.stripe_subscription_id&&sub.id!==row.stripe_subscription_id||sub.collection_method!=='charge_automatically'||sub.items?.has_more||sub.items?.data?.length!==1||sub.items.data[0].quantity!==1)fail('Suscripción no vinculada al plan de esta empresa',409,'BILLING_BINDING_MISMATCH');
 priceValid(sub.items.data[0].price,row,cfg);
 return sub.items.data[0];
}
async function verifyCheckout(c,cfg,row,attempt,session){
 sameMode(session,cfg);
 if(session.mode!=='subscription'||session.client_reference_id!==String(row.organization_id)||session.metadata?.binding_token!==row.binding_token||session.metadata?.attempt_id!==attempt.id||session.metadata?.organization_id!==String(row.organization_id)||attempt.stripe_session_id&&session.id!==attempt.stripe_session_id)fail('Checkout no vinculado a esta empresa',409,'BILLING_BINDING_MISMATCH');
 objectId(session.id,'cs');
 if(!attempt.stripe_session_id)await c.query('update subscription_checkout_attempts set stripe_session_id=$1 where id=$2',[session.id,attempt.id]);
 if(session.status!=='complete')return null;
 const customer=objectId(session.customer,'cus'),subId=objectId(session.subscription,'sub');
 if(row.stripe_customer_id&&row.stripe_customer_id!==customer||row.stripe_subscription_id&&row.stripe_subscription_id!==subId)fail('Checkout ajeno a la vinculación existente',409,'BILLING_BINDING_MISMATCH');
 const sub=await stripe(cfg,`subscriptions/${subId}`);subscriptionValid(sub,row,cfg,customer);
 await c.query('update organization_subscriptions set stripe_customer_id=$1,stripe_subscription_id=$2,updated_at=now() where organization_id=$3',[customer,subId,row.organization_id]);
 await c.query('update subscription_checkout_attempts set closed=true where id=$1',[attempt.id]);
 row.stripe_customer_id=customer;row.stripe_subscription_id=subId;
 return sub;
}

async function checkout(db,user,cfg,requestedCurrency){
 // Prepare and COMMIT the immutable request before contacting Stripe, so a
 // response lost after provider success is retried with the same key/parameters.
 const prepared=await transaction(db,async c=>{
  const org=await actor(c,user,true);if(demo(org))fail('Las demos están exentas de cobro',409,'BILLING_DEMO');
  const row=await locked(c,org.id);
  if(requestedCurrency!==undefined&&requestedCurrency!==row.currency)fail('La moneda de la suscripción es la elegida al crear la empresa y no se cambia desde checkout.',409,'BILLING_CURRENCY_LOCKED');
  if(row.stripe_subscription_id)fail('La suscripción ya existe; usá el portal',409,'BILLING_USE_PORTAL');
  const previous=(await c.query('select * from subscription_checkout_attempts where organization_id=$1 and not closed',[org.id])).rows[0];
  if(previous)return previous;
  const seconds=Math.floor(new Date(row.trial_ends_at).getTime()/1000),now=Math.floor(Date.now()/1000),remaining=seconds-now;
  // Checkout's minimum trial window is not permission to extend our trial or
  // charge before it ends. Owners can return when the original trial finishes.
  if(remaining>0&&remaining<49*3600)fail('La prueba termina pronto. Podrás contratar al finalizar, sin adelantar el cobro ni extender la prueba.',409,'BILLING_TRIAL_ENDING');
  const id=randomUUID(),params={mode:'subscription','line_items[0][price]':cfg.prices[row.currency],'line_items[0][quantity]':'1',client_reference_id:String(org.id),
   success_url:`${cfg.origin}/?billing=success`,cancel_url:`${cfg.origin}/?billing=cancelled`,payment_method_collection:'always','payment_method_types[0]':'card',
   'allow_promotion_codes':'false','automatic_tax[enabled]':'false',expires_at:String(now+1800),...metadata(row,id),
   'subscription_data[metadata][organization_id]':String(org.id),'subscription_data[metadata][binding_token]':row.binding_token,
   'custom_text[submit][message]':`Suscripción mensual recurrente: ${plans[row.currency].amount} ${row.currency}. Se renueva hasta cancelar desde el portal.`};
  if(remaining>0)params['subscription_data[trial_end]']=String(seconds);
  if(row.stripe_customer_id)params.customer=row.stripe_customer_id;
  return (await c.query('insert into subscription_checkout_attempts(id,organization_id,parameters) values($1,$2,$3) returning *',[id,org.id,JSON.stringify(params)])).rows[0];
 });
 return transaction(db,async c=>{
  await actor(c,user,true);const row=await locked(c,user.organization_id);
  const attempt=(await c.query('select * from subscription_checkout_attempts where id=$1',[prepared.id])).rows[0];
  if(row.stripe_subscription_id||attempt.closed)fail('La operación ya terminó; consultá el estado o el portal',409,'BILLING_USE_PORTAL');
  let session;
  if(attempt.stripe_session_id)session=await stripe(cfg,`checkout/sessions/${objectId(attempt.stripe_session_id,'cs')}`);
  else{
   if(Date.now()-new Date(attempt.created_at).getTime()>23*3600000)fail('Operación de resultado incierto; requiere conciliación antes de reintentar',409,'BILLING_RECONCILIATION_REQUIRED');
   if(attempt.parameters['line_items[0][price]']!==cfg.prices[row.currency])fail('La configuración cambió; requiere conciliación',409,'BILLING_RECONCILIATION_REQUIRED');
   const price=await stripe(cfg,`prices/${cfg.prices[row.currency]}`);priceValid(price,row,cfg);if(!price.active)fail('Precio no disponible',409,'BILLING_PRICE_MISMATCH');
   session=await stripe(cfg,'checkout/sessions',attempt.parameters,`scale-checkout-${attempt.id}`);
  }
  const sub=await verifyCheckout(c,cfg,row,attempt,session);
  if(sub){await reconcile(c,cfg,row,sub);return {completed:true};}
  if(session.status==='expired'){await c.query('update subscription_checkout_attempts set closed=true where id=$1',[attempt.id]);return {expired:true};}
  if(session.status!=='open'||!Number.isFinite(session.expires_at)||session.expires_at*1000<=Date.now())fail('Checkout no disponible',409,'BILLING_RECONCILIATION_REQUIRED');
  return {url:stripeUrl(session.url,'checkout.stripe.com')};
 });
}

function invoiceSubscription(invoice){return objectId(invoice.parent?.subscription_details?.subscription,'sub');}
function paidPeriod(invoice,sub,row,cfg){
 sameMode(invoice,cfg);
 if(invoiceSubscription(invoice)!==sub.id||objectId(invoice.customer,'cus')!==row.stripe_customer_id||invoice.currency!==row.currency.toLowerCase())fail('Factura ajena a la suscripción',409,'BILLING_INVOICE_MISMATCH');
 // No zero-dollar trial, credit, manual paid-out-of-band, discount, proration,
 // unrelated product or partial payment may manufacture a paid entitlement.
 if(invoice.status!=='paid')return null;
 if(invoice.amount_paid===0&&invoice.amount_due===0)return null;
 const line=invoice.lines?.data?.[0],item=sub.items.data[0];
 if(invoice.paid_out_of_band||invoice.amount_paid!==plans[row.currency].minor||invoice.amount_due!==plans[row.currency].minor||invoice.total!==plans[row.currency].minor||invoice.amount_remaining!==0||!['subscription_create','subscription_cycle'].includes(invoice.billing_reason)||invoice.collection_method!=='charge_automatically'||invoice.lines?.has_more||invoice.lines?.data?.length!==1||!line||line.amount!==plans[row.currency].minor||line.currency!==row.currency.toLowerCase()||line.quantity!==1||line.parent?.type!=='subscription_item_details'||line.parent.subscription_item_details.proration!==false||line.parent.subscription_item_details.subscription!==sub.id||line.parent.subscription_item_details.subscription_item!==item.id||line.pricing?.price_details?.price!==cfg.prices[row.currency]||line.pricing?.price_details?.product!==cfg.product)fail('Factura incompatible con el plan mensual',409,'BILLING_INVOICE_MISMATCH');
 const {start,end}=line.period||{};
 if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start||end-start<27*86400||end-start>32*86400||start*1000>Date.now()+300000)fail('Periodo facturado inválido',409,'BILLING_INVOICE_MISMATCH');
 if(invoice.id===objectId(sub.latest_invoice,'in')&&(start!==item.current_period_start||end!==item.current_period_end))fail('La factura no cubre el periodo mensual actual',409,'BILLING_INVOICE_MISMATCH');
 return {start:new Date(start*1000),end:new Date(end*1000)};
}
async function reconcile(c,cfg,row,sub,eventInvoice=null){
 subscriptionValid(sub,row,cfg,row.stripe_customer_id);
 const ids=new Set();if(eventInvoice)ids.add(objectId(eventInvoice,'in'));if(sub.latest_invoice)ids.add(objectId(sub.latest_invoice,'in'));
 for(const id of ids){
  const invoice=await stripe(cfg,`invoices/${id}`);if(invoice.id!==id)fail('Factura inválida',409,'BILLING_INVOICE_MISMATCH');
  const period=paidPeriod(invoice,sub,row,cfg);if(!period)continue;
  const inserted=(await c.query(`insert into subscription_paid_invoices(invoice_id,organization_id,stripe_subscription_id,period_start,period_end,amount_minor,currency)
   values($1,$2,$3,$4,$5,$6,$7) on conflict(invoice_id) do nothing returning invoice_id`,[id,row.organization_id,sub.id,period.start,period.end,plans[row.currency].minor,row.currency])).rows[0];
  if(inserted)await c.query(`update organization_subscriptions set paid_through_at=greatest(paid_through_at,$1),due_at=greatest(due_at,$1),updated_at=now() where organization_id=$2`,[period.end,row.organization_id]);
 }
 // Informational only. Access is derived from verified paid periods, not the
 // incoming event's status/created date or Stripe's automatic retry schedule.
 await c.query('update organization_subscriptions set stripe_status=$1,updated_at=now() where organization_id=$2',[sub.status,row.organization_id]);
}

async function signedEvent(req,cfg){
 const header=req.headers?.['stripe-signature'];if(typeof header!=='string'||header.length>4096)fail('Firma requerida',400,'BILLING_SIGNATURE_INVALID');
 const entries=header.split(',').map(s=>s.trim().split('=')),times=entries.filter(([key])=>key==='t');
 if(times.length!==1||!/^\d+$/.test(times[0][1]))fail('Firma inválida',400,'BILLING_SIGNATURE_INVALID');
 const timestamp=Number(times[0][1]);if(!Number.isSafeInteger(timestamp)||Math.abs(Date.now()/1000-timestamp)>300)fail('Firma vencida',400,'BILLING_SIGNATURE_INVALID');
 let raw;
 if(Buffer.isBuffer(req.rawBody))raw=req.rawBody;
 else{const parts=[];let length=0;for await(const chunk of req){const part=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);length+=part.length;if(length>262144)fail('Webhook demasiado grande',413);parts.push(part);}raw=Buffer.concat(parts);}
 if(raw.length>262144)fail('Webhook demasiado grande',413);
 const expected=createHmac('sha256',cfg.whsec).update(`${timestamp}.`).update(raw).digest();
 const matches=entries.filter(([key,signature])=>key==='v1'&&/^[a-f0-9]{64}$/i.test(signature||'')).some(([,signature])=>timingSafeEqual(expected,Buffer.from(signature,'hex')));
 if(!matches)fail('Firma inválida',400,'BILLING_SIGNATURE_INVALID');
 let event;try{event=JSON.parse(raw.toString('utf8'));}catch{fail('JSON inválido');}
 objectId(event?.id,'evt');if(!event.data?.object||typeof event.type!=='string'||!Number.isSafeInteger(event.created)||event.created>Date.now()/1000+300||event.account||event.context)fail('Evento no admitido');
 sameMode(event,cfg);return event;
}
async function webhook(db,req,cfg){
 const event=await signedEvent(req,cfg),supported=['checkout.session.completed','checkout.session.async_payment_succeeded','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','invoice.paid','invoice.payment_succeeded','invoice.payment_failed'];
 if(!supported.includes(event.type))return {received:true,ignored:true};
 return transaction(db,async c=>{
  const inserted=(await c.query('insert into subscription_stripe_events(event_id,event_type,event_created) values($1,$2,$3) on conflict do nothing returning event_id',[event.id,event.type,event.created])).rows[0];
  if(!inserted)return {received:true,duplicate:true};
  const obj=event.data.object;let row,sub,eventInvoice=null;
  if(event.type.startsWith('checkout.')){
   const candidate=typeof obj.metadata?.attempt_id==='string'&&/^[0-9a-f-]{36}$/i.test(obj.metadata.attempt_id)?(await c.query('select * from subscription_checkout_attempts where id=$1',[obj.metadata.attempt_id])).rows[0]:null;
   if(!candidate)return {received:true,ignored:true};
   row=await locked(c,candidate.organization_id);
   const session=await stripe(cfg,`checkout/sessions/${objectId(obj.id,'cs')}`);
   sub=await verifyCheckout(c,cfg,row,candidate,session);
   if(!sub)fail('Checkout todavía no completado',409,'BILLING_BINDING_MISMATCH');
  }else{
   // Unknown subscriptions never enroll an org or bind from untrusted metadata.
   // Checkout completion establishes the binding and reconciles its latest bill.
   let subId;
   if(event.type.startsWith('invoice.')){eventInvoice=objectId(obj.id,'in');subId=invoiceSubscription(obj);}else subId=objectId(obj.id,'sub');
   const found=(await c.query('select organization_id from organization_subscriptions where stripe_subscription_id=$1',[subId])).rows[0];
   if(!found)return {received:true,ignored:true};
   row=await locked(c,found.organization_id);sub=await stripe(cfg,`subscriptions/${subId}`);
  }
  await reconcile(c,cfg,row,sub,eventInvoice);
  await c.query('update subscription_stripe_events set organization_id=$1 where event_id=$2',[row.organization_id,event.id]);
  return {received:true};
 });
}

export async function subscriptionBilling({req,res,url,db,session,body,send}){
 const path=url.pathname;if(!['/api/billing/subscription','/api/billing/checkout','/api/billing/portal','/api/billing/webhook'].includes(path))return false;
 try{
  if(path==='/api/billing/webhook'){
   if(req.method!=='POST')fail('Método no permitido',405);
   send(res,200,await webhook(db,req,configured()));return true;
  }
  const user=await session(req);await actor(db,user,path!=='/api/billing/subscription');
  if(path==='/api/billing/subscription'){
   if(req.method!=='GET')fail('Método no permitido',405);
   send(res,200,await subscriptionState(db,user));return true;
  }
  if(req.method!=='POST')fail('Método no permitido',405);
  const input=await body(req);if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>path!=='/api/billing/checkout'||key!=='currency'))fail('El plan y la empresa se determinan en el servidor');
  if(Object.hasOwn(input,'currency')&&!Object.hasOwn(plans,input.currency))fail('La suscripción admite USD o PYG');
  const cfg=configured();
  if(path==='/api/billing/checkout'){
   const result=await checkout(db,user,cfg,input.currency);send(res,result.expired?409:200,result.expired?{error:'Checkout vencido. Volvé a pulsar contratar.',code:'BILLING_CHECKOUT_EXPIRED'}:result);return true;
  }
  const result=await transaction(db,async c=>{
   const org=await actor(c,user,true);if(demo(org))fail('Las demos están exentas de cobro',409,'BILLING_DEMO');
   const row=await locked(c,org.id);if(!row.stripe_customer_id||!row.stripe_subscription_id)fail('Primero completá la contratación',409,'BILLING_NO_CUSTOMER');
   const sub=await stripe(cfg,`subscriptions/${objectId(row.stripe_subscription_id,'sub')}`);subscriptionValid(sub,row,cfg,row.stripe_customer_id);
   const portal=await stripe(cfg,'billing_portal/sessions',{customer:row.stripe_customer_id,return_url:`${cfg.origin}/?billing=portal`});return {url:stripeUrl(portal.url,'billing.stripe.com')};
  });send(res,200,result);
 }catch(error){send(res,error.status||500,{error:error.status?error.message:'No se pudo completar la operación de suscripción',code:error.status?error.code:'BILLING_INTERNAL'});}
 return true;
}
