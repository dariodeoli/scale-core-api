import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {identitySchema} from './scripts/test-identity-schema.mjs';
import {attributeActors} from './actor-identity.js';
import {operations} from './operations.js';
import {financeControls} from './finance-controls.js';
import {productivity} from './productivity.js';
import {inviteLinks,claimInvite} from './invite-links.js';
import {presence} from './presence.js';
import {workChecklists} from './work-checklists.js';
import {automationApi} from './automation.js';
import {inventoryReservations} from './inventory-reservations.js';
import {contentReview} from './content-review.js';
import {recordLifecycle} from './record-lifecycle.js';

const pg=new PGlite();
await pg.exec(await fs.readFile('schema.sql','utf8'));
for(const name of ['20260908_treasury_ledger','20260908_people_commissions_comments','20260908_operations_complete',
 '20260908_referral_discounts','20260908_collaborator_profiles','20260908_agency_suite','20260908_daily_controls'])
 await pg.exec(await fs.readFile(`migrations/${name}.sql`,'utf8'));
await identitySchema(pg);
for(const name of ['20260910_presence','20260910_currencies','20260910_company_currency','20260910_notifications',
 '20260910_inventory_reservations','20260910_work_checklists','20260911_invite_link_metrics','20260911_invite_link_details'])
 await pg.exec(await fs.readFile(`migrations/${name}.sql`,'utf8'));
const query=(s,v)=>pg.query(s,v),db={query,connect:async()=>({query,release(){}})};
const insert=async(s,v)=>(await query(s+' returning id',v)).rows[0].id;
const org=await insert("insert into organizations(slug,name) values('actors-a','Actors A')");
const other=await insert("insert into organizations(slug,name) values('actors-b','Actors B')");
const owner=await insert("insert into users(email,password_hash) values('actor@example.invalid','!')");
const outsider=await insert("insert into users(email,password_hash) values('outside@example.invalid','!')");
const reader=await insert("insert into users(email,password_hash) values('reader@example.invalid','!')");
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner'),($1,$3,'owner'),($4,$5,'owner')",[org,owner,reader,other,outsider]);
const photo='https://example.invalid/actor.png';
await query('insert into agency_user_profiles(organization_id,user_id,full_name,photo_url) values($1,$2,$3,$4),($5,$6,$7,$8)',[org,owner,'Ana Pérez',photo,other,outsider,'Private outsider','https://example.invalid/private.png']);
const user={id:owner,organization_id:org,role:'owner'};
async function call(handler,path,method='GET',payload={},as=user){
 if(handler===productivity)path='productivity/'+path;
 let response;
 assert.equal(await handler({req:{method,socket:{remoteAddress:'test'}},res:{},url:new URL('https://test/api/agency/'+path),
  db,session:async()=>as,sessionKey:()=> 'actor-session',body:async()=>payload,send:(_,status,data)=>response={status,...data},appUrl:'https://app.example.invalid'}),true);
 assert(response, path);return response;
}
function verified(row,name='Ana Pérez',picture=photo){
 assert(row);assert.equal(row.actor_name,name);assert.equal(row.actor_photo_url,picture);assert.equal(row.actor_verified,true);
}
function unverified(row){assert(row);assert.equal(row.actor_verified,false);assert.equal(row.actor_photo_url,null);assert.equal(row.actor_user_id,null);}
const client=await insert("insert into agency_clients(organization_id,name) values($1,'Client')",[org]);
const project=await insert("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Project')",[org,client]);
const order=await insert("insert into agency_work_orders(organization_id,project_id,title) values($1,$2,'Order')",[org,project]);
const invoice=await insert("insert into agency_invoices(organization_id,client_id,number,total) values($1,$2,'ACTOR-1',1000)",[org,client]);
const cash=await insert("insert into bank_accounts(organization_id,name,account_type,balance) values($1,'Cash','cash',1000)",[org]);
const bank=await insert("insert into bank_accounts(organization_id,name,account_type) values($1,'Bank','bank')",[org]);

let r=await call(operations,`projects/${project}/comments`,'POST',{body:'Comment'});
assert.equal(r.status,201);verified(r.comment);
r=await call(operations,`projects/${project}/comments`);verified(r.comments[0]);assert.equal(r.comments[0].author_email,'actor@example.invalid');
assert.equal((await call(operations,`projects/${project}/comments`,'GET',{}, {...user,organization_id:other})).status,404);
assert.equal((await call(operations,`projects/${project}/comments`,'POST',{body:'No'},{...user,role:'viewer'})).status,403);
verified((await call(productivity,`orders/${order}/comments`,'POST',{body:'Order comment'})).comment);
verified((await call(productivity,`orders/${order}`)).comments[0]);

const transfer={fromAccountId:cash,toAccountId:bank,amount:100,requestId:'11111111-1111-4111-a111-111111111111'};
verified((await call(financeControls,'transfers','POST',transfer)).transfer);
r=await call(financeControls,'transfers','POST',transfer);assert.equal(r.alreadyRecorded,true);verified(r.transfer);
r=await call(financeControls,'transfers');verified(r.transfers[0]);assert.equal(r.transfers[0].created_by_email,'actor@example.invalid');
const payment={invoiceId:invoice,accountId:cash,amount:100,requestId:'22222222-2222-4222-a222-222222222222'};
r=await call(financeControls,'payments','POST',payment);verified(r.payment);const paymentId=r.payment.id;
r=await call(financeControls,'payments','POST',payment);assert.equal(r.alreadyRecorded,true);verified(r.payment);
r=await call(financeControls,'payments');verified(r.payments[0]);assert.equal(r.payments[0].received_by_email,'actor@example.invalid');
verified((await call(productivity,`clients/${client}`)).payments[0]);
verified((await call(financeControls,`payments/${paymentId}/reverse`,'POST',{reason:'Duplicate receipt'})).reversal);
r=await call(financeControls,'payments');assert.equal(r.payments[0].reversal_actor_name,'Ana Pérez');assert.equal(r.payments[0].reversal_actor_verified,true);
assert.equal((await call(financeControls,'payments','GET',{}, {...user,role:'editor'})).status,403);
assert.deepEqual((await call(financeControls,'transfers','GET',{}, {...user,organization_id:other})).transfers,[]);
const collaborator=await insert("insert into agency_collaborators(organization_id,full_name) values($1,'Contractor')",[org]);
verified((await call(operations,'payouts','POST',{collaborator_id:collaborator,account_id:cash,amount:10,reference:'Payout',paid_on:'2026-09-11'})).payout);
verified((await call(operations,'payouts')).payouts[0]);
verified((await call(operations,'referral-discounts','POST',{invoice_id:invoice,amount:10,referrer:'Referral',reason:'Reward'})).discount);
verified((await call(operations,'referral-discounts')).discounts[0]);

r=await call(inviteLinks,'invite-links','POST',{mode:'approval',role:'editor'});verified(r);const link=r.id;
await query('begin');await claimInvite({query},link,{email:'outside@example.invalid',name:'Declared applicant',email_verified:true});await query('commit');
r=await call(inviteLinks,'access-requests');const pending=r.requests[0];unverified(pending);assert.equal(pending.actor_name,'Declared applicant');
assert.equal((await query('select 1 from organization_members where organization_id=$1 and user_id=$2',[org,outsider])).rows.length,0);
assert.equal((await call(inviteLinks,`access-requests/${pending.id}`,'PATCH',{action:'approve'})).status,200);
r=await call(inviteLinks,'invite-links');verified(r.links[0]);verified(r.links[0].joined_users[0],'Declared applicant',null);
// Public invite previews do not resolve or expose the creator/applicants.
let preview;
const publicDb={query:async(sql,params)=>{assert(!sql.includes('organization_person_identity'));return query(sql,params);},connect:db.connect};
const previewLink=await call(inviteLinks,'invite-links','POST',{mode:'approval',role:'editor'});
await inviteLinks({req:{method:'GET'},res:{},url:new URL('https://test/api/invitations/preview?token='+new URL(previewLink.url).searchParams.get('token')),
 db:publicDb,session:async()=>null,send:(_,status,data)=>preview={status,...data}});
assert.equal(preview.status,200);assert(!JSON.stringify(preview).includes('actor_'));assert(!JSON.stringify(preview).includes('actor@example.invalid'));
const direct=await call(inviteLinks,'invite-links','POST',{mode:'single',role:'viewer'});
await query('begin');await claimInvite({query},direct.id,{email:'direct@example.invalid',name:'Direct member',email_verified:true});await query('commit');
r=await call(inviteLinks,'invite-links');verified(r.links.find(l=>l.id===direct.id).joined_users[0],'Direct member',null);
assert.equal((await call(inviteLinks,'invite-links','GET',{}, {...user,role:'editor'})).status,403);

await call(presence,'presence/heartbeat','POST',{tab_id:'33333333-3333-4333-a333-333333333333',visible:true,active:true,project_id:project});
r=await call(presence,'presence/usage');verified(r.people.find(p=>p.id===owner));
verified((await call(presence,`presence/usage?userId=${owner}`)).records[0]);
verified((await call(presence,`presence/project?projectId=${project}`)).people[0]);
assert.equal((await call(presence,'presence/usage','GET',{}, {...user,role:'admin'})).status,403);
assert.deepEqual((await call(presence,`presence/usage?userId=${owner}`,'GET',{}, {...user,organization_id:other})).records,[]);
verified((await call(workChecklists,`work-orders/${order}/checklist/items`,'POST',{text:'Check',expected_version:'0'})).items[0]);
r=await call(productivity,'templates','POST',{name:'Template',items:[{title:'Item',day:1,hours:1}]});verified(r.template);const template=r.template.id;
verified((await call(productivity,'templates')).templates[0]);
verified((await call(automationApi,'schedules','POST',{template_id:template,project_id:project,next_month:'2026-10-01'})).schedule);
verified((await call(automationApi,'schedules')).schedules[0]);
await insert("insert into agency_inventory_reservations(organization_id,project_id,title,starts_at,ends_at,created_by_user_id,return_user_id,checked_out_by_user_id,returned_by_user_id) values($1,$2,'Reservation',now(),now()+interval '1 hour',$3,$3,$3,$3)",[org,project,owner]);
r=await call(inventoryReservations,'inventory-reservations');verified(r.reservations[0]);assert.equal(r.reservations[0].checkout_actor_verified,true);assert.equal(r.reservations[0].return_actor_photo_url,photo);
await insert("insert into agency_content_reviews(organization_id,work_order_id,token_hash,title,asset_url,version_stamp,expires_at,created_by_user_id,reviewer_name) values($1,$2,'hash','Review','https://example.invalid/asset','stamp',now()+interval '1 day',$3,'Client declared name')",[org,order,owner]);
r=await call(contentReview,`work-orders/${order}/client-review`);verified(r.reviews[0]);unverified(r.reviews[0].reviewer_actor);
assert.equal((await call(contentReview,`work-orders/${order}/client-review`,'GET',{},null)).status,401);
assert.equal((await call(contentReview,`work-orders/${order}/client-review`,'GET',{}, {...user,organization_id:other})).status,404);
const publicToken='a'.repeat(64);
await query('update agency_content_reviews set token_hash=$1 where work_order_id=$2',[crypto.createHash('sha256').update(publicToken).digest('hex'),order]);
let publicStatus,html;
await contentReview({req:{method:'GET'},res:{writeHead(status){publicStatus=status;},end(value){html=value;}},
 url:new URL('https://test/review/'+publicToken),session:async()=>{throw Error('Public review must not resolve a session');},
 db:{connect:async()=>({query:publicDb.query,release(){}})},send(){throw Error('Public review must remain HTML');}});
assert.equal(publicStatus,200);for(const secret of ['actor_name','actor_photo_url','Ana Pérez',photo,'actor@example.invalid'])assert(!html.includes(secret),secret);
await query("insert into agency_archived_records(organization_id,kind,record_id,removed_by) values($1,'work-orders',$2,$3)",[org,order,owner]);
verified((await call(recordLifecycle,'trash')).records[0]);

// Importer is never substituted for a source author, even if the names match.
await query("insert into agency_source_events(organization_id,source_key,source_url,source_author,body,occurred_at,imported_by) values($1,'source','https://example.invalid/source','Ana Pérez','Imported',now(),$2)",[org,owner]);
r=await call(productivity,'source-events');unverified(r.records[0]);assert.equal(r.records[0].actor_name,'Ana Pérez');
// A forged explicit ID still cannot resolve an identity from another tenant.
const unknown=await insert("insert into users(email,password_hash) values('unknown@example.invalid','!')");
await query("insert into agency_user_profiles(organization_id,user_id,full_name,photo_url) values($1,$2,'Unlinked profile','https://example.invalid/private.png')",[org,unknown]);
await query('insert into agency_project_comments(organization_id,project_id,author_user_id,body) values($1,$2,$3,$4)',[org,project,unknown,'Unlinked']);
r=await call(operations,`projects/${project}/comments`);unverified(r.comments.find(c=>c.body==='Unlinked'));
const rows=[{uid:'client-link'},{uid:null},{uid:'999999999999999999999999'},{uid:owner}];let lookups=0;
await attributeActors({query:async(...args)=>{lookups++;return query(...args);}},org,[{rows,userId:'uid'}]);assert.equal(lookups,1);rows.slice(0,3).forEach(unverified);verified(rows[3]);
// Removing access keeps legacy evidence, but cannot expose a live verified profile.
await query('update organization_members set active=false,removed_at=now() where organization_id=$1 and user_id=$2',[org,owner]);
r=await call(operations,`projects/${project}/comments`,'GET',{}, {...user,id:reader});unverified(r.comments[0]);assert.equal(r.comments[0].author_email,'actor@example.invalid');
r=await call(inviteLinks,'invite-links','GET',{}, {...user,id:reader});r.links.forEach(unverified);
assert.equal((await query('select full_name from agency_user_profiles where organization_id=$1 and user_id=$2',[org,owner])).rows[0].full_name,'Ana Pérez');
await pg.close();
console.log('Actor attribution: comments, finance, invites, requests, usage, checklists, templates, schedules, reservations, reviews, trash, imports and identity boundaries passed.');
