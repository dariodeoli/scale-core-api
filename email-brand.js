// Shared branded email shell. Template version v1.0.2: Scale OS visual identity
// with a plum header, magenta CTA and a muted footer. Table-based and email-safe.
export const EMAIL_TEMPLATE_VERSION='v1.0.2';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const line=value=>String(value??'').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g,' ').trim();

export function emailShell({eyebrow='Scale OS',title='',lead='',body='',cta=null,footer='',footerNote=''}){
 const safeEyebrow=escape(line(eyebrow));
 const safeTitle=escape(line(title));
 const ctaBlock=cta?.label&&cta?.href
  ?`<p style="margin:28px 0 4px;text-align:center"><a href="${escape(cta.href)}" style="display:inline-block;padding:13px 26px;border-radius:999px;background:linear-gradient(135deg,#c05fd8,#7a1f8f);color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px">${escape(cta.label)}</a></p>`+
   `<p style="margin:0 0 20px;text-align:center;font-size:12px;color:#746c78;overflow-wrap:anywhere">Si el botón no abre, copiá esta dirección en tu navegador:<br>${escape(cta.href)}</p>`
  :'';
 const safeFooter=line(footer);
 const safeFooterNote=line(footerNote);
 return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="template-version" content="${EMAIL_TEMPLATE_VERSION}"></head><body style="margin:0;background:#f4f2f5;color:#251c29;font:16px/1.6 Arial,sans-serif"><table role="presentation" style="width:100%;border:0"><tr><td style="padding:28px 12px"><main style="max-width:560px;margin:auto;background:#ffffff;border:1px solid #e8e3ea;border-radius:18px;overflow:hidden"><div style="background:linear-gradient(120deg,#31003c,#4d065b 62%,#6b1592);padding:16px 28px"><p style="margin:0;color:#f7acff;font-size:11px;font-weight:800;letter-spacing:.16em;text-transform:uppercase">${safeEyebrow}</p></div><div style="padding:26px 28px 28px"><h1 style="font-size:24px;line-height:1.3;margin:0 0 14px">${safeTitle}</h1>${lead?`<p style="margin:0 0 16px">${lead}</p>`:''}${body}${ctaBlock}${safeFooter?`<hr style="border:0;border-top:1px solid #e8e3ea;margin:22px 0 16px"><p style="font-size:13px;color:#746c78;margin:0">${safeFooter}</p>`:''}${safeFooterNote?`<p style="font-size:11px;color:#9a929f;margin:14px 0 0">${safeFooterNote}</p>`:''}</div></main></td></tr></table></body></html>`;
}

export function emailText({title,instructions,url,footer='Scale OS · Gestión de agencias',note=''}){
 return `${title}\n\n${instructions}\n\n${url?`${url}\n\n`:''}${footer}${note?`\n${note}`:''}`;
}
