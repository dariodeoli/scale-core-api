import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import {currencies} from './currencies.js';
import {amount,date as validDate,email as validEmail,fail,items as validItems,option,text} from './suite-validation.js';
import {normalizeUrgency} from './urgency.js';
import {visibleRecord} from './record-lifecycle.js';
import {roleCan,roles} from './permissions.js';
import {externalLink,profilePhoto} from './media-policy.js';
import {email as normalizedEmail,phone as normalizedPhone} from './suite-validation.js';
import {budgetSections} from './budget-sections.js';
import {clientColor,clientLogo} from './client-identity.js';
import {assertUniqueClientRuc} from './ruc-lookup.js';
import {loginOrganization,defaultOrganizationId,setDefaultOrganization} from './default-organization.js';
import {privateDemoEntry,demoOrganization} from './demo-session.js';
import {enrichWorkOrderAssignees} from './work-order-assignees.js';
import {startTrial,subscriptionState} from './subscription-billing.js';
import {throttle} from './password-access.js';
import {ensurePipelineStages} from './pipeline-stages.js';

// Fuente única de roles: la lista canónica vive en permissions.js.
const memberRoles=roles;

// Legacy operational endpoints extracted from the server entrypoint. Handlers
// keep their original behavior and responses; the dispatcher returns true when
// a path is handled so the server router can fall through to newer modules.
export async function agencyCore({req,res,url,db,session,body,send:rawSend,cookie,parseCookies,id,requestSubscription,sendInvitation,sendTrialEmail,auditContext,auditedQuery}){
  let handled=false;
  const send=(...args)=>{handled=true;return rawSend(...args);};
  await (async()=>{
    if (url.pathname === '/api/auth/me') { const u=await session(req); if(!u) return send(res,401,{error:'No autenticado'}); let platform=null; try{platform=(await db.query('select role from platform_administrators where user_id=$1 and active=true',[u.id])).rows[0]||null;}catch{platform=null;} return send(res,200,{user:{...u,subscription:await requestSubscription(req,u),platform_admin:Boolean(platform),platform_role:platform?.role||null}}); }
    if (url.pathname === '/api/auth/organizations' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r=await db.query(`select o.id,o.slug,o.name,m.role,(o.demo_source_id is not null or o.slug='scale-demo-controles-20260908') as "isDemo" from organization_members m join organizations o on o.id=m.organization_id where m.user_id=$1 and o.active=true and m.active=true and m.removed_at is null and o.demo_owner_user_id is null order by o.name`,[user.id]);
      const demo=await privateDemoEntry(db,user.id);
      if(demo&&!r.rows.some(o=>String(o.id)===String(demo.id)))r.rows.push({...demo,isDemo:true});
      return send(res,200,{organizations:r.rows,currentOrganizationId:user.demo_source_id||user.organization_id,defaultOrganizationId:await defaultOrganizationId(db,user.id)});
    }
    if(url.pathname==='/api/auth/default-organization'&&req.method==='POST'){
      const user=await session(req);if(!user)return send(res,401,{error:'No autenticado'});
      return send(res,200,await setDefaultOrganization(db,user,await body(req)));
    }
    if(url.pathname==='/api/auth/organizations'&&req.method==='POST'){
      const user=await session(req);if(!user)return send(res,401,{error:'No autenticado'});
      if(!roleCan(user,'company.create'))return send(res,403,{error:'Solo administración puede crear una empresa'});
      const b=(await body(req))||{},name=typeof b.name==='string'?b.name.trim():'',slug=typeof b.slug==='string'?b.slug.trim().toLowerCase():'';
      // Igual que el registro y la invitación: el nombre no admite controles ni NUL.
      if(name.length<2||name.length>160||/[\u0000-\u001f\u007f]/.test(name)||!/^\w[\w-]{2,59}$/.test(slug))return send(res,400,{error:'Nombre y código de empresa inválidos'});
      if(b.billingCurrency!==undefined&&!['USD','PYG'].includes(b.billingCurrency))return send(res,400,{error:'Elegí USD o PYG para la suscripción'});
      const c=await db.connect();try{await c.query('begin');const org=(await c.query('insert into organizations(name,slug) values($1,$2) returning *',[name,slug])).rows[0];await c.query("insert into organization_members(organization_id,user_id,role) values($1,$2,'owner')",[org.id,user.id]);await ensurePipelineStages(c,org.id);await startTrial(c,org.id,b.billingCurrency||'USD');const trial=(await c.query('select trial_ends_at from organization_subscriptions where organization_id=$1',[org.id])).rows[0];await c.query('commit');if(typeof sendTrialEmail==='function')await sendTrialEmail(user.email,name,trial?.trial_ends_at??null).catch(()=>false);return send(res,201,{organization:org});}catch(e){await c.query('rollback');return send(res,e.code==='23505'?409:500,{error:e.code==='23505'?'Ese código ya está utilizado':'No se pudo crear la empresa'});}finally{c.release();}
    }
    if (url.pathname === '/api/auth/switch-organization' && req.method === 'POST') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      // La empresa se valida antes de tocar la base: un id inválido es 400, no un 500 de Postgres.
      const input=(await body(req))||{},raw=input.organizationId;
      if(!['number','string'].includes(typeof raw)||typeof raw==='number'&&!Number.isSafeInteger(raw)||! /^[1-9]\d{0,18}$/.test(String(raw))||BigInt(raw)>9223372036854775807n)return send(res,400,{error:'Empresa inválida'});
      const organizationId=String(raw);
      const c=await db.connect();
      try{
        await c.query('begin');
        const prior=(await c.query('select demo_key from sessions where id=$1 and user_id=$2 and expires_at>now() for update',[parseCookies(req).scale_session,user.id])).rows[0];
        if(!prior)throw Object.assign(Error('Sesión vencida'),{status:401});
        const org=await demoOrganization(c,{userId:user.id,sourceId:Number(organizationId),demoKey:prior.demo_key});
        const token=id();await c.query("insert into sessions(id,user_id,organization_id,demo_key,expires_at) values($1,$2,$3,$4,now()+interval '7 days')",[token,user.id,org,prior.demo_key]);
        await c.query('commit');
        return send(res,200,{ok:true},{'Set-Cookie':cookie('scale_session',token,604800)});
      }catch(e){await c.query('rollback');return send(res,e.status||500,{error:e.status?e.message:'No se pudo abrir la empresa'});}finally{c.release();}
    }
    if (url.pathname === '/api/events' && req.method === 'POST') {
      if(!await throttle(db,'events:public',2000))return send(res,429,{error:'Límite temporal. Intentá nuevamente más tarde.'});
      const {name,metadata={}}=await body(req);
      if(!/^[a-z0-9:_-]{1,80}$/i.test(name||'') || !metadata || Array.isArray(metadata) || typeof metadata !== 'object') return send(res,400,{error:'Evento inválido'});
      const scale=await db.query("select id from organizations where slug='scale'");
      await db.query('insert into events(name,metadata,organization_id) values($1,$2,$3)',[name,metadata,scale.rows[0].id]);
      return send(res,202,{ok:true});
    }
    if (url.pathname === '/api/metrics' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      if(!roleCan(user,'metrics.view')) return send(res,403,{error:'Sin permiso'});
      const from=url.searchParams.get('from') || new Date(Date.now()-366*86400000).toISOString().slice(0,10);
      const to=url.searchParams.get('to') || new Date().toISOString().slice(0,10);
      if(!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) return send(res,400,{error:'Rango inválido'});
      const r=await db.query("select name,event_date::text as event_date,count(*)::int as count from events where organization_id=$1 and event_date between $2 and $3 group by name,event_date order by event_date desc,name",[user.organization_id,from,to]);
      return send(res,200,{events:r.rows});
    }
    if (url.pathname === '/api/hub/organizations' && req.method === 'GET') {
      const user=await session(req); if(!roleCan(user,'company.create')) return send(res,403,{error:'Sin permiso'});
      const r=await db.query('select o.slug,o.name,o.active,m.role from organizations o join organization_members m on m.organization_id=o.id where m.user_id=$1 and m.active=true and m.removed_at is null order by o.name',[user.id]);
      return send(res,200,{organizations:r.rows});
    }
    if (url.pathname === '/api/hub/overview' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const candidates=(await db.query('select o.id,m.role from organizations o join organization_members m on m.organization_id=o.id where m.user_id=$1 and m.active and m.removed_at is null and o.active',[user.id])).rows;
      const allowed=[];for(const org of candidates){if((await subscriptionState(db,{...user,organization_id:org.id,role:org.role})).hasAccess)allowed.push(String(org.id));}
      // Hub metrics are an optional integration, not a dependency of Scale signup.
      // Missing integration means unavailable totals, never fabricated zero sales.
      if(!(await db.query("select to_regclass('public.hub_metric_values') as relation")).rows[0].relation){
        const organizations=(await db.query('select slug,name,null::numeric as revenue,null::numeric as collected,null::numeric as leads,null::numeric as sales from organizations where id=any($1::bigint[]) order by name',[allowed])).rows;
        return send(res,200,{organizations,metricsAvailable:false});
      }
      const r=await db.query(`select o.slug,o.name,
        coalesce(sum(case when v.metric_key='revenue' then v.value else 0 end),0)::numeric as revenue,
        coalesce(sum(case when v.metric_key='collected' then v.value else 0 end),0)::numeric as collected,
        coalesce(sum(case when v.metric_key='leads' then v.value else 0 end),0)::numeric as leads,
        coalesce(sum(case when v.metric_key='sales' then v.value else 0 end),0)::numeric as sales
        from organizations o join organization_members m on m.organization_id=o.id
        left join hub_metric_values v on v.organization_id=o.id and v.period_end >= current_date - interval '30 days'
        where m.user_id=$1 and m.active=true and m.removed_at is null and o.active=true and o.id=any($2::bigint[]) group by o.id order by o.name`,[user.id,allowed]);
      return send(res,200,{organizations:r.rows});
    }
    if (url.pathname === '/api/hub/metrics' && req.method === 'POST') {
      const integrationKey = process.env.HUB_INGEST_KEY;
      if (!integrationKey || req.headers['x-hub-integration-key'] !== integrationKey) return send(res,401,{error:'Clave de integración inválida'});
      const {organizationSlug, integrationSlug=null, metrics=[]}=await body(req);
      if(typeof organizationSlug !== 'string' || !Array.isArray(metrics) || !metrics.length || metrics.length > 100) return send(res,400,{error:'Payload de métricas inválido'});
      const org=await db.query('select id from organizations where slug=$1 and active=true',[organizationSlug]);
      if(!org.rows[0]) return send(res,404,{error:'Organización no encontrada'});
      const integration=integrationSlug ? await db.query('select id from hub_integrations where organization_id=$1 and slug=$2 and active=true',[org.rows[0].id,integrationSlug]) : {rows:[]};
      const client=await db.connect();
      try { await client.query('begin'); for(const metric of metrics) { if(typeof metric?.key !== 'string' || !Number.isFinite(Number(metric.value))) throw new Error('Métrica inválida'); await client.query('insert into hub_metric_values(organization_id,integration_id,metric_key,value,currency,period_start,period_end,metadata) values($1,$2,$3,$4,$5,$6,$7,$8)',[org.rows[0].id,integration.rows[0]?.id || null,metric.key,Number(metric.value),metric.currency || null,metric.periodStart || null,metric.periodEnd || null,metric.metadata || {}]); } await client.query('commit'); return send(res,202,{ok:true,accepted:metrics.length}); }
      catch(error) { await client.query('rollback'); return send(res,400,{error:error instanceof Error ? error.message : 'No se pudieron guardar las métricas'}); }
      finally { client.release(); }
    }
    if (url.pathname === '/api/agency/client-payment-status' && req.method === 'GET') {
      const user=await session(req); if(!roleCan(user,'billing.view')) return send(res,403,{error:'Sin permiso'});
      const status=url.searchParams.get('status');
      const statuses=['up_to_date','due_soon','late','severe'];
      if(status && !statuses.includes(status)) return send(res,400,{error:'Estado de cobro inválido'});
      const r=await db.query(`select * from client_payment_status where organization_id=$1 ${status ? 'and payment_status=$2' : ''} order by days_overdue desc, next_due_on nulls last, client_name`,status?[user.organization_id,status]:[user.organization_id]);
      return send(res,200,{clients:r.rows});
    }
    if (url.pathname === '/api/agency/clients' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r = await db.query(`select c.*,exists(select 1 from agency_client_commercial_terms t where t.organization_id=c.organization_id and t.client_id=c.id and t.effective_until is null and (t.cadence='monthly' or t.cadence='interval') and (t.ends_on is null or t.ends_on>=current_date)) as has_recurring_price from agency_clients c where organization_id=$1 and ${visibleRecord('c','clients')} order by active desc,name`,[user.organization_id]);
      return send(res,200,{clients:r.rows});
    }
    if (url.pathname === '/api/agency/clients' && req.method === 'POST') {
      const user = await session(req); if (!roleCan(user,'clients.manage')) return send(res,403,{error:'Sin permiso'});
      // Mismos límites que el PATCH del suite: nombre 120, RUC 60, razón social
      // 160 y notas 2000 (antes el alta guardaba cualquier largo y la edición
      // después rechazaba el registro).
      const incoming=await body(req);
      let name,contact,taxId,legalName,notes;
      try{
        name=text(incoming.name??'',120);if(name.length<2)fail('Ingresá el nombre');
        contact={email:normalizedEmail(incoming.email),phone:normalizedPhone(incoming.phone)};
        taxId=text(incoming.tax_id??'',60);
        legalName=text(incoming.legal_name??'',160);
        notes=text(incoming.notes??'');
      }catch(error){return send(res,error.status||400,{error:error.message||'Cliente inválido'});}
      const logo=await clientLogo(incoming.logo_url),color=clientColor(incoming.color_key);
      const client=await db.connect();
      try{
       await client.query('begin');await client.query('select id from organizations where id=$1 for update',[user.organization_id]);
       await assertUniqueClientRuc(client,user.organization_id,taxId);
       await client.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
       const r=await client.query('insert into agency_clients(name,email,phone,notes,organization_id,logo_url,color_key,tax_id,legal_name) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[name,contact.email,contact.phone,notes||null,user.organization_id,logo,color,taxId||null,legalName||null]);
       await client.query('commit');return send(res,201,{client:r.rows[0]});
      }catch(error){await client.query('rollback');return send(res,error.status||500,{error:error.status?error.message:'No se pudo crear el cliente'});}finally{client.release();}
    }
    if (url.pathname === '/api/agency/projects' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r=await db.query(`select p.*,c.name as client_name,coalesce((select jsonb_agg(jsonb_build_object('id',a.user_id::text,'full_name',coalesce(nullif(i.full_name,''),i.email),'photo_url',i.photo_url,'is_primary',a.is_primary) order by a.is_primary desc,a.user_id) from agency_record_assignees a join organization_person_identity i on i.organization_id=a.organization_id and i.user_id=a.user_id where a.organization_id=p.organization_id and a.kind='projects' and a.record_id=p.id),'[]'::jsonb) as assignees,count(o.id)::int as work_order_count from agency_projects p join agency_clients c on c.id=p.client_id left join agency_work_orders o on o.project_id=p.id and ${visibleRecord('o','work-orders')} where p.organization_id=$1 and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')} group by p.id,c.name order by p.active desc,p.created_at desc`,[user.organization_id]);
      return send(res,200,{projects:r.rows});
    }
    if (url.pathname === '/api/agency/projects' && req.method === 'POST') {
      const user = await session(req); if (!roleCan(user,'projects.manage')) return send(res,403,{error:'Sin permiso'});
      const {name='',clientId,driveUrl:rawDriveUrl=null,urgency=null}=await body(req);
      const driveUrl=externalLink(rawDriveUrl);
      if (typeof name !== 'string' || name.trim().length < 2 || !Number.isInteger(Number(clientId))) return send(res,400,{error:'Proyecto inválido'});
      const client=await db.query(`select id from agency_clients c where id=$1 and organization_id=$2 and ${visibleRecord('c','clients')}`,[Number(clientId),user.organization_id]);
      if(!client.rows[0]) return send(res,404,{error:'Cliente no encontrado'});
      const r=await auditedQuery(user,req,'insert into agency_projects(name,client_id,drive_url,organization_id,urgency) values($1,$2,$3,$4,$5) returning *',[name.trim(),Number(clientId),driveUrl||null,user.organization_id,normalizeUrgency(urgency)]);
      return send(res,201,{project:r.rows[0]});
    }
    if (url.pathname === '/api/agency/work-orders' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r=await db.query(`select o.*,p.name as project_name,c.name as client_name,u.email as assignee_email from agency_work_orders o join agency_projects p on p.id=o.project_id join agency_clients c on c.id=p.client_id left join users u on u.id=o.assigned_user_id where o.organization_id=$1 and ${visibleRecord('o','work-orders')} and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')} order by o.updated_at desc`,[user.organization_id]);
      await enrichWorkOrderAssignees(db,user.organization_id,r.rows);
      const ids=[...new Set(r.rows.map(row=>String(row.id)))];
      if(ids.length){
        const checklists=(await db.query(`select work_order_id,count(*)::int as checklist_total,count(*) filter(where completed)::int as checklist_completed from agency_work_checklist_items where organization_id=$1 and work_order_id=any($2::bigint[]) group by work_order_id`,[user.organization_id,ids])).rows;
        const byId=new Map(checklists.map(row=>[String(row.work_order_id),row]));
        for(const row of r.rows){const counts=byId.get(String(row.id));row.checklist_total=counts?.checklist_total||0;row.checklist_completed=counts?.checklist_completed||0;}
      } else for(const row of r.rows){row.checklist_total=0;row.checklist_completed=0;}
      return send(res,200,{workOrders:r.rows});
    }
    if (url.pathname === '/api/agency/work-orders' && req.method === 'POST') {
      const user = await session(req); if (!roleCan(user,'work-orders.edit')) return send(res,403,{error:'Sin permiso'});
      const {title='',projectId,status='to_record',description=null,driveUrl:rawDriveUrl=null,urgency=null,work_type=null,due_time=null}=await body(req);
      const driveUrl=externalLink(rawDriveUrl);
      const workType=work_type===undefined||work_type===null||work_type===''?null:['video','reedicion','foto','produccion','entregable'].includes(work_type)?work_type:null;
      if(work_type!==undefined&&work_type!==null&&work_type!==''&&workType===null) return send(res,400,{error:'Tipo de trabajo inválido'});
      const dueTime=due_time===undefined||due_time===null||due_time===''?null:/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(String(due_time))?String(due_time).slice(0,5):null;
      if((due_time!==undefined&&due_time!==null&&due_time!=='')&&dueTime===null) return send(res,400,{error:'Hora de entrega inválida'});
      const allowedStatuses=['blocked','to_record','recorded','editing','review'];
      if (typeof title !== 'string' || title.trim().length < 2 || !Number.isInteger(Number(projectId)) || !allowedStatuses.includes(status)) return send(res,400,{error:'Orden inválida'});
      const project=await db.query(`select p.id from agency_projects p join agency_clients c on c.id=p.client_id where p.id=$1 and p.organization_id=$2 and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')}`,[Number(projectId),user.organization_id]);
      if(!project.rows[0]) return send(res,404,{error:'Proyecto no encontrado'});
      const r=await auditedQuery(user,req,'insert into agency_work_orders(title,project_id,status,description,drive_url,organization_id,urgency,work_type,due_time) values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *',[title.trim(),Number(projectId),status,description||null,driveUrl||null,user.organization_id,normalizeUrgency(urgency),workType,dueTime]);
      return send(res,201,{workOrder:r.rows[0]});
    }
    if (url.pathname === '/api/agency/members' && req.method === 'GET') {
      const user = await session(req); if (!user) return send(res,401,{error:'No autenticado'}); if (!roleCan(user,'members.manage')) return send(res,403,{error:'Sin permiso'});
      const r = await db.query('select u.id,u.email,m.role,m.active,m.created_at from organization_members m join users u on u.id=m.user_id where m.organization_id=$1 and m.removed_at is null order by m.created_at asc',[user.organization_id]);
      return send(res,200,{members:r.rows});
    }
    if (url.pathname === '/api/agency/members' && req.method === 'POST') {
      const user = await session(req); if (!user) return send(res,401,{error:'No autenticado'}); if (!roleCan(user,'members.manage')) return send(res,403,{error:'Sin permiso'});
      const {email='',password='',role='viewer'} = await body(req);
      let normalizedEmail='';try{normalizedEmail=validEmail(email)||'';}catch{return send(res,400,{error:'Datos de invitación inválidos'});}
      if (!normalizedEmail || (password && (typeof password !== 'string' || password.length < 8)) || !memberRoles.includes(role) || (role === 'owner' && user.role !== 'owner')) return send(res,400,{error:'Datos de invitación inválidos'});
      const client = await db.connect();
      try {
        await client.query('begin');
        await auditContext(client,user,req);
        // Un huésped del Demo no puede iniciar sesión: crearle una membresía real
        // sería un acceso inutilizable. Se pide otro correo.
        const priorAccount=(await client.query('select id,is_demo_guest from users where email=$1',[normalizedEmail])).rows[0];
        if(priorAccount?.is_demo_guest){await client.query('rollback');return send(res,400,{error:'Ese correo pertenece a una cuenta de demostración. Invitá un correo real.'});}
        let account = {rows:priorAccount?[priorAccount]:[]};
        if (!account.rows[0]) {
          const hash = await bcrypt.hash(password || id(),12);
          account = await client.query('insert into users(email,password_hash,role) values($1,$2,$3) returning id',[normalizedEmail,hash,role]);
        }
        await client.query('select id from organizations where id=$1 for update',[user.organization_id]);
        const existing = await client.query('select removed_at from organization_members where organization_id=$1 and user_id=$2 for update',[user.organization_id,account.rows[0].id]);
        if (existing.rows[0]&&!existing.rows[0].removed_at) { await client.query('rollback'); return send(res,409,{error:'Ese usuario ya pertenece a esta empresa'}); }
        const membership = await client.query('insert into organization_members(organization_id,user_id,role) values($1,$2,$3) on conflict(organization_id,user_id) do update set role=excluded.role,active=true,removed_at=null,created_at=now() returning organization_id,user_id,role,created_at',[user.organization_id,account.rows[0].id,role]);
        await client.query('commit');
        const member={id:account.rows[0].id,email:normalizedEmail,...membership.rows[0]};
        const emailSent=await sendInvitation(normalizedEmail,user.organization_name,role).catch(()=>false);
        return send(res,201,{member,emailSent});
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }
    if (url.pathname.match(/^\/api\/agency\/members\/\d+\/photo$/) && req.method === 'PATCH') {
      const user = await session(req); if (!user) return send(res,401,{error:'No autenticado'}); if (!roleCan(user,'members.manage')) return send(res,403,{error:'Sin permiso'});
      const target = Number(url.pathname.split('/')[4]);
      if (!Number.isSafeInteger(target) || target <= 0) return send(res,400,{error:'Miembro inválido'});
      const {photo_url} = await body(req); if (typeof photo_url !== 'string') return send(res,400,{error:'Foto inválida'});
      let photo; try { photo = await profilePhoto(photo_url); } catch (error) { return send(res,400,{error:error.message||'Foto inválida'}); }
      const client = await db.connect();
      try {
        await client.query('begin');
        await auditContext(client,user,req);
        // Administration manages the member photo from the team directory: the
        // authorized org context lets identity_admin pass the owner-only guard,
        // and the membership check still applies inside the trigger.
        await client.query("select set_config('app.current_organization',$1,true),set_config('app.identity_admin','true',true)",[String(user.organization_id)]);
        const identity = await client.query(`select is_demo,coalesce((to_jsonb(i)->>'personal_in_demo')::boolean,false) as personal_in_demo,coalesce(nullif(full_name,''),email) as full_name from organization_person_identity i where user_id=$1 and organization_id=$2`,[target,user.organization_id]);
        if (!identity.rows[0]) { await client.query('rollback'); return send(res,404,{error:'Miembro no encontrado en esta empresa'}); }
        const saved = identity.rows[0].is_demo || identity.rows[0].personal_in_demo
          ? (await client.query('insert into agency_user_profiles(user_id,organization_id,full_name,photo_url) values($1,$2,$3,$4) on conflict(user_id,organization_id) do update set photo_url=excluded.photo_url,updated_at=now() returning full_name,photo_url',[target,user.organization_id,identity.rows[0].full_name,photo])).rows[0]
          : (await client.query(`insert into user_personal_identities(user_id,full_name,photo_url,photo_removed_at)
              select user_id,$3,$4,case when $4::text is null then now() else null end from organization_person_identity where user_id=$1 and organization_id=$2 and not is_demo
              on conflict(user_id) do update set photo_url=excluded.photo_url,photo_removed_at=excluded.photo_removed_at,updated_at=now() returning full_name,photo_url`,[target,user.organization_id,identity.rows[0].full_name,photo])).rows[0];
        await client.query('commit');
        return send(res,200,{member:{id:target,full_name:saved.full_name,photo_url:saved.photo_url}});
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }
    if (url.pathname === '/api/agency/budgets' && req.method === 'GET') {
      const user = await session(req); if (!roleCan(user,'budgets.manage')) return send(res,403,{error:'Sin permiso'});
      const r = await db.query(`select b.*,c.name as client_name,count(i.id)::int as item_count from agency_budgets b join agency_clients c on c.id=b.client_id left join agency_budget_items i on i.budget_id=b.id where b.organization_id=$1 and ${visibleRecord('b','budgets')} group by b.id,c.name order by b.created_at desc`,[user.organization_id]);
      return send(res,200,{budgets:r.rows});
    }
    if (url.pathname === '/api/agency/budgets' && req.method === 'POST') {
      const user = await session(req); if (!roleCan(user,'budgets.manage')) return send(res,403,{error:'Sin permiso'});
      // Mismos límites y redondeo que el PATCH del suite (título 160, ítems 1–100
      // con cantidad ≤999999, importes a 2 decimales y vigencia en fecha civil).
      const incoming=await body(req);
      let title,clientId,currency,list,notes,validUntil,normalizedSections;
      try{
        title=text(incoming.title??'',160);if(title.length<2)fail('Ingresá el título');
        clientId=Number(incoming.clientId);
        if(!Number.isInteger(clientId)||clientId<=0)fail('Cliente inválido');
        currency=option(Object.hasOwn(incoming,'currency')?incoming.currency:(user.default_currency??'PYG'),currencies);
        list=validItems(incoming.items);
        notes=text(incoming.notes??'');
        validUntil=validDate(incoming.validUntil??incoming.valid_until);
        normalizedSections=budgetSections(incoming.sections);
      }catch(error){return send(res,error.status||400,{error:error.message||'Presupuesto inválido'});}
      const taxRate=Number(incoming.tax_rate??.1);
      if(![0,.05,.1].includes(taxRate))return send(res,400,{error:'IVA inválido'});
      const subtotal=amount(list.reduce((sum,item)=>sum+item.total,0));
      const total=amount(subtotal*(1+taxRate));
      const client = await db.connect();
      try {
        await client.query('begin');
        const belongs = await client.query(`select id from agency_clients c where id=$1 and organization_id=$2 and ${visibleRecord('c','clients')}`,[clientId,user.organization_id]);
        await auditContext(client,user,req);
        if (!belongs.rows[0]) { await client.query('rollback'); return send(res,404,{error:'Cliente no encontrado'}); }
        const draft = await client.query('insert into agency_budgets(organization_id,client_id,number,title,currency,subtotal,total,notes,valid_until,public_token) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[user.organization_id,clientId,'PENDIENTE',title,currency,subtotal,total,notes || null,validUntil || null,crypto.randomBytes(18).toString('base64url')]);
        const number = `P-${new Date().getFullYear()}-${String(draft.rows[0].id).padStart(4,'0')}`;
        await client.query('update agency_budgets set tax_rate=$1,sections=$3 where id=$2',[taxRate,draft.rows[0].id,JSON.stringify(normalizedSections)]);
        const budget = await client.query('update agency_budgets set number=$1 where id=$2 returning *',[number,draft.rows[0].id]);
        for (const [position,item] of list.entries()) await client.query('insert into agency_budget_items(budget_id,position,description,quantity,unit_price,total) values($1,$2,$3,$4,$5,$6)',[budget.rows[0].id,position + 1,item.description,item.quantity,item.unitPrice,item.total]);
        await client.query('commit');
        return send(res,201,{budget:budget.rows[0]});
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    }
    if (url.pathname === '/api/agency/accounts' && req.method === 'GET') {
      const user=await session(req); if(!roleCan(user,'accounts.manage')) return send(res,403,{error:'Sin permiso'});
      const r=await db.query(`select a.*,u.email as custodian_email from bank_accounts a left join users u on u.id=a.custodian_user_id where a.organization_id=$1 and ${visibleRecord('a','accounts')} order by a.active desc,a.name`,[user.organization_id]);
      return send(res,200,{accounts:r.rows});
    }
    if (url.pathname === '/api/agency/accounts' && req.method === 'POST') {
      const user=await session(req); if(!roleCan(user,'accounts.manage')) return send(res,403,{error:'Sin permiso'});
      const {name='',accountType='bank',currency=user.default_currency??'PYG',institution=null,accountNumber=null,holderName=null,custodianUserId=null}=await body(req);
      if(typeof name !== 'string' || name.trim().length<2 || !['bank','cash','digital','investment'].includes(accountType) || !currencies.includes(currency)) return send(res,400,{error:'Cuenta inválida'});
      const custodianId=custodianUserId === null || custodianUserId === '' ? null : Number(custodianUserId);
      if(custodianId !== null && (!Number.isInteger(custodianId) || !(await db.query('select 1 from organization_members where organization_id=$1 and user_id=$2 and active and removed_at is null',[user.organization_id,custodianId])).rows[0])) return send(res,400,{error:'Custodio inválido'});
      const r=await auditedQuery(user,req,'insert into bank_accounts(organization_id,name,account_type,currency,institution,account_number,holder_name,custodian_user_id) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[user.organization_id,name.trim(),accountType,currency,typeof institution === 'string' ? institution.trim() || null : null,typeof accountNumber === 'string' ? accountNumber.trim() || null : null,typeof holderName === 'string' ? holderName.trim() || null : null,custodianId]);
      return send(res,201,{account:r.rows[0]});
    }
    if (url.pathname === '/api/agency/custodians' && req.method === 'GET') {
      const user=await session(req); if(!roleCan(user,'accounts.manage')) return send(res,403,{error:'Sin permiso'});
      const r=await db.query('select u.id,u.email,m.role from organization_members m join users u on u.id=m.user_id where m.organization_id=$1 and m.active=true order by u.email',[user.organization_id]);
      return send(res,200,{members:r.rows});
    }
    if (url.pathname === '/api/agency/invoices' && req.method === 'GET') {
      const user=await session(req); if(!roleCan(user,'invoices.manage')) return send(res,403,{error:'Sin permiso'});
      const requested=new URL(url,'https://scale.local').searchParams.get('limit');
      if(requested==='all'){
        const r=await db.query('select i.*,c.name as client_name from agency_invoices i join agency_clients c on c.id=i.client_id where i.organization_id=$1 order by i.created_at desc',[user.organization_id]);
        return send(res,200,{invoices:r.rows,hasMore:false});
      }
      const r=await db.query('select i.*,c.name as client_name from agency_invoices i join agency_clients c on c.id=i.client_id where i.organization_id=$1 order by i.created_at desc limit 21',[user.organization_id]);
      return send(res,200,{invoices:r.rows.slice(0,20),hasMore:r.rows.length>20});
    }
    if (url.pathname === '/api/agency/invoices' && req.method === 'POST') {
      const user=await session(req); if(!roleCan(user,'invoices.manage')) return send(res,403,{error:'Sin permiso'});
      const {clientId,total,currency=user.default_currency??'PYG',dueOn=null,notes=null}=await body(req); const amount=Number(total);
      if(!Number.isInteger(Number(clientId)) || !Number.isFinite(amount) || amount<0 || !currencies.includes(currency)) return send(res,400,{error:'Factura inválida'});
      const client=await db.query(`select id from agency_clients c where id=$1 and organization_id=$2 and ${visibleRecord('c','clients')}`,[Number(clientId),user.organization_id]); if(!client.rows[0]) return send(res,404,{error:'Cliente no encontrado'});
      const number=`F-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const r=await auditedQuery(user,req,'insert into agency_invoices(organization_id,client_id,number,total,currency,due_on,notes) values($1,$2,$3,$4,$5,$6,$7) returning *',[user.organization_id,Number(clientId),number,amount,currency,dueOn || null,notes || null]);
      return send(res,201,{invoice:r.rows[0]});
    }
    // /api/agency/payments y /api/agency/transfers los sirve finance-controls.js,
    // que corre antes que este módulo en server.js (issue #13). Las copias legacy
    // (billing.view/payments.manage/transfers.manage con validación más débil) se
    // retiraron: un reordenamiento del server no debe cambiar el comportamiento
    // en silencio.
    const orderMatch = url.pathname.match(/^\/api\/agency\/work-orders\/(\d+)$/);
    if (orderMatch && req.method === 'PATCH') {
      const user = await session(req); if (!roleCan(user,'work-orders.edit')) return send(res,403,{error:'Sin permiso'});
      const { status } = await body(req);
      const allowedStatuses=['blocked','to_record','recorded','editing','review','approved','published'];
      if (!allowedStatuses.includes(status)) return send(res,400,{error:'Estado inválido'});
      const r=await db.query('update agency_work_orders set status=$1,updated_at=now() where id=$2 and organization_id=$3 returning *',[status,Number(orderMatch[1]),user.organization_id]);
      if (!r.rows[0]) return send(res,404,{error:'Orden no encontrada'});
      return send(res,200,{workOrder:r.rows[0]});
    }
    if (url.pathname === '/api/agency/summary' && req.method === 'GET') {
      const user=await session(req); if(!user) return send(res,401,{error:'No autenticado'});
      const r=await db.query(`select (select count(*)::int from agency_clients c where organization_id=$1 and active=true and ${visibleRecord('c','clients')}) as active_clients, (select count(*)::int from agency_projects p join agency_clients c on c.id=p.client_id where p.organization_id=$1 and p.status='active' and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')}) as active_projects, (select count(*)::int from agency_work_orders o join agency_projects p on p.id=o.project_id join agency_clients c on c.id=p.client_id where o.organization_id=$1 and o.status not in ('approved','published') and ${visibleRecord('o','work-orders')} and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')}) as open_orders, (select count(*)::int from agency_budgets b where b.organization_id=$1 and b.status='sent' and ${visibleRecord('b','budgets')}) as unanswered_budgets, (select count(*)::int from agency_inventory i where i.organization_id=$1 and coalesce(i.status,'available')<>'retired' and (i.last_verified_at is null or i.last_verified_at<current_date-30) and ${visibleRecord('i','inventory')}) as unverified_inventory, (select count(*)::int from agency_work_orders o join agency_projects p on p.id=o.project_id join agency_clients c on c.id=p.client_id where o.organization_id=$1 and o.due_date>=current_date and o.due_date<current_date+7 and o.status not in ('approved','published') and ${visibleRecord('o','work-orders')} and ${visibleRecord('p','projects')} and ${visibleRecord('c','clients')}) as upcoming_deliveries`,[user.organization_id]);
      // Operational signals respect the same visibility as their modules: a
      // role that cannot open the source list receives null, never a number.
      const summary={...r.rows[0]};
      if(!roleCan(user,'budgets.manage'))summary.unanswered_budgets=null;
      if(!roleCan(user,'inventory.view'))summary.unverified_inventory=null;
      return send(res,200,{summary});
    }
  })();
  return handled;
}
