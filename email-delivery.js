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

export function emailDeliveryStatus(options={}){
 const {apiKey,from,appUrl,weemRelayUrl:rawRelayUrl,weemRelayToken:rawRelayToken}=options;
 const weemRelayUrl=secureAppUrl(rawRelayUrl);
 const weemRelayToken=typeof rawRelayToken==='string'&&rawRelayToken.trim().length>=16;
 const relayConfigured=!!weemRelayUrl&&weemRelayToken;
 const relayAttempted=!!weemRelayUrl||typeof rawRelayToken==='string'&&rawRelayToken.trim().length>0;
 const providerConfigured=relayConfigured||(typeof apiKey==='string'&&apiKey.trim().length>=8&&!relayAttempted);
 const sender=senderAddress(from);
 const safeAppUrl=secureAppUrl(appUrl);
 const missing=[];
 if(!providerConfigured)missing.push('provider');
 if(!relayConfigured&&!sender)missing.push('sender');
 if(!safeAppUrl)missing.push('application_url');
 return {
  available:missing.length===0,
  provider:relayConfigured?'weem':'resend',
  sender:relayConfigured?'Scale OS vía WEEM':sender,
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
 const options=arguments[0]||{};
 const status=emailDeliveryStatus(options);
 const relayUrl=secureAppUrl(options.weemRelayUrl);
 const relayToken=typeof options.weemRelayToken==='string'?options.weemRelayToken.trim():'';
 async function send({to,message,idempotencyKey}){
  if(!status.available)return false;
  try{
   if(status.provider==='weem'){
    const headers={'X-WEEM-RELAY-TOKEN':relayToken,'Content-Type':'application/json'};
    if(idempotencyKey)headers['Idempotency-Key']=idempotencyKey;
    const response=await fetcher(relayUrl,{
     method:'POST',signal:AbortSignal.timeout(10000),headers,
     body:JSON.stringify({project:'scale-os',to:[to],...message}),
    });
    return response.ok;
   }
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
