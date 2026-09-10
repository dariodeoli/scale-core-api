const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const publicPath='/api/public/live-visitors/heartbeat';
const countsPath='/api/agency/live-visitors';
const adminOrigins=new Set(['https://app.scaleparaguay.com','https://admin.scaleparaguay.com','https://sistema.scaleparaguay.com']);
const adminHosts=new Set(['admin.scaleparaguay.com','app.scaleparaguay.com','sistema.scaleparaguay.com']);
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const responseHeaders={'Cache-Control':'no-store','Vary':'Origin'};

// Independent of the general JSON reader: cap even chunked requests at 256 bytes.
async function heartbeatBody(req){
 if(!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type']||''))fail('Formato no permitido',415);
 if(Number(req.headers['content-length'])>256)fail('Solicitud demasiado grande',413);
 let size=0;const chunks=[];
 for await(const chunk of req){const bytes=Buffer.from(chunk);size+=bytes.length;if(size>256)fail('Solicitud demasiado grande',413);chunks.push(bytes);}
 let b;try{b=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('Solicitud inválida');}
 if(!b||Array.isArray(b)||typeof b!=='object'||Object.keys(b).length!==2||
  typeof b.site!=='string'||!/^[-a-z0-9]{1,60}$/.test(b.site)||typeof b.session_id!=='string'||!uuid.test(b.session_id))fail('Visita inválida');
 return b;
}

export async function liveVisitors({req,res,url,db,session,send}){
 if(![publicPath,countsPath].includes(url.pathname))return false;
 let c,tx=false;
 try{
  if(url.search)fail('No se admiten filtros en esta ruta');
  const host=req.headers.host,origin=req.headers.origin;
  if(url.pathname===countsPath){
   if(req.method!=='GET')fail('Método no permitido',405);
   // A same-origin GET may omit Origin; authentication and tenant filtering still apply.
   if(!adminHosts.has(host)||(origin!==undefined&&!adminOrigins.has(origin))||req.headers['sec-fetch-site']==='cross-site')fail('Origen no permitido',403);
   const user=await session(req);if(!user)fail('No autenticado',401);
   if(!['owner','admin'].includes(user.role))fail('Solo dueños y administradores',403);
   if(user.demo_owner_user_id||user.organization_slug==='scale-demo-controles-20260908'){
    send(res,200,{organization_id:String(user.organization_id),estimated:true,synthetic:true,window_seconds:90,refresh_seconds:30,sites:[{site:'demo-website',label:'Web de ejemplo',active:3}]},responseHeaders);return true;
   }
   const sites=(await db.query(`select s.site_key as site,s.label,count(v.session_id)::integer as active
    from live_visitor_sites s join organizations o on o.id=s.organization_id
    left join live_visitor_sessions v on v.site_key=s.site_key and v.expires_at>now()
    where s.organization_id=$1 and s.enabled and o.active and o.demo_owner_user_id is null
    group by s.site_key,s.label order by s.site_key`,[user.organization_id])).rows;
   send(res,200,{organization_id:String(user.organization_id),estimated:true,synthetic:false,window_seconds:90,refresh_seconds:30,sites},responseHeaders);return true;
  }
  if(req.method!=='POST')fail('Método no permitido',405);
  if(typeof origin!=='string'||origin==='null'||typeof host!=='string')fail('Origen no permitido',403);
  const b=await heartbeatBody(req);
  c=await db.connect();await c.query('begin');tx=true;
  await c.query("set local statement_timeout='3000ms'");
  // Server-managed binding; the browser never supplies an organization or editable origin.
  const binding=(await c.query(`select s.site_key from live_visitor_sites s join organizations o on o.id=s.organization_id
   where s.site_key=$1 and $2=any(s.origins) and $3=any(s.request_hosts) and s.enabled and o.active and o.demo_owner_user_id is null
   for update of s`,[b.site,origin,host])).rows[0];
  if(!binding)fail('Sitio u origen no permitido',403);
  // A fixed row per configured site bounds storage and rate across API instances, without IPs.
  const allowed=(await c.query(`update live_visitor_sites set
   rate_count=case when rate_started_at<=now()-interval '1 minute' then 1 else rate_count+1 end,
   rate_started_at=case when rate_started_at<=now()-interval '1 minute' then now() else rate_started_at end
   where site_key=$1 and (rate_started_at<=now()-interval '1 minute' or rate_count<600) returning site_key`,[b.site])).rows.length;
  if(!allowed)fail('Límite temporal de visitas',429);
  await c.query('delete from live_visitor_sessions where site_key=$1 and expires_at<=now()',[b.site]);
  const recorded=(await c.query(`insert into live_visitor_sessions(site_key,session_id) values($1,$2)
   on conflict(site_key,session_id) do update set last_seen_at=now(),
    expires_at=least(now()+interval '90 seconds',live_visitor_sessions.first_seen_at+interval '15 minutes')
   where live_visitor_sessions.last_seen_at<=now()-interval '20 seconds' returning site_key`,[b.site,b.session_id])).rows.length;
  await c.query('commit');tx=false;
  if(!recorded)fail('Esperá antes de actualizar la visita',429);
  // No public readback, even for the submitting browser.
  send(res,202,{ok:true},responseHeaders);return true;
 }catch(error){
  if(tx)await c.query('rollback');
  send(res,error.status||500,{error:error.status?error.message:'Contador temporalmente no disponible'},
   {...responseHeaders,...(error.status===429?{'Retry-After':'30'}:{})});return true;
 }finally{c?.release();}
}

export async function purgeLiveVisitors(db){
 return db.query('delete from live_visitor_sessions where expires_at<=now()');
}

// Start after migrations. Physical retention <= ~150 s after the last heartbeat,
// even when no public traffic or Pipeline reader remains. No history is retained.
export function startLiveVisitorCleanup(db){
 let running=false,stopped=false;
 const clean=async()=>{if(stopped||running)return;running=true;try{await purgeLiveVisitors(db);}catch{console.error(JSON.stringify({event:'live_visitor_cleanup_error'}));}finally{running=false;}};
 void clean();const timer=setInterval(()=>void clean(),60000);timer.unref?.();
 return()=>{stopped=true;clearInterval(timer);};
}
