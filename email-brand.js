// Shared branded email shell. Template version v1.0.3: tighter spacing, single
// CTA with a subtle fallback link, and no repeated identity. Table-based.
export const EMAIL_TEMPLATE_VERSION='v1.0.3';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const line=value=>String(value??'').replace(/[\u0000-\u001f\u007f\u2028\u2029]/g,' ').trim();

export function emailShell({eyebrow='Scale OS',title='',lead='',body='',cta=null,footer='',footerNote=''}){
 const safeEyebrow=escape(line(eyebrow));
 const safeTitle=escape(line(title));
 const safeLead=escape(lead);
 const ctaBlock=cta?.label&&cta?.href
  ?`<p style="margin:24px 0 0;text-align:center"><a href="${escape(cta.href)}" style="display:inline-block;padding:12px 24px;border-radius:999px;background:linear-gradient(135deg,#c05fd8,#7a1f8f);color:#ffffff;text-decoration:none;font-weight:bold;font-size:14px">${escape(cta.label)}</a></p>`+
   `<p style="margin:10px 0 0;text-align:center;font-size:11px;color:#9a929f;overflow-wrap:anywhere">Si el botón no abre, copiá esta dirección:<br>${escape(cta.href)}</p>`
  :'';
 // El contrato del shell escapa todo lo dinámico: el pie incluido.
 const safeFooter=escape(line(footer));
 const safeFooterNote=escape(line(footerNote));
 return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="template-version" content="${EMAIL_TEMPLATE_VERSION}"></head><body style="margin:0;background:#f4f2f5;color:#251c29;font:16px/1.6 Arial,sans-serif"><table role="presentation" style="width:100%;border:0"><tr><td style="padding:24px 12px"><main style="max-width:560px;margin:auto;background:#ffffff;border:1px solid #e8e3ea;border-radius:16px;overflow:hidden"><div style="background:linear-gradient(120deg,#31003c,#4d065b 62%,#6b1592);padding:13px 26px"><p style="margin:0;color:#f7acff;font-size:10px;font-weight:800;letter-spacing:.16em;text-transform:uppercase">${safeEyebrow}</p></div><div style="padding:22px 26px 24px"><h1 style="font-size:22px;line-height:1.3;margin:0 0 12px">${safeTitle}</h1>${safeLead?`<p style="margin:0 0 14px;color:#4b4252">${safeLead}</p>`:''}${body}${ctaBlock}${safeFooter?`<hr style="border:0;border-top:1px solid #e8e3ea;margin:18px 0 12px"><p style="font-size:12px;color:#746c78;margin:0">${safeFooter}</p>`:''}${safeFooterNote?`<p style="font-size:10.5px;color:#9a929f;margin:12px 0 0">${safeFooterNote}</p>`:''}</div></main></td></tr></table></body></html>`;
}

