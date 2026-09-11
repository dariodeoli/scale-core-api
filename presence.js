import {attributeActors} from './actor-identity.js';
import {fail,optId,owned} from './suite-validation.js';
import {visibleRecord} from './record-lifecycle.js';
export async function presence({req,res,url,db,session,sessionKey,body,send}){
 const match=url.pathname.match(/^\/api\/agency\/presence\/(heartbeat|project|projects|usage)$/);if(!match)return false;
 let c,tx=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);const kind=match[1],org=user.organization_id;
  if(kind==='usage'&&user.role!=='owner')fail('Solo los dueños pueden consultar el uso del equipo',403);
  c=await db.connect();let result;
  if(kind==='heartbeat'&&req.method==='POST'){
   const b=await body(req);if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(b.tab_id))||typeof b.active!=='boolean'||typeof b.visible!=='boolean')fail('Presencia inválida');
   const project=optId(b.project_id);if(project)await owned(c,'agency_projects',project,org);
   if(!b.visible){await c.query('delete from agency_presence_tabs where organization_id=$1 and user_id=$2 and tab_id=$3',[org,user.id,b.tab_id]);result={ok:true};}
   else{
    await c.query('begin');tx=true;
    await c.query(`insert into agency_usage_sessions(organization_id,user_id,session_key,was_active) values($1,$2,$3,$4)
     on conflict(organization_id,user_id,session_key) do update set
     active_seconds=agency_usage_sessions.active_seconds+case when $4 and agency_usage_sessions.was_active and now()-agency_usage_sessions.last_seen_at<interval '75 seconds' then least(45,greatest(0,floor(extract(epoch from now()-agency_usage_sessions.last_seen_at))))::integer else 0 end,
     last_seen_at=now(),was_active=$4`,[org,user.id,sessionKey(req),b.active]);
    await c.query(`insert into agency_presence_tabs(organization_id,user_id,tab_id,project_id,is_active) values($1,$2,$3,$4,$5) on conflict(organization_id,user_id,tab_id) do update set project_id=$4,is_active=$5,last_seen_at=now()`,[org,user.id,b.tab_id,project,b.active]);
    await c.query('commit');tx=false;result={ok:true};
   }
  }else if(kind==='project'&&req.method==='GET'){
   const project=optId(url.searchParams.get('projectId'));if(!project)fail('Proyecto requerido');await owned(c,'agency_projects',project,org);
   result={people:(await c.query(`select p.user_id as id,coalesce(up.full_name,u.email) as name,up.photo_url,bool_or(p.is_active) as active from agency_presence_tabs p join users u on u.id=p.user_id join organization_members m on m.user_id=p.user_id and m.organization_id=p.organization_id left join agency_user_profiles up on up.user_id=p.user_id and up.organization_id=p.organization_id where p.organization_id=$1 and p.project_id=$2 and p.last_seen_at>now()-interval '75 seconds' and m.active and m.removed_at is null group by p.user_id,up.full_name,u.email,up.photo_url order by name limit 20`,[org,project])).rows};
  }else if(kind==='projects'&&req.method==='GET'){
   const raw=(url.searchParams.get('ids')||'').split(',');if(!raw.length||raw.length>100)fail('Elegí entre 1 y 100 proyectos');
   const ids=[...new Set(raw.map(value=>{if(!/^[0-9]{1,19}$/.test(value)||BigInt(value)<1n||BigInt(value)>9223372036854775807n)fail('Proyecto inválido');return String(BigInt(value));}))];
   result={people:(await c.query(`select p.project_id,p.user_id as id,coalesce(up.full_name,u.email) as name,up.photo_url,bool_or(p.is_active) as active
    from agency_presence_tabs p join agency_projects pr on pr.id=p.project_id and pr.organization_id=p.organization_id
    join agency_clients cl on cl.id=pr.client_id and cl.organization_id=pr.organization_id
    join users u on u.id=p.user_id join organization_members m on m.user_id=p.user_id and m.organization_id=p.organization_id
    left join agency_user_profiles up on up.user_id=p.user_id and up.organization_id=p.organization_id
    where p.organization_id=$1 and p.project_id=any($2::bigint[]) and ${visibleRecord('pr','projects')} and ${visibleRecord('cl','clients')} and m.active and m.removed_at is null and p.last_seen_at>now()-interval '75 seconds'
    group by p.project_id,p.user_id,up.full_name,u.email,up.photo_url order by p.project_id,name limit 2000`,[org,ids])).rows};
  }else if(kind==='usage'&&req.method==='GET'){
   const person=optId(url.searchParams.get('userId'));
   if(person){result={records:(await c.query(`select user_id,first_seen_at,last_seen_at,active_seconds from agency_usage_sessions where organization_id=$1 and user_id=$2 order by first_seen_at desc limit 10`,[org,person])).rows};}
   else result={people:(await c.query(`select u.id,coalesce(up.full_name,u.email) as name,u.email,
    (select max(last_seen_at) from agency_usage_sessions s where s.organization_id=m.organization_id and s.user_id=u.id) as last_seen_at,
    (select count(*)::int from agency_usage_sessions s where s.organization_id=m.organization_id and s.user_id=u.id and first_seen_at>now()-interval '30 days') as sessions,
    (select coalesce(sum(active_seconds),0)::int from agency_usage_sessions s where s.organization_id=m.organization_id and s.user_id=u.id and first_seen_at>now()-interval '30 days') as active_seconds,
    m.active and exists(select 1 from agency_presence_tabs p where p.organization_id=m.organization_id and p.user_id=u.id and p.last_seen_at>now()-interval '75 seconds') as online,
    m.active and exists(select 1 from agency_presence_tabs p where p.organization_id=m.organization_id and p.user_id=u.id and p.last_seen_at>now()-interval '75 seconds' and p.is_active) as active
    from organization_members m join users u on u.id=m.user_id left join agency_user_profiles up on up.user_id=u.id and up.organization_id=m.organization_id where m.organization_id=$1 and m.removed_at is null order by name`,[org])).rows};
  }else fail('Método no permitido',405);
  await attributeActors(c,org,[
   {rows:result.people,userId:'id',fallback:['name','email']},
   {rows:result.records,userId:'user_id'},
  ]);
  send(res,200,result);return true;
 }catch(error){if(tx)await c.query('rollback');console.error(JSON.stringify({event:'presence_error',status:error.status||500}));send(res,error.status||500,{error:error.status?error.message:'No se pudo consultar la presencia'});return true;}finally{c?.release();}
}
