const senderPattern=/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

function senderAddress(value){
 const sender=typeof value==='string'?value.trim():'';
 if(!sender||/[\r\n\u0000]/.test(sender))return null;
 const bracketed=sender.match(/^(?:[^<>\r\n]{1,120}\s)?<([^<>\s]+)>$/);
 const address=(bracketed?bracketed[1]:sender).trim().toLowerCase();
 return senderPattern.test(address)?sender:null;
}

function secureAppUrl(value){
 try{
  const url=new URL(value);
  return url.protocol==='https:'&&!url.username&&!url.password?url.href.replace(/\/$/,''):null;
 }catch{return null;}
}

export function emailDeliveryStatus({apiKey,from,appUrl}={}){
 const providerConfigured=typeof apiKey==='string'&&apiKey.trim().length>=8;
 const sender=senderAddress(from);
 const safeAppUrl=secureAppUrl(appUrl);
 const missing=[];
 if(!providerConfigured)missing.push('provider');
 if(!sender)missing.push('sender');
 if(!safeAppUrl)missing.push('application_url');
 return {
  available:missing.length===0,
  provider:'resend',
  sender,
  appUrl:safeAppUrl,
  missing,
  message:missing.length===0
   ?'El correo de acceso está disponible.'
   :'El registro y la recuperación por correo no están disponibles temporalmente. Usá Google o contactá al administrador.',
 };
}

// This function intentionally reports only provider acceptance. It never
// claims inbox delivery, and it never includes credentials in logs or output.
export function createEmailDelivery({apiKey,from,appUrl,fetcher=fetch}={}){
 const status=emailDeliveryStatus({apiKey,from,appUrl});
 async function send({to,message,idempotencyKey}){
  if(!status.available)return false;
  try{
   const headers={Authorization:`Bearer ${apiKey.trim()}`,'Content-Type':'application/json'};
   if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
   const response=await fetcher('https://api.resend.com/emails',{
    method:'POST',signal:AbortSignal.timeout(10000),headers,
    body:JSON.stringify({from:status.sender,to:[to],...message}),
   });
   return response.ok;
  }catch{return false;}
 }
 return {status,send};
}

export function publicEmailDeliveryStatus(status){
 return {
  available:status.available,
  provider:status.provider,
  message:status.message,
  // These booleans help clients choose Google/password flows without exposing
  // a key, sender address, internal host, or provider response details.
  passwordRegistration:status.available,
  passwordRecovery:status.available,
 };
}
