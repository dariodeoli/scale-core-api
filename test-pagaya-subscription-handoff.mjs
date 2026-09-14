import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHmac} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {startTrial,subscriptionBilling,verifyPagayaMessage} from './subscription-billing.js';

const pg=new PGlite(),query=(sql,args)=>pg.query(sql,args),db={query,connect:async()=>({query,release(){}})};
const now=Date.now(),timestamp=String(Math.floor(now/1000));
const settings={STRIPE_BILLING_ENABLED:'true',STRIPE_SECRET_KEY:'sk_test_fixture',STRIPE_WEBHOOK_SECRET:'whsec_fixture',STRIPE_PRICE_USD:'price_usd',STRIPE_PRICE_PYG:'price_pyg',STRIPE_PRODUCT_ID:'prod_scale',BILLING_APP_ORIGIN:'https://scale.invalid',STRIPE_WEBHOOK_VERIFIED_AT:'2026-09-12T00:00:00Z',SUBSCRIPTION_CHECKOUT_PROVIDER:'pagaya',PAGAYA_SUBSCRIPTION_ORIGIN:'https://pagaya.invalid',PAGAYA_HANDOFF_REQUEST_SECRET:'r'.repeat(32),PAGAYA_HANDOFF_CALLBACK_SECRET:'c'.repeat(32)};
const originalEnv=Object.fromEntries(Object.keys(settings).map(key=>[key,process.env[key]])),originalFetch=globalThis.fetch;
 let output,pagayaRequest,pagayaCalls=0;
async function call(path,method,payload,user,req){
 output=undefined;await subscriptionBilling({req:req||{method,headers:{}},res:{},url:new URL(`https://scale.invalid${path}`),db,session:async()=>user,body:async()=>payload,send:(_,status,data)=>{output={status,data};}});return output;
}

try{
 Object.assign(process.env,settings);
 await pg.exec(await fs.readFile(new URL('./schema.sql',import.meta.url),'utf8'));
 for(const name of ['20260908_treasury_ledger.sql','20260908_people_commissions_comments.sql','20260908_operations_complete.sql','20260908_referral_discounts.sql','20260908_collaborator_profiles.sql','20260908_agency_suite.sql','20260910_demo_sessions.sql','20260911_subscriptions.sql','20260913_pagaya_subscription_handoff.sql'])await pg.exec(await fs.readFile(new URL(`./migrations/${name}`,import.meta.url),'utf8'));
 await pg.exec(await fs.readFile(new URL('./migrations/20260913_pagaya_subscription_handoff.sql',import.meta.url),'utf8'));
 const userId=(await query("insert into users(email,password_hash) values('owner@example.invalid','unused') returning id")).rows[0].id;
 const organizationId=(await query("insert into organizations(slug,name) values('pagaya-handoff','PagaYa Handoff') returning id")).rows[0].id;
 await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[organizationId,userId]);
 const owner={id:userId,organization_id:organizationId,role:'owner',email:'owner@example.invalid'};await startTrial(db,organizationId,'USD');

 const periodStart=Math.floor(now/1000),periodEnd=periodStart+30*86400;
 const price={id:'price_usd',product:'prod_scale',currency:'usd',unit_amount:1000,livemode:false,type:'recurring',billing_scheme:'per_unit',recurring:{interval:'month',interval_count:1,usage_type:'licensed'}};
 let subscription;
 globalThis.fetch=async(input,options)=>{
  const url=new URL(input);
  if(url.origin==='https://pagaya.invalid'){
   pagayaCalls++;
   assert.equal(url.pathname,'/api/integrations/scale/subscriptions');assert.equal(options.redirect,'error');
   const raw=options.body,t=options.headers['x-scale-timestamp'],nonce=options.headers['x-scale-nonce'],signature=options.headers['x-scale-signature'];
   assert(verifyPagayaMessage({secret:settings.PAGAYA_HANDOFF_REQUEST_SECRET,timestamp:t,nonce,signature,raw}));
   pagayaRequest=JSON.parse(raw);assert.deepEqual(Object.keys(pagayaRequest).sort(),['customerEmail','enrollmentId','offerCode']);assert.equal(pagayaRequest.offerCode,'scale_monthly_usd');
   return new Response(JSON.stringify({checkoutSessionId:'cs_scale_1',checkoutUrl:'https://checkout.stripe.com/c/pay/cs_scale_1'}),{status:200});
  }
  if(url.pathname==='/v1/subscriptions/sub_scale_1')return new Response(JSON.stringify(subscription),{status:200});
  if(url.pathname==='/v1/invoices/in_scale_1')return new Response(JSON.stringify({id:'in_scale_1',customer:'cus_scale_1',livemode:false,parent:{type:'subscription_details',subscription_details:{subscription:'sub_scale_1'}},currency:'usd',status:'paid',amount_paid:1000,amount_due:1000,total:1000,amount_remaining:0,collection_method:'charge_automatically',billing_reason:'subscription_create',paid_out_of_band:false,lines:{has_more:false,data:[{id:'il_scale_1',amount:1000,currency:'usd',quantity:1,period:{start:periodStart,end:periodEnd},parent:{type:'subscription_item_details',subscription_item_details:{subscription:'sub_scale_1',subscription_item:'si_scale_1',proration:false}},pricing:{price_details:{price:'price_usd',product:'prod_scale'}}}]}}),{status:200});
  throw new Error(`Unexpected fetch ${url.href}`);
 };

 const checkout=await call('/api/billing/checkout','POST',{},owner);assert.equal(checkout.status,200);assert.deepEqual(checkout.data,{url:'https://checkout.stripe.com/c/pay/cs_scale_1'});
 const enrollment=(await query('select * from subscription_pagaya_enrollments where organization_id=$1',[organizationId])).rows[0];assert.equal(enrollment.id,pagayaRequest.enrollmentId);assert.equal(enrollment.amount_minor,1000);assert.equal(enrollment.status,'pending');
 await query("update subscription_pagaya_enrollments set expires_at=now()-interval '1 hour' where id=$1",[enrollment.id]);
 const lateRetry=await call('/api/billing/checkout','POST',{},owner);assert.equal(lateRetry.status,200);assert.deepEqual(lateRetry.data,checkout.data);assert.equal(pagayaCalls,2);
 assert.equal((await query('select count(*)::int as n from subscription_pagaya_enrollments where organization_id=$1',[organizationId])).rows[0].n,1,'an expired preparation timestamp never replaces a dispatched Checkout');
 await query("update subscription_pagaya_enrollments set status='dispatching',pagaya_checkout_session_id=null where id=$1",[enrollment.id]);
 subscription={id:'sub_scale_1',customer:'cus_scale_1',livemode:false,status:'active',collection_method:'charge_automatically',metadata:{scale_enrollment_id:enrollment.id,scale_plan_code:'scale_monthly'},latest_invoice:'in_scale_1',items:{has_more:false,data:[{id:'si_scale_1',quantity:1,price,current_period_start:periodStart,current_period_end:periodEnd}]}};
 const unknownEvent={id:'evt_unknown_1',type:'customer.subscription.updated',created:Number(timestamp),livemode:false,data:{object:{id:'sub_unknown_1'}}},unknownRaw=JSON.stringify(unknownEvent),unknownSig=createHmac('sha256',settings.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${unknownRaw}`).digest('hex');
 const unknown=await call('/api/billing/webhook','POST',{},null,{method:'POST',rawBody:Buffer.from(unknownRaw),headers:{'stripe-signature':`t=${timestamp},v1=${unknownSig}`}});assert.deepEqual(unknown.data,{received:true,ignored:true},'unknown Stripe subscriptions remain rejected before a valid callback binding');
 const callback={eventId:'evt_scale_1',enrollmentId:enrollment.id,checkoutSessionId:'cs_scale_1',stripeCustomerId:'cus_scale_1',stripeSubscriptionId:'sub_scale_1',planCode:'scale_monthly',currency:'USD',amountMinor:1000};
 const raw=JSON.stringify(callback),nonce='550e8400-e29b-41d4-a716-446655440000',signature=createHmac('sha256',settings.PAGAYA_HANDOFF_CALLBACK_SECRET).update(`${timestamp}.${nonce}.${raw}`).digest('hex');
 const request={method:'POST',rawBody:Buffer.from(raw),headers:{'x-pagaya-timestamp':timestamp,'x-pagaya-nonce':nonce,'x-pagaya-signature':signature}};
 const accepted=await call('/api/billing/pagaya/callback','POST',{},null,request);assert.equal(accepted.status,200,JSON.stringify(accepted));assert.deepEqual(accepted.data,{received:true,enrollmentId:enrollment.id});
 const bound=(await query('select * from organization_subscriptions where organization_id=$1',[organizationId])).rows[0];assert.equal(bound.stripe_customer_id,'cus_scale_1');assert.equal(bound.stripe_subscription_id,'sub_scale_1');assert.equal(bound.pagaya_enrollment_id,enrollment.id);
 assert.equal((await query('select count(*)::int as n from subscription_paid_invoices where organization_id=$1',[organizationId])).rows[0].n,1);
 assert.deepEqual((await call('/api/billing/pagaya/callback','POST',{},null,request)).data,{received:true,enrollmentId:enrollment.id},'callback replay returns the same strict acknowledgement');
 assert.equal((await call('/api/billing/checkout','POST',{},owner)).data.code,'BILLING_USE_PORTAL','a paid enrollment cannot create another Checkout');
 const tampered={...callback,eventId:'evt_scale_2',stripeSubscriptionId:'sub_foreign'},tamperedRaw=JSON.stringify(tampered),tamperedNonce='550e8400-e29b-41d4-a716-446655440001',tamperedSig=createHmac('sha256',settings.PAGAYA_HANDOFF_CALLBACK_SECRET).update(`${timestamp}.${tamperedNonce}.${tamperedRaw}`).digest('hex');
 assert.equal((await call('/api/billing/pagaya/callback','POST',{},null,{method:'POST',rawBody:Buffer.from(tamperedRaw),headers:{'x-pagaya-timestamp':timestamp,'x-pagaya-nonce':tamperedNonce,'x-pagaya-signature':tamperedSig}})).status,409,'one-time enrollment cannot bind a second subscription');
 console.log('PASS: Scale separates preparation expiry from reconciliation, reuses dispatched Checkout, accepts a late signed paid callback after an uncertain response, validates Stripe state, atomically binds the paid period, and rejects replay/rebinding.');
}finally{
 globalThis.fetch=originalFetch;for(const [key,value] of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await pg.close();
}
