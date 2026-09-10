import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {board,plans,cards,internal} from './scale-source-data.mjs';
const applying=process.argv.includes('--apply'),cookiePath=process.env.SCALE_IMPORT_COOKIE;
if(!cookiePath)throw Error('SCALE_IMPORT_COOKIE must point to an authorized cookie jar');
const cookie=(await fs.readFile(cookiePath,'utf8')).split('\n').filter(l=>l.trim()&&(!l.startsWith('#')||l.startsWith('#HttpOnly_'))).map(l=>l.split('\t')).filter(a=>a.length>=7).map(a=>a[5]+'='+a[6]).join('; ');
async function api(path,data){const r=await fetch('https://admin.scaleparaguay.com'+path,{method:data?'POST':'GET',headers:{Cookie:cookie,...(data?{'Content-Type':'application/json'}:{})},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(20000)});const result=await r.json();if(!r.ok)throw Error(`${path}: ${r.status} ${result.error||'request failed'}`);return result;}
const me=(await api('/api/auth/me')).user;
if(String(me.organization_id)!=='1'||me.organization_slug!=='scale'||me.role!=='owner')throw Error('Expected owner of real Scale (organization 1, slug scale)');
const normalize=s=>s.normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase();
const currentPlans=(await api('/api/agency/plans')).records,currentClients=(await api('/api/agency/clients')).clients,currentProjects=(await api('/api/agency/projects')).projects,currentOrders=(await api('/api/agency/work-orders')).workOrders;
const note=`Fuente: Trello SCALE, captura 10/09/2026. ${board}. Responsables de Trello conservados como referencia; no se asignaron cuentas ni se enviaron invitaciones.`;
const report={plansCreated:0,clientsCreated:0,projectsCreated:0,ordersCreated:0,internalCount:internal.length,historyCreated:0};
if(!applying){console.log(JSON.stringify({mode:'preview',organization:me.organization_name,existing:{plans:currentPlans.length,clients:currentClients.length,projects:currentProjects.length,orders:currentOrders.length},source:{plans:plans.length,clients:new Set(cards.map(c=>c[0])).size,orders:cards.length,internal:internal.length}}));process.exit(0);}
for(const plan of plans){if(currentPlans.some(p=>normalize(p.name)===normalize(plan.name)))continue;await api('/api/agency/plans',plan);report.plansCreated++;}
for(const [clientName,title,status,description] of cards){
 let client=currentClients.find(c=>normalize(c.name)===normalize(clientName));
 if(!client){client=(await api('/api/agency/clients',{name:clientName,notes:note})).client;currentClients.push(client);report.clientsCreated++;}
 const projectName='Producción · Trello SCALE';
 let project=currentProjects.find(p=>String(p.client_id)===String(client.id)&&p.name===projectName);
 if(!project){project=(await api('/api/agency/projects',{name:projectName,clientId:client.id})).project;currentProjects.push(project);report.projectsCreated++;}
 if(currentOrders.some(o=>String(o.project_id)===String(project.id)&&o.title===title))continue;
 const order=(await api('/api/agency/work-orders',{title,projectId:project.id,status,description:`${description}\n\n${note}`})).workOrder;currentOrders.push(order);report.ordersCreated++;
}
for(const [title,description,due] of internal)await api('/api/agency/productivity/internal-tasks',{title,description:`${description}\n\n${note}`,due_date:due||null,source_key:'trello:'+crypto.createHash('sha256').update(title).digest('hex')});
if(process.env.SCALE_TRELLO_HISTORY){
 const raw=await fs.readFile(process.env.SCALE_TRELLO_HISTORY,'utf8');
 // Each event begins with the actor; retain narrative verbatim and source-local UTC-03 dates.
 const blocks=raw.split(/\n(?=Eric Baccon(?: ha | se | de ))/).filter(b=>b.startsWith('Eric Baccon')&&!b.startsWith('Eric Baccon ('));
 const events=blocks.map(b=>{const m=b.match(/([78]) sept 2026, (\d{2}):(\d{2})/);return m?{source_key:'trello-event:'+crypto.createHash('sha256').update(b.trim()).digest('hex'),source_url:board,source_author:'Eric Baccon (ericbaccon)',body:b.trim(),occurred_at:`2026-09-0${m[1]}T${m[2]}:${m[3]}:00-03:00`}:null;}).filter(Boolean);
 for(let i=0;i<events.length;i+=100)report.historyCreated+=(await api('/api/agency/productivity/source-events',{events:events.slice(i,i+100)})).created;
}
console.log(JSON.stringify({mode:'applied',...report}));
