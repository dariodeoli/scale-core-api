import assert from 'node:assert/strict';
import {invitationEmail,resetEmail} from './invitation-email.js';
const message=invitationEmail({email:'test@example.invalid',organizationName:'Agency & Partners <Test>\r\n',role:'editor',appUrl:'https://app.scaleparaguay.com'});
assert.equal(message.subject,'Invitación a Agency & Partners <Test> · Scale OS');
assert.ok(!message.subject.includes('\n'));
assert.ok(message.html.includes('Agency &amp; Partners &lt;Test&gt;'));
assert.ok(message.html.includes('test@example.invalid'));
assert.ok(message.text.includes('Tu permiso: Editor'));
assert.ok(message.text.includes('https://app.scaleparaguay.com/'));
assert.ok(message.html.includes('href="https://app.scaleparaguay.com/"'));
assert.ok(!message.html.includes('<img'));
assert.ok(message.html.length<12000);
assert.throws(()=>invitationEmail({email:'x',organizationName:'x',role:'viewer',appUrl:'javascript:alert(1)'}));
const input={email:'test@example.invalid',organizationName:'Agency',role:'viewer',appUrl:'https://app.scaleparaguay.com'};
for(const appUrl of ['http://app.scaleparaguay.com','https://name:password@app.scaleparaguay.com','https://name@app.scaleparaguay.com','//app.scaleparaguay.com','not a URL']){
 assert.throws(()=>invitationEmail({...input,appUrl}));
 assert.throws(()=>resetEmail({token:'a'.repeat(64),appUrl}));
}
for(const role of ['unknown','constructor','__proto__'])assert.ok(invitationEmail({...input,role}).text.includes('Tu permiso: Solo lectura'));
for(const [role,label] of Object.entries({owner:'Dueño',admin:'Administrador',management:'Gerencia',finance:'Finanzas',sales:'Ventas',production:'Producción',editor:'Editor',viewer:'Solo lectura'})){
 const result=invitationEmail({...input,role});
 assert.ok(result.text.includes('Tu permiso: '+label));
 assert.ok(result.html.includes('Tu permiso:</strong> '+label));
}
const long=invitationEmail({...input,organizationName:'Agency\u0000\u2028Bcc: test@example.invalid '+ 'x'.repeat(200)});
assert.ok(long.subject.length<=160);
assert.ok(!/[\u0000-\u001f\u007f\u2028\u2029]/.test(long.subject));
const directUrl='https://app.scaleparaguay.com/?invite=existing-link&mode=request';
const linked=invitationEmail({...input,appUrl:directUrl});
assert.ok(linked.text.includes(directUrl));
assert.ok(linked.html.includes('href="https://app.scaleparaguay.com/?invite=existing-link&amp;mode=request"'));
const token='a'.repeat(64),reset=resetEmail({token,appUrl:input.appUrl});
const resetUrl=`https://app.scaleparaguay.com/?resetToken=${token}`;
assert.ok(reset.text.includes(resetUrl));
assert.ok(reset.html.includes(`href="${resetUrl}"`));
assert.ok(reset.text.includes('un solo uso y vence en una hora'));
assert.ok(reset.html.includes('un solo uso y vence en una hora'));
const cleanReset=resetEmail({token,appUrl:input.appUrl+'/?invite=stale#fragment'});
assert.ok(cleanReset.text.includes(resetUrl));
assert.ok(!cleanReset.text.includes('stale')&&!cleanReset.text.includes('#fragment'));
for(const token of ['',null,123,'a'.repeat(63),'a'.repeat(65),'A'.repeat(64),'<img src=x>'])assert.throws(()=>resetEmail({token,appUrl:input.appUrl}));
for(const result of [message,linked,reset]){
 assert.deepEqual(Object.keys(result).sort(),['html','subject','text']);
 assert.ok(!/display\s*:\s*none|visibility\s*:\s*hidden|<img|<script|<iframe/i.test(result.html));
 assert.ok(result.html.length<12000);
 assert.ok(result.text.includes('Owncoding')&&result.html.includes('Owncoding'));
}
console.log('PASS: invitation and reset HTML/text, escaped identity, bounded subjects, all roles, safe direct HTTPS links, one-use token format, no hidden content or tracking');
