import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {clientPortal} from './client-portal.js';

const pg=new PGlite();
for(const file of ['schema.sql','migrations/20260908_google_oauth.sql','migrations/20260908_treasury_ledger.sql','migrations/20260908_people_commissions_comments.sql','migrations/20260908_operations_complete.sql','migrations/20260908_referral_discounts.sql','migrations/20260908_collaborator_profiles.sql','migrations/20260908_agency_suite.sql','migrations/20260908_daily_controls.sql','migrations/20260910_productivity.sql','migrations/20260910_work_checklists.sql','migrations/20260910_demo_sessions.sql','migrations/20260910_notifications.sql','migrations/20260910_project_assignees.sql','migrations/20260910_invite_links.sql','migrations/20260910_global_identity.sql','migrations/20260912_client_portal.sql','migrations/20260912_client_portal_password_resets.sql','migrations/20260913_client_portal_vertical_slice.sql','migrations/20260913_ruc_collaboration.sql','migrations/20260914_production_traceability.sql'])await pg.exec(await fs.readFile(file,'utf8'));
const query=(sql,params)=>pg.query(sql,params),db={query,connect:async()=>({query,release(){}})};
const org=(await query("select id from organizations where slug='scale'")).rows[0].id;
const owner=(await query("insert into users(email,password_hash) values('portal-owner@example.invalid','unused') returning id")).rows[0].id;
await query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org,owner]);
const employee={id:owner,organization_id:org,role:'owner'};
const resetMails=[];
async function call(path,{method='GET',payload={},actor=employee,cookie='',origin,emailAvailable=true}={}){
 let result={};const req={method,headers:{cookie,...(origin?{origin}:{})},socket:{remoteAddress:'127.0.0.1'}};
 const args={req,res:{writeHead(status,headers){result={status,headers};},end(content){result.content=content;}},url:new URL('https://test'+path),db,session:async()=>actor,body:async()=>payload,send:(_,status,data,headers={})=>{result={status,...data,headers};},emailAvailable,sendPasswordReset:async(address,raw)=>{resetMails.push({address,raw});}};
 assert.equal(await clientPortal(args),true);return result;
}
const clientA=(await query("insert into agency_clients(organization_id,name) values($1,'Cliente A') returning id",[org])).rows[0].id;
const clientB=(await query("insert into agency_clients(organization_id,name) values($1,'Cliente B') returning id",[org])).rows[0].id;
const projectA=(await query("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Proyecto A') returning id",[org,clientA])).rows[0].id;
const projectB=(await query("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Proyecto B') returning id",[org,clientB])).rows[0].id;
const orderA=(await query("insert into agency_work_orders(organization_id,project_id,title,status,assigned_user_id) values($1,$2,'Entrega A','approved',$3) returning id",[org,projectA,owner])).rows[0].id;
const orderB=(await query("insert into agency_work_orders(organization_id,project_id,title,status) values($1,$2,'Entrega B','approved') returning id",[org,projectB])).rows[0].id;
const publishedA=await call(`/api/agency/work-orders/${orderA}/client-portal-delivery`,{method:'POST',payload:{assetUrl:'https://drive.google.com/a',assetName:'Archivo A'}});assert.equal(publishedA.status,200,publishedA.error);
assert.equal((await call(`/api/agency/work-orders/${orderB}/client-portal-delivery`,{method:'POST',payload:{assetUrl:'https://drive.google.com/b',assetName:'Archivo B'}})).status,200);
const created=await call(`/api/agency/clients/${clientA}/client-portal-invites`,{method:'POST',payload:{email:'cliente@example.invalid'}});assert.equal(created.status,201);assert.match(created.url,/^https:\/\/app\.scaleparaguay\.com\/cliente\/invitacion\?token=/);const inviteToken=new URL(created.url).searchParams.get('token');assert.ok(inviteToken);
assert.equal((await call('/api/client-portal/invites/preview?token='+inviteToken,{actor:null})).status,200);
const originalPassword='Orquidea-seguro-123!';
assert.equal((await call('/api/client-portal/invites/accept',{method:'POST',actor:null,payload:{token:inviteToken,fullName:'Cliente QA',password:originalPassword}})).status,201);
const accepted=await call('/api/client-portal/invites/accept',{method:'POST',actor:null,payload:{token:inviteToken,fullName:'Cliente QA',password:originalPassword}});assert.equal(accepted.status,410);assert.equal(accepted.link_status,'used');
const revokedInvite=await call(`/api/agency/clients/${clientA}/client-portal-invites`,{method:'POST',payload:{email:'revoked@example.invalid'}});const revokedToken=new URL(revokedInvite.url).searchParams.get('token');assert.equal((await call(`/api/agency/client-portal-invites/${revokedInvite.invite.id}/revoke`,{method:'POST'})).status,200);const revokedPreview=await call('/api/client-portal/invites/preview?token='+revokedToken,{actor:null});assert.equal(revokedPreview.status,410);assert.equal(revokedPreview.link_status,'revoked');
const revokedAccept=await call('/api/client-portal/invites/accept',{method:'POST',actor:null,payload:{token:revokedToken,fullName:'Revocada QA',password:'Nunca-vigente-123!'}});assert.equal(revokedAccept.status,410);assert.equal(revokedAccept.link_status,'revoked','revoking an invite prevents first use');
const expiredInvite=await call(`/api/agency/clients/${clientA}/client-portal-invites`,{method:'POST',payload:{email:'expired@example.invalid'}});const expiredToken=new URL(expiredInvite.url).searchParams.get('token');await query("update client_portal_invites set expires_at=now()-interval '1 second' where email_normalized='expired@example.invalid'");const expiredPreview=await call('/api/client-portal/invites/preview?token='+expiredToken,{actor:null});assert.equal(expiredPreview.status,410);assert.equal(expiredPreview.link_status,'expired');
const session=(await query('select token_hash from client_portal_sessions')).rows[0].token_hash; // raw token is returned only in Set-Cookie; obtain it from prior response below instead.
const login=await call('/api/client-portal/auth/login',{method:'POST',actor:null,payload:{email:'cliente@example.invalid',password:originalPassword}});assert.equal(login.status,200);const sessionCookie=login.headers['Set-Cookie'];assert.match(sessionCookie,/__Host-scale_client_session=/);
const passwordRequest=await call('/api/client-portal/auth/password/request',{method:'POST',actor:null,payload:{email:'cliente@example.invalid'}});assert.equal(passwordRequest.status,202);assert.equal(resetMails.length,1);
const replacementPassword='Portal-nuevo-456!';
assert.equal((await call('/api/client-portal/auth/password/reset',{method:'POST',actor:null,payload:{token:resetMails[0].raw,password:replacementPassword,email:'cliente@example.invalid'}})).status,200);
assert.equal((await call('/api/client-portal/auth/login',{method:'POST',actor:null,payload:{email:'cliente@example.invalid',password:originalPassword}})).status,401,'old portal password is invalid after reset');
const renewedLogin=await call('/api/client-portal/auth/login',{method:'POST',actor:null,payload:{email:'cliente@example.invalid',password:replacementPassword}});assert.equal(renewedLogin.status,200,'new portal password signs in');
assert.equal((await call('/api/client-portal/auth/password/reset',{method:'POST',actor:null,payload:{token:resetMails[0].raw,password:'Otro-password-789!',email:'cliente@example.invalid'}})).status,400,'a reset token is single-use');
const renewedSessionCookie=renewedLogin.headers['Set-Cookie'];
const list=await call('/api/client-portal/deliveries',{actor:null,cookie:renewedSessionCookie});assert.equal(list.status,200);assert.equal(list.deliveries.length,1);assert.equal(list.deliveries[0].title,'Entrega A');
assert.equal((await call(`/api/client-portal/deliveries/${orderB}`,{actor:null,cookie:renewedSessionCookie})).status,404,'work-order IDs are not portal delivery IDs');
const deliveryId=list.deliveries[0].id;assert.equal((await call(`/api/client-portal/deliveries/999999`,{actor:null,cookie:renewedSessionCookie})).status,404);
const detail=await call(`/api/client-portal/deliveries/${deliveryId}`,{actor:null,cookie:renewedSessionCookie});assert.equal(detail.status,200);assert.equal(Object.hasOwn(detail.delivery,'asset_url'),false,'asset URL stays behind the download redirect boundary');
const download=await call(`/api/client-portal/deliveries/${deliveryId}/download`,{actor:null,cookie:renewedSessionCookie});assert.equal(download.status,302);assert.equal(download.headers.Location,'https://drive.google.com/a');assert.equal(download.content,undefined,'the agency server never streams or proxies the asset');assert.equal((await query('select count(*)::int as count from client_portal_delivery_downloads where delivery_id=$1',[deliveryId])).rows[0].count,1,'authorized download is audited before redirect');
const commentPosted=await call(`/api/client-portal/deliveries/${deliveryId}/comments`,{method:'POST',actor:null,cookie:renewedSessionCookie,payload:{body:'Listo para publicar'}});assert.equal(commentPosted.status,201);
const commentNotice=(await query('select * from agency_notifications where dedupe_key=$1',[`portal-comment-${deliveryId}-${commentPosted.comment.id}`])).rows[0];
assert.ok(commentNotice,'a client comment enqueues an internal notification for the assigned user');
assert.equal(String(commentNotice.user_id),String(owner));assert.equal(commentNotice.kind,'comment');assert.equal(commentNotice.title,'Comentario del cliente en Entrega A');assert.equal(commentNotice.body,'Listo para publicar');assert.equal(String(commentNotice.work_order_id),String(orderA));assert.equal(String(commentNotice.project_id),String(projectA));assert.equal(commentNotice.comment_id,null,'portal comments live outside the internal comment table');
assert.equal((await call(`/api/client-portal/deliveries/${deliveryId}/decision`,{method:'POST',actor:null,cookie:renewedSessionCookie,payload:{decision:'changes_requested'}})).status,400);
assert.equal((await call(`/api/client-portal/deliveries/${deliveryId}/decision`,{method:'POST',actor:null,cookie:renewedSessionCookie,payload:{decision:'changes_requested',comment:'Ajustar el cierre del video'}})).status,200);
const portalActor=(await query("select id from client_portal_users where email_normalized='cliente@example.invalid'")).rows[0];
const decisionDedupe=`portal-decision-${deliveryId}-1-${portalActor.id}`;
const decisionNotice=(await query('select * from agency_notifications where dedupe_key=$1',[decisionDedupe])).rows[0];
assert.ok(decisionNotice,'a client decision enqueues an internal notification for the assigned user');
assert.equal(String(decisionNotice.user_id),String(owner));assert.equal(decisionNotice.kind,'comment');assert.equal(decisionNotice.title,'El cliente pidió cambios en Entrega A');assert.equal(decisionNotice.body,'Ajustar el cierre del video');
assert.equal((await call(`/api/client-portal/deliveries/${deliveryId}/decision`,{method:'POST',actor:null,cookie:renewedSessionCookie,payload:{decision:'approved',comment:'Revisamos y está aprobado'}})).status,200);
assert.equal((await query('select count(*)::int as count from agency_notifications where dedupe_key=$1',[decisionDedupe])).rows[0].count,1,'re-deciding the same version never duplicates the internal notification');
assert.equal((await query('select status from agency_work_orders where id=$1',[orderA])).rows[0].status,'approved','la decisión del cliente no modifica el estado interno');
assert.equal((await call(`/api/client-portal/deliveries/${deliveryId}/comments`,{method:'POST',actor:null,cookie:renewedSessionCookie,origin:'https://evil.example',payload:{body:'Intento externo'}})).status,403,'el portal rechaza escrituras desde otro origen');
const otherInvite=await call(`/api/agency/clients/${clientB}/client-portal-invites`,{method:'POST',payload:{email:'cliente@example.invalid'}});const otherToken=new URL(otherInvite.url).searchParams.get('token');assert.equal((await call('/api/client-portal/invites/accept',{method:'POST',actor:null,payload:{token:otherToken,fullName:'Cliente QA',password:replacementPassword}})).status,409,'one portal account cannot be attached to a second client');
assert.equal((await call(`/api/agency/work-orders/${orderA}/client-portal-delivery`,{method:'PATCH',payload:{visible:false}})).status,200);
assert.equal((await call('/api/client-portal/deliveries',{actor:null,cookie:renewedSessionCookie})).deliveries.length,0,'revoked delivery disappears immediately');
assert.equal(session.length,64);

// CP-4: only links explicitly marked client-visible reach the portal detail.
await query("insert into agency_work_order_links(organization_id,work_order_id,label,url,created_by_user_id) values($1,$2,'Oculto','https://drive.google.com/oculto',$3)",[org,orderA,owner]);
await query("insert into agency_work_order_links(organization_id,work_order_id,label,url,created_by_user_id,visible_to_client) values($1,$2,'Aprobación','https://drive.google.com/aprobacion',$3,true)",[org,orderA,owner]);
// CP-2 (issue #26): invitar y revocar clientes sigue al ADR — portal-access.manage
// para owner/admin/management/production; collaborator ya no participa.
for(const role of ['owner','admin','management','production'])assert.equal((await call(`/api/agency/clients/${clientA}/client-portal-invites`,{method:'POST',payload:{email:`invite-${role}@example.invalid`},actor:{...employee,role}})).status,201,`${role} invita clientes del portal`);
for(const role of ['collaborator','editor','viewer','finance','sales'])assert.equal((await call(`/api/agency/clients/${clientA}/client-portal-invites`,{method:'POST',payload:{email:'no-role@example.invalid'},actor:{...employee,role}})).status,403,`${role} no invita clientes del portal`);
assert.equal((await call(`/api/agency/clients/${clientA}/client-portal-invites`,{actor:{...employee,role:'collaborator'}})).status,403,'collaborator tampoco lista los accesos del portal');
// Publicar entregas y revisiones sigue con portal.manage: collaborator no cambia.
assert.equal((await call(`/api/agency/work-orders/${orderA}/client-portal-delivery`,{method:'PATCH',payload:{visible:true},actor:{...employee,role:'collaborator'}})).status,200,'collaborator sigue publicando entregas');
assert.equal((await call(`/api/agency/clients/${clientA}/client-portal-invites`,{method:'POST',payload:{email:'no-role@example.invalid'},actor:{...employee,role:'editor'}})).status,403,'editor no invita clientes del portal');
// CP-3: a delivery in review can never be published to the portal.
const orderReview=(await query("insert into agency_work_orders(organization_id,project_id,title,status) values($1,$2,'En revisión','review') returning id",[org,projectA])).rows[0].id;
assert.equal((await call(`/api/agency/work-orders/${orderReview}/client-portal-delivery`,{method:'POST',payload:{assetUrl:'https://drive.google.com/review',assetName:'Revisión'}})).status,409,'review status is not publishable');
// Republish bumps the version; the audited bump joins the activity log.
assert.equal((await call(`/api/agency/work-orders/${orderA}/client-portal-delivery`,{method:'POST',payload:{assetUrl:'https://drive.google.com/a-v2',assetName:'Archivo A v2'}})).status,200);
const activity=await call(`/api/client-portal/deliveries/${deliveryId}/activity`,{actor:null,cookie:renewedSessionCookie});
assert.equal(activity.status,200);assert.ok(Array.isArray(activity.activity));
const kinds=activity.activity.map(entry=>entry.kind);
assert.ok(kinds.includes('comment'),'comments join the activity log');
assert.ok(kinds.includes('decision'),'decisions join the activity log');
assert.ok(kinds.includes('download'),'downloads join the activity log');
assert.ok(kinds.includes('version'),'version bumps join the activity log');
assert.equal(activity.activity.find(entry=>entry.kind==='version').version,2);
for(let i=1;i<activity.activity.length;i++)assert.ok(new Date(activity.activity[i-1].at)<=new Date(activity.activity[i].at),'activity renders chronologically');
const detailLinks=await call(`/api/client-portal/deliveries/${deliveryId}`,{actor:null,cookie:renewedSessionCookie});
assert.deepEqual(detailLinks.links.map(link=>link.label),['Aprobación'],'unmarked links never reach the portal');
assert.equal(Object.hasOwn(detailLinks.delivery,'asset_url'),false,'the asset URL stays behind the download redirect');
// CP-1 empty log: a freshly published delivery has no activity entries.
const orderSilent=(await query("insert into agency_work_orders(organization_id,project_id,title,status) values($1,$2,'Entrega silenciosa','approved') returning id",[org,projectA])).rows[0].id;
assert.equal((await call(`/api/agency/work-orders/${orderSilent}/client-portal-delivery`,{method:'POST',payload:{assetUrl:'https://drive.google.com/silent',assetName:'Silenciosa'}})).status,200);
const silentId=(await query('select id from client_portal_deliveries where work_order_id=$1',[orderSilent])).rows[0].id;
const silentActivity=await call(`/api/client-portal/deliveries/${silentId}/activity`,{actor:null,cookie:renewedSessionCookie});
assert.equal(silentActivity.status,200);assert.deepEqual(silentActivity.activity,[],'empty state renders for a delivery without activity');
// CP-2 own-client scope: another client's delivery is unreachable.
const deliveryB=(await query('select id from client_portal_deliveries where work_order_id=$1',[orderB])).rows[0].id;
assert.equal((await call(`/api/client-portal/deliveries/${deliveryB}/activity`,{actor:null,cookie:renewedSessionCookie})).status,404,'a granted client never reads another client delivery');
assert.equal((await call(`/api/client-portal/deliveries/${deliveryB}`,{actor:null,cookie:renewedSessionCookie})).status,404);
// CP-5: revoking a grant immediately invalidates its portal sessions.
const clientC=(await query("insert into agency_clients(organization_id,name) values($1,'Cliente C') returning id",[org])).rows[0].id;
const projectC=(await query("insert into agency_projects(organization_id,client_id,name) values($1,$2,'Proyecto C') returning id",[org,clientC])).rows[0].id;
const orderC=(await query("insert into agency_work_orders(organization_id,project_id,title,status,assigned_user_id) values($1,$2,'Entrega C','approved',$3) returning id",[org,projectC,owner])).rows[0].id;
assert.equal((await call(`/api/agency/work-orders/${orderC}/client-portal-delivery`,{method:'POST',payload:{assetUrl:'https://drive.google.com/c',assetName:'Archivo C'}})).status,200);
const revokeeInvite=await call(`/api/agency/clients/${clientC}/client-portal-invites`,{method:'POST',payload:{email:'revokeme@example.invalid'}});
const revokeeAccept=await call('/api/client-portal/invites/accept',{method:'POST',actor:null,payload:{token:new URL(revokeeInvite.url).searchParams.get('token'),fullName:'Revocable QA',password:'Portal-revocable-123!'}});
assert.equal(revokeeAccept.status,201);const revokeeCookie=revokeeAccept.headers['Set-Cookie'];
assert.equal((await call('/api/client-portal/deliveries',{actor:null,cookie:revokeeCookie})).status,200,'the fresh grant reaches its own delivery list');
const revokeeUser=(await query("select id from client_portal_users where email_normalized='revokeme@example.invalid'")).rows[0];
assert.equal((await query('select count(*)::int as count from client_portal_sessions where portal_user_id=$1',[revokeeUser.id])).rows[0].count,1,'accepting the invite opens one portal session');
const accessBefore=(await call(`/api/agency/clients/${clientC}/client-portal-invites`)).grants;
const revokeeGrant=accessBefore.find(g=>g.active===true&&g.email==='revokeme@example.invalid');assert.ok(revokeeGrant,'the portal-access list exposes the active grant');
assert.equal((await call(`/api/agency/clients/${clientC}/portal-access/grants/${revokeeGrant.id}/revoke`,{method:'POST'})).status,200);
assert.equal((await call('/api/client-portal/deliveries',{actor:null,cookie:revokeeCookie})).status,401,'revoking a grant immediately invalidates its portal sessions');
assert.equal((await query('select count(*)::int as count from client_portal_sessions where portal_user_id=$1',[revokeeUser.id])).rows[0].count,0,'the revoked grant leaves no portal session behind');
const accessAfter=(await call(`/api/agency/clients/${clientC}/client-portal-invites`)).grants;
assert.ok(!accessAfter.some(g=>g.active===true&&String(g.id)===String(revokeeGrant.id)),'the revoked grant disappears from the active access list');
assert.ok(accessAfter.some(g=>String(g.id)===String(revokeeGrant.id)&&g.active===false&&g.revoked_at),'the revoke is timestamped on the grant row');
assert.equal((await call(`/api/agency/clients/${clientC}/portal-access/grants/${revokeeGrant.id}/revoke`,{method:'POST'})).status,404,'an already revoked grant cannot be revoked again');
assert.equal((await call(`/api/agency/clients/${clientC}/portal-access/grants/${revokeeGrant.id}/revoke`,{method:'POST',actor:{...employee,role:'editor'}})).status,403,'only portal managers revoke grants');
// CP-8: the enqueue path respects the recipient preference table.
await query('insert into agency_notification_preferences(organization_id,user_id,comment) values($1,$2,false)',[org,owner]);
const mutedComment=await call(`/api/client-portal/deliveries/${deliveryId}/comments`,{method:'POST',actor:null,cookie:renewedSessionCookie,payload:{body:'Comentario silencioso'}});
assert.equal(mutedComment.status,201);
assert.equal((await query('select count(*)::int as count from agency_notifications where dedupe_key=$1',[`portal-comment-${deliveryId}-${mutedComment.comment.id}`])).rows[0].count,0,'a member with comment notifications disabled is never notified');
assert.equal(session.length,64);await pg.close();console.log('PASS: isolated client identities, one-client accounts, authorized delivery downloads, comments, decisions and revocation, client-visible link filtering, scoped activity logs, private-by-default portal exposure, internal notifications for portal comments and decisions and immediate grant revocation');
