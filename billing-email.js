import {emailShell} from './email-brand.js';
const line=value=>String(value??'').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g,' ').trim();
function appLink(appUrl){
 const url=new URL(appUrl);
 if(url.protocol!=='https:'||url.username||url.password)throw new Error('Email URL must use HTTPS without credentials');
 return url;
}
// Fechas visibles en hora de Asunción (el servidor corre en UTC).
const formatDate=value=>{const date=value?new Date(value):null;return date&&!Number.isNaN(date.getTime())?new Intl.DateTimeFormat('es-PY',{day:'numeric',month:'long',year:'numeric',timeZone:'America/Asuncion'}).format(date):null;};

export function trialStartedEmail({email,organizationName,trialEndsOn,appUrl}){
 const url=appLink(appUrl),organization=line(organizationName),ends=formatDate(trialEndsOn);
 const subject=`Tu prueba de 30 días comenzó · ${organization}`.slice(0,160);
 const text=`Tu prueba de ${organization} comenzó\n\nTenés 30 días para probar todos los módulos con tu equipo, sin tarjeta. La prueba empieza con el alta de tu cuenta.\n\nEntrar a Scale OS: ${url.href}\n\nScale OS · Gestión de agencias`;
 const html=emailShell({
  eyebrow:organization,
  title:'Tu prueba de 30 días comenzó',
  lead:'Todos los módulos incluidos para tu equipo. Sin tarjeta para iniciar.',
  body:ends?`<p style="margin:0;font-size:13px;color:#4b4252">Tu prueba vence el <strong>${ends}</strong>. Después podés continuar con el plan mensual.</p>`:'',
  cta:{label:'Entrar a Scale OS',href:url.href},
  footerNote:'Scale OS · Gestión de agencias',
 });
 return{subject,text,html};
}

export function paymentFailedEmail({organizationName,appUrl}){
 const url=appLink(appUrl),organization=line(organizationName);
 const subject=`No pudimos cobrar tu suscripción de ${organization}`.slice(0,160);
 const text=`No pudimos cobrar tu suscripción de ${organization}\n\nTenés 2 días de gracia para regularizarla. Al tercer día sin pagar se suspende el acceso, sin borrar tus datos.\n\nRevisar mi suscripción: ${url.href}\n\nScale OS · Gestión de agencias`;
 const html=emailShell({
  eyebrow:organization,
  title:'No pudimos cobrar tu suscripción',
  lead:'El pago mensual no se completó. Tenés 2 días de gracia para regularizarla; al tercer día sin pagar se suspende el acceso, sin borrar tus datos.',
  cta:{label:'Revisar mi suscripción',href:url.href},
  footer:'Si ya pagaste con otro medio, contactá al administrador para registrar el pago manual.',
  footerNote:'Scale OS · Gestión de agencias',
 });
 return{subject,text,html};
}
