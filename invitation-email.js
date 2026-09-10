const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const singleLine=value=>String(value??'').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g,' ').trim();
function appLink(appUrl){
 const url=new URL(appUrl);
 if(url.protocol!=='https:'||url.username||url.password)throw new Error('Email URL must use HTTPS without credentials');
 return url;
}
const roles={owner:'Dueño',admin:'Administrador',management:'Gerencia',finance:'Finanzas',sales:'Ventas',production:'Producción',editor:'Editor',viewer:'Solo lectura'};
export function invitationEmail({email,organizationName,role,appUrl}){
 const url=appLink(appUrl);
 const organization=singleLine(organizationName),permission=Object.hasOwn(roles,role)?roles[role]:'Solo lectura';
 const subject=`Invitación a ${organization} · Scale OS`.slice(0,160);
 const text=`Te invitaron a ${organization}\n\nTu permiso: ${permission}\nCorreo con acceso: ${email}\n\nAbrí Scale OS: ${url.href}\n\nIngresá con Google usando ese mismo correo. Si preferís una contraseña y todavía no tenés una, elegí «Establecer o recuperar contraseña» en el inicio de sesión.\n\nSi participás en varias empresas, podrás elegir en cuál trabajar.\n\n¿No esperabas esta invitación? Podés ignorarla. No se crea una cuenta de Google ni se comparte tu acceso con otras personas.\n\nScale OS · Gestión de agencias\nNotificación de acceso enviada por Owncoding.`;
 const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#F7F6F8;color:#251C29;font:16px/1.6 Arial,sans-serif"><table role="presentation" style="width:100%;border:0"><tr><td style="padding:24px 12px"><main style="max-width:560px;margin:auto;background:#fff;border:1px solid #E8E3EA;border-radius:16px;padding:28px"><p style="margin:0 0 24px;color:#4D065B;font-weight:bold">Scale OS</p><h1 style="font-size:26px;line-height:1.3;margin:0 0 20px">Te invitaron a ${escape(organization)}</h1><p>Ya podés acceder al espacio de trabajo de esta empresa.</p><p><strong>Tu permiso:</strong> ${escape(permission)}<br><strong>Correo con acceso:</strong> ${escape(email)}</p><p style="margin:28px 0"><a href="${escape(url.href)}" style="display:inline-block;padding:12px 20px;background:#4D065B;color:#fff;border-radius:8px;text-decoration:none;font-weight:bold">Abrir Scale OS</a></p><p>Ingresá con Google usando ese mismo correo. Si preferís una contraseña y todavía no tenés una, elegí <strong>Establecer o recuperar contraseña</strong> en el inicio de sesión.</p><p>Si participás en varias empresas, podrás elegir en cuál trabajar.</p><p style="font-size:13px;overflow-wrap:anywhere">Si el botón no abre, copiá esta dirección en tu navegador:<br>${escape(url.href)}</p><hr style="border:0;border-top:1px solid #E8E3EA;margin:24px 0"><p style="font-size:13px;color:#746C78">¿No esperabas esta invitación? Podés ignorarla. No se crea una cuenta de Google ni se comparte tu acceso con otras personas.</p><p style="font-size:12px;color:#746C78;margin-bottom:0">Scale OS · Gestión de agencias<br>Notificación de acceso enviada por Owncoding.</p></main></td></tr></table></body></html>`;
 return{subject,text,html};
}

// The caller supplies the existing one-use token; this template grants no access.
export function resetEmail({token,appUrl}){
 if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))throw new Error('Invalid password reset token');
 const url=appLink(appUrl);
 url.pathname=url.pathname.replace(/\/$/,'')+'/';
 url.search='';url.hash='';url.searchParams.set('resetToken',token);
 const subject='Establecé tu contraseña de Scale OS';
 const instructions='Este enlace es de un solo uso y vence en una hora. Si no lo solicitaste, ignorá este correo.';
 const text=`Tu contraseña de Scale OS\n\n${instructions}\n\nEstablecer contraseña: ${url.href}\n\nScale OS · Gestión de agencias\nNotificación de acceso enviada por Owncoding.`;
 const html=`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main style="font:16px/1.6 Arial,sans-serif;max-width:560px;margin:auto;padding:24px"><p>Scale OS</p><h1>Tu contraseña</h1><p>${instructions}</p><p><a href="${escape(url.href)}">Establecer contraseña</a></p><p style="font-size:13px;overflow-wrap:anywhere">Si el botón no abre, copiá esta dirección en tu navegador:<br>${escape(url.href)}</p><hr><p style="font-size:12px">Scale OS · Gestión de agencias<br>Notificación de acceso enviada por Owncoding.</p></main></body></html>`;
 return{subject,text,html};
}
