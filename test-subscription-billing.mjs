import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {Readable} from 'node:stream';
import {PGlite} from '@electric-sql/pglite';
import {startTrial,subscriptionState,subscriptionBilling} from './subscription-billing.js';

const pg=new PGlite(),originalFetch=globalThis.fetch,originalNow=Date.now;
const settings={STRIPE_BILLING_ENABLED:'true',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',STRIPE_PRICE_USD:'price_usd',STRIPE_PRICE_PYG:'price_pyg',STRIPE_PRODUCT_ID:'prod_scale',BILLING_APP_ORIGIN:'https://billing-fixture.invalid'};
const originalEnv=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]]));
let clock=Date.now(),calls=0,sequence=0;Date.now=()=>clock;
// Every outbound request is replaced before any test action; no real credentials,
// Stripe account, browser, local server or external side effect is involved.
globalThis.fetch=async()=>{throw new Error('Unexpected network: billing must be disabled');};
const query=(sql,args)=>pg.query(sql,args);
let tail=Promise.resolve();
const db={query,connect:async()=>{let release;const prior=tail;tail=new Promise(resolve=>{release=resolve;});await prior;return {query,release};}};
const DAY=86400000;
async function call(path,method='GET',payload={},user=null,req=null){
 let output;
 const handled=await subscriptionBilling({req:req||{method,headers:{}},res:{},url:new URL(`https://test.invalid${path}`),db,session:async()=>user,body:async()=>payload,send:(_,status,data)=>{output={status,data};}});
 calls++;assert(handled);return output;
}
const state=(user,at=clock)=>subscriptionState(db,user,new Date(at));
const post=(user,body={})=>call('/api/billing/checkout','POST',body,user);
const wire=[],sessions=new Map(),subscriptions=new Map(),invoices=new Map(),keys=new Map();
let badPrice=false,inactivePrice=false,failNext=false,loseCheckoutResponse=false,invalidCheckoutUrl=false,invalidPortalUrl=false;
const price=currency=>({id:currency==='USD'?'price_usd':'price_pyg',object:'price',product:'prod_scale',active:true,livemode:false,type:'recurring',billing_scheme:'per_unit',currency:currency.toLowerCase(),unit_amount:currency==='USD'?1000:50000,recurring:{interval:'month',interval_count:1,usage_type:'licensed'}});
async function mockStripe(input,options){
 const url=new URL(input);assert.equal(url.origin,'https://api.stripe.com');assert.equal(options.redirect,'error');assert.equal(options.headers['Stripe-Version'],'2025-03-31.basil');assert.equal(options.headers.Authorization,`Bearer ${settings.STRIPE_SECRET_KEY}`);
 const path=url.pathname.replace('/v1/',''),params=Object.fromEntries(options.body||[]);wire.push({path,params,method:options.method,key:options.headers['Idempotency-Key']});
 if(failNext){failNext=false;throw new Error('Fixture timeout');}
 let result;
 if(path.startsWith('prices/')){
  result=price(path.endsWith('price_usd')?'USD':'PYG');if(badPrice)result={...result,unit_amount:1};if(inactivePrice)result={...result,active:false};
 }
 else if(path==='checkout/sessions'){
  const key=options.headers['Idempotency-Key'];assert(key);
  if(keys.has(key)){const old=keys.get(key);assert.deepEqual(params,old.params,'retried request uses identical persisted parameters');result=sessions.get(old.id);}
  else{
   const id=`cs_test_${++sequence}`;
   result={id,object:'checkout.session',mode:'subscription',livemode:false,status:'open',expires_at:Number(params.expires_at),client_reference_id:params.client_reference_id,
    metadata:{organization_id:params['metadata[organization_id]'],binding_token:params['metadata[binding_token]'],attempt_id:params['metadata[attempt_id]']},url:invalidCheckoutUrl?'https://attacker.invalid/':`https://checkout.stripe.com/c/pay/${id}`};
   sessions.set(id,result);keys.set(key,{id,params});
  }
  if(loseCheckoutResponse){loseCheckoutResponse=false;throw new Error('Lost response after Stripe success');}
 }else if(path.startsWith('checkout/sessions/'))result=sessions.get(path.split('/').at(-1));
 else if(path.startsWith('subscriptions/'))result=subscriptions.get(path.split('/').at(-1));
 else if(path.startsWith('invoices/'))result=invoices.get(path.split('/').at(-1));
 else if(path==='billing_portal/sessions')result={url:invalidPortalUrl?'https://attacker.invalid/':'https://billing.stripe.com/p/session/fixture'};
 else throw new Error(`Unexpected Stripe path ${path}`);
 assert(result,`Missing fixture for ${path}`);return new Response(JSON.stringify(result),{status:200});
}
function event(type,obj,overrides={}){return {id:`evt_${++sequence}`,object:'event',type,created:Math.floor(clock/1000),livemode:false,data:{object:obj},...overrides};}
async function deliver(value,{timestamp=Math.floor(clock/1000),secret=settings.STRIPE_WEBHOOK_SECRET,tamper=false,stream=false,signature=null}={}){
 const raw=Buffer.from(JSON.stringify(value)),sig=createHmac('sha256',secret).update(`${timestamp}.`).update(raw).digest('hex');
 const req=stream?Readable.from([raw.subarray(0,11),raw.subarray(11)]):{rawBody:tamper?Buffer.concat([raw,Buffer.from(' ')]):raw};
 req.method='POST';req.headers={'stripe-signature':signature||`t=${timestamp},v1=${sig}`};
 return call('/api/billing/webhook','POST',{},null,req);
}
async function complete(user,currency='USD',viaCheckout=false){
 const row=(await query('select * from organization_subscriptions where organization_id=$1',[user.organization_id])).rows[0];
 const attempt=(await query('select * from subscription_checkout_attempts where organization_id=$1 and not closed',[user.organization_id])).rows[0];
 const session=sessions.get(attempt.stripe_session_id),subId=`sub_${++sequence}`,customer=`cus_${sequence}`,itemId=`si_${sequence}`;
 const sub={id:subId,customer,livemode:false,status:'trialing',collection_method:'charge_automatically',metadata:{organization_id:String(user.organization_id),binding_token:row.binding_token},latest_invoice:null,
  items:{has_more:false,data:[{id:itemId,quantity:1,price:price(currency),current_period_start:Math.floor(clock/1000),current_period_end:Math.floor(clock/1000)+30*86400}]}};
 subscriptions.set(subId,sub);Object.assign(session,{status:'complete',customer,subscription:subId});
 const response=viaCheckout?await post(user,{currency}):await deliver(event('checkout.session.completed',session),{stream:true});assert.equal(response.status,200,JSON.stringify(response));
 if(viaCheckout){assert.deepEqual(response.data,{completed:true});assert(!response.data.url,'completed checkout requires UI refresh, not a redirect');}
 return {row,sub,session};
}
function invoice(sub,{start=Math.floor(clock/1000),end=start+30*86400,status='paid',currency='USD',id=`in_${++sequence}`}={}){
 const minor=currency==='USD'?1000:50000;
 const value={id,customer:sub.customer,livemode:false,parent:{type:'subscription_details',subscription_details:{subscription:sub.id}},currency:currency.toLowerCase(),status,amount_paid:status==='paid'?minor:0,amount_due:minor,total:minor,amount_remaining:status==='paid'?0:minor,collection_method:'charge_automatically',billing_reason:'subscription_cycle',paid_out_of_band:false,
  lines:{has_more:false,data:[{id:`il_${sequence}`,amount:minor,currency:currency.toLowerCase(),quantity:1,period:{start,end},parent:{type:'subscription_item_details',subscription_item_details:{subscription:sub.id,subscription_item:sub.items.data[0].id,proration:false}},pricing:{price_details:{price:price(currency).id,product:'prod_scale'}}}]}};
 invoices.set(id,value);sub.latest_invoice=id;Object.assign(sub.items.data[0],{current_period_start:start,current_period_end:end});return value;
}

try{
 for(const key of Object.keys(settings))delete process.env[key];
 await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
 for(const name of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260910_demo_sessions.sql','20260911_subscriptions.sql'])await pg.exec(await fs.readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));
 await pg.exec(await fs.readFile(new URL('./migrations/20260911_subscriptions.sql',import.meta.url),'utf8'));
 const uid=(await query("insert into users(email,password_hash) values('subscription-owner@example.invalid','unused') returning id")).rows[0].id;
 async function tenant(label){const id=(await query('insert into organizations(slug,name) values($1,$2) returning id',[`billing-${label}`,`Fixture ${label}`])).rows[0].id;await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[id,uid]);return {id:uid,organization_id:id,role:'owner'};}
 const owner=await tenant('usd'),other=await tenant('pyg'),existing=await tenant('existing'),demoUser=await tenant('demo'),near=await tenant('near'),rollback=await tenant('rollback'),uncertain=await tenant('uncertain'),badUrl=await tenant('url');
 assert.equal((await state(existing)).status,'unmanaged');assert.equal((await state(existing)).hasAccess,true);assert.equal((await state(existing)).checkoutReady,false);
 assert.equal((await query('select count(*)::int as n from organization_subscriptions')).rows[0].n,0,'migration never enrolls existing tenants');
 await query('update organizations set demo_owner_user_id=$1 where id=$2',[uid,demoUser.organization_id]);
 assert.equal(await startTrial(db,demoUser.organization_id),null);assert.equal((await state(demoUser)).status,'demo');assert.equal((await state(demoUser)).canManage,false);
 // Caller owns its transaction; rolling signup back also rolls its trial back.
 await query('begin');await startTrial({query},rollback.organization_id);await query('rollback');assert.equal((await state(rollback)).status,'unmanaged');
 const started=await startTrial(db,owner.organization_id),again=await startTrial(db,owner.organization_id,'PYG');assert.deepEqual(again,started);
 await startTrial(db,other.organization_id,'PYG');assert.equal((await state(other)).amount,50000);assert.equal((await state(other)).currency,'PYG');
 const trial=(await query('select * from organization_subscriptions where organization_id=$1',[owner.organization_id])).rows[0];
 const trialEnd=new Date(trial.trial_ends_at).getTime();assert.equal(trialEnd-new Date(trial.trial_started_at).getTime(),30*DAY);
 for(const [at,expected,access] of [[trialEnd-1,'trialing',true],[trialEnd,'grace',true],[trialEnd+2*DAY-1,'grace',true],[trialEnd+2*DAY,'suspended',false]]){const s=await state(owner,at);assert.equal(s.status,expected);assert.equal(s.hasAccess,access);assert.equal(s.suspendAt,new Date(trialEnd+2*DAY).toISOString());}
 assert.equal((await state(owner,trialEnd)).daysRemaining,2);assert.equal((await state(owner,trialEnd+2*DAY)).daysRemaining,0);
 await assert.rejects(startTrial(db,existing.organization_id,'EUR'));
 assert.equal((await call('/api/billing/subscription')).status,401);
 assert.equal((await post(owner)).status,503);assert.equal((await state(owner)).checkoutReady,false);
 assert.equal((await deliver(event('invoice.paid',{}))).status,503,'webhook disabled without configuration');assert.equal(wire.length,0);
 const actors=[];
 for(const role of ['admin','management','finance','sales','production','editor','viewer']){
  const id=(await query('insert into users(email,password_hash) values($1,$2) returning id',[`billing-${role}@example.invalid`,'unused'])).rows[0].id;
  await query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3)',[owner.organization_id,id,role]);const member={id,organization_id:owner.organization_id,role};actors.push(member);
  const read=await call('/api/billing/subscription','GET',{},member);assert.equal(read.status,200);assert.equal(read.data.canManage,false);assert.equal(read.data.portalReady,false);assert.equal(Object.keys(read.data).length,11);
  assert.equal((await post(member)).status,403);assert.equal((await call('/api/billing/portal','POST',{},member)).status,403);
 }
 assert.equal((await state({...actors[0],organization_id:other.organization_id}).catch(e=>e.status)),403,'tenant membership is not transferable');
 assert.equal((await post({...actors[0],role:'owner'})).status,403,'stale/elevated session role cannot bypass current membership');
 Object.assign(process.env,settings);globalThis.fetch=mockStripe;
 assert.equal((await state(owner)).checkoutReady,true);
 assert.equal((await state(owner)).portalReady,false,'an unlinked trial has no portal');
 assert.equal((await state(existing)).portalReady,false);assert.equal((await state(demoUser)).portalReady,false);
 const beforeUnlinkedPortal=wire.length;
 assert.equal((await call('/api/billing/portal','POST',{},owner)).data.code,'BILLING_NO_CUSTOMER');assert.equal(wire.length,beforeUnlinkedPortal);
 assert.equal((await post(demoUser)).status,409);assert.equal((await post(existing)).status,409);
 for(const body of [{currency:'EUR'},{currency:null},{amount:1},{customer:'cus_foreign'},{organization_id:other.organization_id},{return_url:'https://attacker.invalid'},null,[]])assert.equal((await post(owner,body)).status,400);
 const beforeCurrency=wire.length;assert.equal((await post(owner,{currency:'PYG'})).data.code,'BILLING_CURRENCY_LOCKED');assert.equal(wire.length,beforeCurrency);
 assert.equal((await query('select count(*)::int as n from subscription_checkout_attempts where organization_id=$1',[owner.organization_id])).rows[0].n,0);
 badPrice=true;assert.equal((await post(owner)).data.code,'BILLING_PRICE_MISMATCH');badPrice=false;
 assert.equal((await query('select count(*)::int as n from subscription_checkout_attempts where organization_id=$1',[owner.organization_id])).rows[0].n,0,'invalid price leaves no attempt to expire');
 inactivePrice=true;assert.equal((await post(owner)).data.code,'BILLING_PRICE_MISMATCH');inactivePrice=false;
 assert.equal((await query('select count(*)::int as n from subscription_checkout_attempts where organization_id=$1',[owner.organization_id])).rows[0].n,0,'inactive price leaves no attempt either');
 assert.equal(wire.filter(r=>r.path==='checkout/sessions').length,0,'invalid price cannot create checkout');
 clock+=31*60000;
 const simultaneous=await Promise.all([post(owner,{currency:'USD'}),post(owner,{currency:'USD'})]);assert(simultaneous.every(r=>r.status===200),JSON.stringify(simultaneous));assert.equal(simultaneous[0].data.url,simultaneous[1].data.url);assert.equal(wire.filter(r=>r.path==='checkout/sessions').length,1);
 assert.equal((await query('select count(*)::int as n from subscription_checkout_attempts where organization_id=$1',[owner.organization_id])).rows[0].n,1,'corrected price after 31 minutes creates one serialized attempt');
 const afterPending=wire.length;assert.equal((await post(owner,{currency:'PYG'})).data.code,'BILLING_CURRENCY_LOCKED');assert.equal(wire.length,afterPending,'currency cannot change with an open checkout either');
 const usdPost=wire.find(r=>r.path==='checkout/sessions');assert.equal(usdPost.params['line_items[0][price]'],'price_usd');assert.equal(usdPost.params['subscription_data[trial_end]'],String(Math.floor(trialEnd/1000)));assert(!Object.hasOwn(usdPost.params,'subscription_data[trial_period_days]'));
 assert.equal(Number(usdPost.params.expires_at),Math.floor(clock/1000)+1800,'new expiration is based on the successful validation time');
 assert.equal(usdPost.params['line_items[0][quantity]'],'1','all eight agency members are included, never billed as seats');
 assert.equal((await query('select count(*)::int as n from organization_subscriptions where organization_id=$1',[owner.organization_id])).rows[0].n,1,'one subscription per agency, not one per member');
 assert.match(usdPost.params['custom_text[submit][message]'],/mensual recurrente: 10 USD/);
 const beforePriceTimeout=wire.length;failNext=true;assert.equal((await post(other,{currency:'PYG'})).data.code,'BILLING_PROVIDER_UNAVAILABLE');
 assert.deepEqual(wire.slice(beforePriceTimeout).map(r=>r.path),['prices/price_pyg'],'timeout occurs during price lookup, before checkout creation');
 assert.equal((await query('select count(*)::int as n from subscription_checkout_attempts where organization_id=$1',[other.organization_id])).rows[0].n,0,'price lookup timeout leaves no uncertain creation');
 clock+=31*60000;
 assert.equal((await post(other,{currency:'PYG'})).status,200);assert.equal(wire.filter(r=>r.path==='checkout/sessions').at(-1).params['line_items[0][price]'],'price_pyg');
 assert.equal(Number(wire.filter(r=>r.path==='checkout/sessions').at(-1).params.expires_at),Math.floor(clock/1000)+1800,'price timeout retry gets a fresh expiration');
 console.log('PASS: invalid/inactive price and price-lookup timeout leave zero attempts; corrected prices after 31 minutes create fresh checkout; overlapping requests share one attempt/session');
 await startTrial(db,near.organization_id);await query("update organization_subscriptions set trial_started_at=now()-interval '29 days',trial_ends_at=now()+interval '1 day',due_at=now()+interval '1 day' where organization_id=$1",[near.organization_id]);
 assert.equal((await post(near)).data.code,'BILLING_TRIAL_ENDING');
 await startTrial(db,uncertain.organization_id);loseCheckoutResponse=true;assert.equal((await post(uncertain)).status,503);
 const uncertainAttempt=(await query('select * from subscription_checkout_attempts where organization_id=$1',[uncertain.organization_id])).rows[0];
 assert.equal(uncertainAttempt.stripe_session_id,null);assert.equal(uncertainAttempt.closed,false);
 const firstCreation=wire.at(-1);assert.equal(firstCreation.path,'checkout/sessions');assert.deepEqual(firstCreation.params,uncertainAttempt.parameters);
 const beforeKeys=keys.size,beforeSessions=sessions.size,beforeRetry=wire.length;
 clock+=60000;badPrice=true;assert.equal((await post(uncertain)).status,200);badPrice=false;
 assert.deepEqual(wire.slice(beforeRetry).map(r=>r.path),['checkout/sessions'],'uncertain creation retries bypass fresh price validation');
 assert.deepEqual(wire.at(-1),firstCreation,'retry preserves idempotency key and every immutable parameter');
 assert.equal(keys.size,beforeKeys);assert.equal(sessions.size,beforeSessions,'lost response cannot create a second checkout');
 const recovered=(await query('select * from subscription_checkout_attempts where organization_id=$1',[uncertain.organization_id])).rows;
 assert.equal(recovered.length,1);assert.equal(recovered[0].id,uncertainAttempt.id);assert.deepEqual(recovered[0].parameters,uncertainAttempt.parameters);
 const beforeSubscriptions=subscriptions.size;await complete(uncertain,'USD',true);
 assert.equal((await post(uncertain)).data.code,'BILLING_USE_PORTAL');assert.equal(subscriptions.size,beforeSubscriptions+1);assert.equal(sessions.size,beforeSessions,'completed retry cannot create a second subscription checkout');
 console.log('PASS: uncertain checkout creation keeps committed parameters and idempotency key despite later price mismatch; one session and one linked subscription');
 await startTrial(db,badUrl.organization_id);invalidCheckoutUrl=true;assert.equal((await post(badUrl)).status,503);invalidCheckoutUrl=false;
 const binding=await complete(owner),pygBinding=await complete(other,'PYG');
 assert.equal((await post(owner)).data.code,'BILLING_USE_PORTAL');
 const privateState=await state(owner);assert(!JSON.stringify(privateState).includes('cus_'));assert(!JSON.stringify(privateState).includes('binding_token'));
 assert(!JSON.stringify(privateState).includes('sub_'));assert.equal(privateState.status,'trialing');assert.equal(privateState.portalReady,true);
 const beforePortalRead=wire.length;
 assert.equal((await state(other)).portalReady,true,'PYG bound trial also supports its portal');
 for(const member of actors)assert.equal((await state(member)).portalReady,false,'only the current owner can manage billing');
 assert.equal((await state({...actors[0],role:'owner'})).portalReady,false,'stale owner role cannot override actual membership');
 // Read-only partial-binding doubles: neither provider ID alone is sufficient.
 for(const missing of ['stripe_customer_id','stripe_subscription_id']){
  const partialDb={query:async(sql,args)=>{const result=await query(sql,args);return sql==='select * from organization_subscriptions where organization_id=$1'?{...result,rows:result.rows.map(row=>({...row,[missing]:null}))}:result;}};
  assert.equal((await subscriptionState(partialDb,owner,new Date(clock))).portalReady,false);
 }
 assert.equal(wire.length,beforePortalRead,'availability reads do not contact Stripe');
 process.env.STRIPE_BILLING_ENABLED='false';
 assert.equal((await state(owner)).portalReady,false);assert.equal((await state(owner)).checkoutReady,false);
 assert.equal((await call('/api/billing/portal','POST',{},owner)).status,503);assert.equal(wire.length,beforePortalRead);
 process.env.STRIPE_BILLING_ENABLED=settings.STRIPE_BILLING_ENABLED;
 assert.equal((await call('/api/billing/portal','POST',{},owner)).status,200,'bound owner can manage before trial ends');
 assert.equal(wire.at(-1).path,'billing_portal/sessions');
 assert.equal((await state(owner)).status,'trialing');assert.equal((await state(owner)).dueAt,privateState.dueAt);
 const beforeViewerPortal=wire.length;
 assert.equal((await call('/api/billing/portal','POST',{},actors.at(-1))).status,403);assert.equal(wire.length,beforeViewerPortal);
 // Zero-dollar trial invoice cannot extend access beyond the original trial.
 const zero=invoice(binding.sub);Object.assign(zero,{amount_paid:0,amount_due:0,total:0});
 assert.equal((await deliver(event('invoice.paid',zero))).status,200);assert.equal((await state(owner)).dueAt,isoDate(trialEnd));
 // Expire local trial; the clock only affects domain tests, never system time.
 clock=trialEnd+3*DAY;assert.equal((await state(owner)).status,'suspended');
 const unpaid=invoice(binding.sub,{status:'open'});binding.sub.status='past_due';const originalDue=(await state(owner)).dueAt;
 for(let retry=0;retry<3;retry++)assert.equal((await deliver(event('invoice.payment_failed',unpaid))).status,200);
 assert.equal((await state(owner)).dueAt,originalDue);assert.equal((await state(owner)).status,'suspended');
 const paid=invoice(binding.sub);binding.sub.status='active';const paidEvent=event('invoice.paid',paid);
 const invalidBefore=wire.length;
 for(const options of [{timestamp:Math.floor(clock/1000)-301},{timestamp:Math.floor(clock/1000)+301},{secret:'whsec_wrong'},{tamper:true}])assert.equal((await deliver(paidEvent,options)).status,400);
 assert.equal(wire.length,invalidBefore,'invalid signatures never reach Stripe');
 assert.equal((await deliver(paidEvent)).status,200);assert.equal((await state(owner)).status,'active');assert.equal((await state(owner)).dueAt,isoDate(paid.lines.data[0].period.end*1000));
 const duplicateBefore=wire.length;assert.equal((await deliver(paidEvent)).data.duplicate,true);assert.equal(wire.length,duplicateBefore);
 assert.equal((await deliver(event('invoice.paid',paid,{padding:'x'.repeat(262144)}),{stream:true})).status,413);
 const duePaid=(await state(owner)).dueAt;assert.equal((await deliver(event('invoice.payment_succeeded',paid))).status,200);assert.equal((await state(owner)).dueAt,duePaid,'different event id cannot extend same paid period');
 for(const [at,expected] of [[new Date(duePaid).getTime()-1,'active'],[new Date(duePaid).getTime(),'grace'],[new Date(duePaid).getTime()+2*DAY-1,'grace'],[new Date(duePaid).getTime()+2*DAY,'suspended']])assert.equal((await state(owner,at)).status,expected);
 const old=invoice(binding.sub,{start:Math.floor(trialEnd/1000)-30*86400,end:Math.floor(trialEnd/1000)});binding.sub.latest_invoice=paid.id;Object.assign(binding.sub.items.data[0],{current_period_start:paid.lines.data[0].period.start,current_period_end:paid.lines.data[0].period.end});
 assert.equal((await deliver(event('invoice.paid',old,{created:Math.floor(trialEnd/1000)-100}))).status,200);assert.equal((await state(owner)).dueAt,duePaid,'late old invoice cannot replace the newer paid period');
 assert.equal((await deliver(event('customer.subscription.deleted',{...binding.sub,status:'canceled'},{created:Math.floor(trialEnd/1000)-50}))).status,200);assert.equal((await state(owner)).status,'active','stale event body cannot override current retrieved subscription');
 // Paid invoice binding/price/period violations are rejected atomically.
 const current=structuredClone(paid),beforeLedger=(await query('select count(*)::int as n from subscription_paid_invoices')).rows[0].n;
 const mutations=[v=>v.customer='cus_foreign',v=>v.currency='pyg',v=>v.parent.subscription_details.subscription=pygBinding.sub.id,v=>v.amount_paid=999,v=>v.paid_out_of_band=true,v=>v.lines.has_more=true,v=>v.lines.data[0].quantity=2,v=>v.lines.data[0].pricing.price_details.product='prod_foreign',v=>v.lines.data[0].pricing.price_details.price='price_foreign',v=>v.lines.data[0].parent.subscription_item_details.proration=true,v=>v.lines.data[0].period.end+=86400];
 for(const mutate of mutations){const bad=structuredClone(current);bad.id=`in_${++sequence}`;mutate(bad);invoices.set(bad.id,bad);binding.sub.latest_invoice=bad.id;
  const response=await deliver(event('invoice.paid',{...bad,parent:current.parent}));assert.equal(response.status,409,JSON.stringify(response));assert.equal((await state(owner)).dueAt,duePaid);
 }
 binding.sub.latest_invoice=paid.id;assert.equal((await query('select count(*)::int as n from subscription_paid_invoices')).rows[0].n,beforeLedger);
 const pygPaid=invoice(pygBinding.sub,{currency:'PYG'});pygBinding.sub.status='active';assert.equal((await deliver(event('invoice.paid',pygPaid))).status,200);assert.equal((await state(other)).status,'active');
 assert.equal((await query('select amount_minor from subscription_paid_invoices where invoice_id=$1',[pygPaid.id])).rows[0].amount_minor,50000,'PYG is zero-decimal, not multiplied by 100');
 binding.sub.status='paused';assert.equal((await call('/api/billing/portal','POST',{},owner)).status,200,'portal remains available when Stripe subscription is paused');
 assert.equal(wire.at(-1).params.customer,binding.sub.customer);invalidPortalUrl=true;assert.equal((await call('/api/billing/portal','POST',{},owner)).status,503);invalidPortalUrl=false;
 const failing=event('customer.subscription.updated',binding.sub);failNext=true;assert.equal((await deliver(failing)).status,503);assert.equal((await query('select event_id from subscription_stripe_events where event_id=$1',[failing.id])).rows.length,0,'failed reconciliation remains retryable');assert.equal((await deliver(failing)).status,200);
 // Trial expired without any existing Stripe subscription: no fresh trial.
 assert.equal((await post(near)).status,200);assert(!Object.hasOwn(wire.filter(r=>r.path==='checkout/sessions').at(-1).params,'subscription_data[trial_end]'));
 const past=await tenant('past');await startTrial(db,past.organization_id);loseCheckoutResponse=true;assert.equal((await post(past)).status,503);await query("update subscription_checkout_attempts set created_at=now()-interval '25 hours' where organization_id=$1",[past.organization_id]);assert.equal((await post(past)).data.code,'BILLING_RECONCILIATION_REQUIRED');
 const expired=await tenant('expired');const expiredTrial=await startTrial(db,expired.organization_id);assert.equal((await post(expired,{currency:'USD'})).status,200);
 const oldAttempt=(await query('select * from subscription_checkout_attempts where organization_id=$1 and not closed',[expired.organization_id])).rows[0];sessions.get(oldAttempt.stripe_session_id).status='expired';
 assert.equal((await post(expired,{currency:'USD'})).data.code,'BILLING_CHECKOUT_EXPIRED');assert.equal((await post(expired,{currency:'USD'})).status,200);
 const newAttempt=(await query('select * from subscription_checkout_attempts where organization_id=$1 and not closed',[expired.organization_id])).rows[0];assert.notEqual(newAttempt.id,oldAttempt.id);assert.equal(newAttempt.parameters['subscription_data[trial_end]'],String(Math.floor(new Date(expiredTrial.trialEndsAt).getTime()/1000)),'a new checkout after expiration still uses the original absolute trial end');
 await query('update organization_members set active=false where organization_id=$1 and user_id=$2',[owner.organization_id,owner.id]);assert.equal((await call('/api/billing/subscription','GET',{},owner)).status,403);assert.equal((await call('/api/billing/portal','POST',{},owner)).status,403);
 assert.equal((await state(existing)).status,'unmanaged');assert.equal((await state(demoUser)).status,'demo');
 console.log(`PASS: ${calls} billing handler cases; idempotent caller-transaction trial, 30-day/48h boundaries, legacy/demo exemptions, owner/tenant isolation, optional config, exact server prices, durable checkout retries, raw HMAC timestamps, duplicate/stale events, verified monthly USD/PYG invoice binding, immutable grace and paused portal. PGlite single connection + mocked Stripe only; no real concurrency or provider activation verified.`);
}finally{
 Date.now=originalNow;globalThis.fetch=originalFetch;for(const [key,value] of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await pg.close();
}
function isoDate(value){return new Date(value).toISOString();}
