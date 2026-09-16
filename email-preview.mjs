// Renders every transactional email template to a local HTML file for review.
import {writeFileSync} from 'node:fs';
import {invitationEmail,resetEmail,verificationEmail,destructiveReauthEmail} from './invitation-email.js';
import {notificationEmail} from './notifications.js';
import {clientPortalResetEmail} from './client-portal.js';
import {EMAIL_TEMPLATE_VERSION} from './email-brand.js';

const appUrl='https://app.scaleparaguay.com';
const samples=[
 {label:'Invitación',message:invitationEmail({email:'dariodeoli@gmail.com',organizationName:'Scale Strategy Group',role:'editor',appUrl})},
 {label:'Establecer contraseña',message:resetEmail({token:'a'.repeat(64),appUrl})},
 {label:'Verificar correo',message:verificationEmail({token:'b'.repeat(64),appUrl})},
 {label:'Código de eliminación',message:destructiveReauthEmail({code:'12345678'})},
 {label:'Notificación operativa',message:notificationEmail({title:'Nueva pieza lista para revisión',body:'Cliente Asisteck · Proyecto Campaña Septiembre · Pieza "Spot 30s"',organization_name:'Scale Strategy Group',work_order_id:'42'},appUrl)},
 {label:'Portal de cliente · contraseña',message:clientPortalResetEmail({token:'c'.repeat(64)})},
];
const body=samples.map(({label,message})=>`<section style="border:1px solid #ddd;border-radius:10px;padding:12px;margin:16px 0"><h2 style="margin:4px 0">${label}</h2><p style="margin:4px 0;color:#555"><strong>Asunto:</strong> ${message.subject}</p><iframe title="${label}" style="width:100%;height:640px;border:0" srcdoc="${message.html.replace(/"/g,'&quot;')}"></iframe><details><summary>Texto plano</summary><pre style="white-space:pre-wrap">${message.text}</pre></details></section>`).join('\n');
const page=`<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Correos Scale OS · ${EMAIL_TEMPLATE_VERSION}</title></head><body style="font:14px/1.5 Arial,sans-serif;max-width:900px;margin:auto;padding:24px"><h1>Correos Scale OS · ${EMAIL_TEMPLATE_VERSION}</h1>${body}</body></html>`;
const out='/tmp/scale-emails-v1.0.3.html';
writeFileSync(out,page);
console.log(out);
