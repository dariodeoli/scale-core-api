import {externalLink} from './media-policy.js';
const fail=()=>{throw Object.assign(Error('Revisá los enlaces: usá HTTPS, sin contraseñas, y hasta 10 enlaces adicionales.'),{status:400});};
export function clientLinks(value){
 if(value==null)return {};
 if(typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['website','instagram','whatsapp','other'].includes(k)))fail();
 const result={};for(const key of ['website','instagram','whatsapp']){
  const url=externalLink(value[key]);if(url){const host=new URL(url).hostname.toLowerCase();if(key==='instagram'&&host!=='instagram.com'&&!host.endsWith('.instagram.com'))fail();if(key==='whatsapp'&&!['wa.me','api.whatsapp.com','web.whatsapp.com','chat.whatsapp.com','www.whatsapp.com','whatsapp.com'].includes(host))fail();result[key]=url;}
 }
 if(value.other!==undefined){if(!Array.isArray(value.other)||value.other.length>10)fail();result.other=value.other.map(item=>{if(!item||typeof item.label!=='string'||!item.label.trim()||item.label.length>60)fail();const url=externalLink(item.url);if(!url)fail();return{label:item.label.trim(),url};});}
 return result;
}
