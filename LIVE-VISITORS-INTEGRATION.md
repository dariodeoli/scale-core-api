# Contador de visitantes — integración del agente principal

Integración implementada en `server.js` y `app/scale-workspace.tsx`. La web de la agencia ya incluye `assets/tracking/live-visitors.js` desde `index.html`, commit `scaleparaguay` `8357f390` (10-09-2026); su publicación y coincidencia del archivo servido quedaron verificadas en RELEASE-CHECKLIST.md. No volver a insertar el snippet ni duplicar la captura. Sigue pendiente la comprobación visual de visitantes reales en los hosts desplegados: pruebas aisladas, HTTP y CORS no sustituyen dos sesiones de navegador autorizadas.

## API

En `scale-core-api/server.js`:

```js
import {liveVisitors,startLiveVisitorCleanup} from './live-visitors.js';
```

Después de `20260910_demo_sessions.sql`, dentro de la transacción de migraciones existente:

```js
await migration.query(await fs.readFile(path.join(root,'migrations/20260910_live_visitors.sql'),'utf8'));
```

En el despachador, después de crear `url` y antes de `publicExperience`/las rutas generales:

```js
if(await liveVisitors({req,res,url,db,session,send}))return;
```

Después de que `init()` termine correctamente, iniciar **una sola vez por proceso**:

```js
const stopLiveVisitorCleanup=startLiveVisitorCleanup(db);
server.once('close',stopLiveVisitorCleanup);
```

La limpieza es parte necesaria de esta integración: ejecuta al arrancar y cada 60 segundos, sin depender del tráfico. Borra solo sesiones anónimas vencidas. La función `purgeLiveVisitors(db)` también se puede llamar desde mantenimiento existente si ese proceso garantiza una ejecución cada 60 segundos; usar uno de los dos mecanismos. El temporizador no mantiene vivo el proceso y evita ejecuciones superpuestas.

La lista CORS actual ya permite `https://sistema.scaleparaguay.com`, `https://scaleparaguay.com`, `https://www.scaleparaguay.com`, app y admin. Mantener la lista exacta y el manejo existente de OPTIONS; no agregar comodines. No confiar en `X-Forwarded-Host` recibido del cliente. El proxy de la landing debe entregar `Host: admin.scaleparaguay.com` al API (o `sistema.scaleparaguay.com`, también permitido para esa landing), conservando `Origin`. No hace falta abrir el API a localhost ni a dominios de preview.

Contrato:

- `POST /api/public/live-visitors/heartbeat`: JSON `{site:'scale-os-landing',session_id:crypto.randomUUID()}`; acepta únicamente esas dos propiedades y máximo 256 bytes. Responde `202 {ok:true}` sin conteos ni identificadores. Solo origen/host vinculados al sitio, organización activa no demo. No recibe `organization_id`.
- `GET /api/agency/live-visitors`: usa la empresa de la sesión autenticada, solo `owner`/`admin`. No acepta filtros/querystring. Responde `{organization_id,estimated:true,synthetic:false,window_seconds:90,refresh_seconds:30,sites:[{site,label,active}]}`. No hay endpoint público de lectura.
- Dos sitios inicialmente vinculados a la organización `scale`: `scale-website` y `scale-os-landing`. Un sitio nuevo requiere configuración explícita en servidor/base; no hay API pública para vincular empresas u orígenes. La migración es aditiva e idempotente, no modifica tablas de clientes, miembros, eventos ni finanzas.

## Pipeline

En `scale-os/app/scale-workspace.tsx`:

```tsx
import {LiveVisitors} from './live-visitors';
```

Dentro de `active==='Pipeline'`, después de oportunidades y antes del crecimiento, con `user` disponible:

```tsx
{user&&<LiveVisitors
  organizationId={String(user.organization_id)}
  role={user.role}
  demo={Boolean(user.demo_owner_user_id)||user.organization_slug==='scale-demo-controles-20260908'}
/>}
```

El componente importa su CSS con clases propias. No necesita cambios en CSS global, cabecera ni toolbar. Valida rol internamente, remonta al cambiar de empresa/rol/demo, aborta solicitudes anteriores y comprueba que la empresa de cada respuesta coincida. Los fallos muestran «Contador temporalmente no disponible», sin convertir un error en cero visitantes. Cero es un resultado real válido; lista vacía significa que no hay sitios vinculados.

## Política de demo y privacidad

- La demo muestra **3 visitantes ficticios** en «Web de ejemplo», con texto explícito. No hace solicitudes ni crea visitantes. El API, como defensa adicional, entrega ese mismo ejemplo aislado si la sesión pertenece a una demo; nunca consulta estadísticas reales para ella. Los roles sin permiso no ven el componente ni el ejemplo.
- La captura nueva de `scale-os/public/scale-os.html` corre solo en la raíz de `sistema.scaleparaguay.com`, nunca en `/demo`, `/pipeline` ni en el host de la app. Los eventos agregados y el formulario previo quedaron intactos.
- Sesiones UUID v4 aleatorias, compartidas entre pestañas del mismo host mediante Web Locks y una cookie propia `__Host-scale_live_v1`: `Secure; SameSite=Strict; Path=/; Max-Age=90`. El identificador rota como máximo a los 15 minutos de actividad continua. No usa almacenamiento persistente, cookies publicitarias, IP, huella del dispositivo, identidad de cuenta, URL/referrer ni historial. El API recibe solo sitio e identificador; la cookie no viaja con la captura (`credentials:'omit'`).
- Una señal por sesión cada 30 segundos mientras alguna pestaña esté visible. Sin locks o con cookies bloqueadas se omite la estimación; no se crea una sesión por pestaña como alternativa. La cookie caduca a los 90 segundos sin señal. Los registros del servidor dejan de contar a los 90 segundos (o al cumplir 15 minutos de vida), y la limpieza elimina los vencidos al siguiente ciclo de 60 segundos, salvo indisponibilidad de la base/proceso.
- API: mínimo 20 segundos entre señales del mismo identificador y máximo 600 intentos válidos por sitio/minuto, compartidos entre instancias usando PostgreSQL. No crea filas de límites por IP ni identificador. Solicitudes duplicadas reciben 429; el navegador usa pausas y timeout de 8 segundos. Estos límites pueden subcontar sitios con más de ~300 sesiones simultáneas; no son una defensa completa contra bots que simulen navegadores.
- El dato estima **sesiones**, no personas identificadas. `www` y dominio raíz tienen cookies separadas (no se correlacionan), así como distintos navegadores. Bloqueadores, latencia y pestañas cerradas recientemente afectan la cifra. Se presentan conteos por sitio, sin sumarlos como personas únicas entre sitios.

## Snippet para scaleparaguay.com

Referencia del runtime ya instalado mediante un script externo antes de `</body>` en la web de la agencia. No insertarlo nuevamente. No necesita librerías ni cambios visuales. Su configuración es independiente de la landing del sistema; se conserva el ejemplo para las pruebas de paridad.

```html
<script>
(function(){
 const site='scale-website';
 const allowedOrigins=['https://scaleparaguay.com','https://www.scaleparaguay.com'];
 const endpoint='https://admin.scaleparaguay.com/api/public/live-visitors/heartbeat';
 if(!allowedOrigins.includes(location.origin)||!['/','/index.html'].includes(location.pathname)||window.top!==window||!navigator.locks||!crypto.randomUUID)return;
 const cookieName='__Host-scale_live_v1',lockName='scale-live-visitors-v1';
 let stopped=false,busy=false,timer,controller,nextAttempt=0;
 const read=()=>{try{const value=document.cookie.split('; ').find(v=>v.startsWith(cookieName+'='));return value?JSON.parse(decodeURIComponent(value.slice(cookieName.length+1))):null;}catch{return null;}};
 async function pulse(){
  if(stopped||busy||document.visibilityState!=='visible'||Date.now()<nextAttempt)return;
  busy=true;let timeout;
  try{
   const sid=await navigator.locks.request(lockName,{ifAvailable:true},lock=>{
    if(!lock||stopped||document.visibilityState!=='visible')return null;
    const now=Date.now();let state=read();
    if(!state||typeof state.id!=='string'||!/^[0-9a-f-]{36}$/.test(state.id)||!Number.isFinite(state.born)||!Number.isFinite(state.sent)||now-state.sent>=90000||now-state.born>=900000||state.born>now||state.sent>now)state={id:crypto.randomUUID(),born:now,sent:0};
    if(now-state.sent<30000)return null;
    state.sent=now;
    document.cookie=cookieName+'='+encodeURIComponent(JSON.stringify(state))+'; Max-Age=90; Path=/; Secure; SameSite=Strict';
    if(read()?.id!==state.id)return null;
    return state.id;
   });
   if(!sid||stopped||document.visibilityState!=='visible')return;
   nextAttempt=Date.now()+30000;controller=new AbortController();timeout=setTimeout(()=>controller.abort(),8000);
   const response=await fetch(endpoint,{method:'POST',credentials:'omit',cache:'no-store',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({site,session_id:sid})});
   if(!response.ok)nextAttempt=Date.now()+(response.status===429?60000:120000);
  }catch{nextAttempt=Date.now()+120000;}finally{clearTimeout(timeout);busy=false;}
 }
 const visibility=()=>{if(document.visibilityState==='visible')void pulse();else controller?.abort();};
 const start=()=>{stopped=false;clearInterval(timer);timer=setInterval(()=>void pulse(),30000);void pulse();};
 document.addEventListener('visibilitychange',visibility);
 window.addEventListener('pagehide',()=>{stopped=true;clearInterval(timer);controller?.abort();});
 window.addEventListener('pageshow',start);
 start();
})();
</script>
```

## Validación local

- Backend: `node test-live-visitors.mjs` (PGlite en memoria; ninguna base externa).
- Frontend: `./node_modules/.bin/tsx tests/live-visitors.test.tsx` y `./node_modules/.bin/tsx tests/live-visitor-tracker.test.ts`.
- La prueba del tracker ejecuta el JavaScript real de la landing con dos contextos de navegador simulados. No equivale a QA visual ni a comprobación de los hosts/proxies desplegados.
- La comprobación global final de TypeScript y las pruebas locales del contador pasaron. Los cambios ajenos de WEEM/Prisma se mantienen fuera de esta entrega.
- Después de conectar: comprobar en un entorno local/aislado migración, 401 sin sesión, 403 para viewer, respuesta por empresa, aumento de una sola sesión al abrir dos pestañas y desaparición tras 90 segundos. No usar un POST de prueba contra estadísticas reales de Scale. Verificar proxy/CORS antes de activar el snippet de la agencia.
