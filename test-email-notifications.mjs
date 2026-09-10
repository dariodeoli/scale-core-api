import assert from 'node:assert/strict';
import {notificationEmail} from './notifications.js';

const input={title:'Entrega pendiente: Reel\r\nRevisar audio',body:'Primera línea\nSegunda línea',organization_name:'Prueba & equipo',work_order_id:12};
const mail=notificationEmail(input,'https://app.scaleparaguay.com');
assert.ok(!/[\u0000-\u001f\u007f\u2028\u2029]/.test(mail.subject),'The subject must be a single header-safe line');
assert.equal(mail.subject,'Entrega pendiente: Reel  Revisar audio');
assert.ok(mail.text.includes(input.title),'Keep the original title in the plain-text body');
assert.ok(mail.html.includes('Prueba &amp; equipo'));
assert.ok(mail.html.includes('href="https://app.scaleparaguay.com/resumen?order=12"'));
assert.ok(mail.text.includes('Preferencias'));
for(const title of ['Nombre\u0000 oculto','Título\u2028otra línea','Título\u2029otra línea','Título\tcon tabulación','x'.repeat(170)]){
 const result=notificationEmail({...input,title},'https://app.scaleparaguay.com');
 assert.ok(result.subject.length<=160);
 assert.ok(!/[\u0000-\u001f\u007f\u2028\u2029]/.test(result.subject));
}
assert.equal(notificationEmail({...input,title:'Entrega pendiente: Reel'},'https://app.scaleparaguay.com').subject,'Entrega pendiente: Reel');
console.log('PASS: notification subject controls removed, length bounded, ordinary subjects/body/links/preferences preserved; no email sent');
