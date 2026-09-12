const roles=['owner','admin','management','finance','sales','production','editor','viewer'];
const currencies=['USD','PYG'];
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const integer=(value,fallback=0)=>{
 const parsed=Number(value);return Number.isInteger(parsed)&&parsed>=0?parsed:fallback;
};
const limit=value=>Math.min(100,Math.max(1,integer(value,25)));
const queryText=value=>typeof value==='string'?value.trim().slice(0,120):'';
const couponCode=value=>{
 const code=queryText(value).toUpperCase();
 if(!/^[A-Z0-9_-]{3,40}$/.test(code))fail('El código debe tener entre 3 y 40 caracteres: letras, números, guion o guion bajo.');
 return code;
};
const couponType=value=>{
 if(!['percent','fixed'].includes(value))fail('Tipo de descuento inválido.');
 return value;
};
const couponValue=value=>{
 const amount=Number(value);if(!Number.isFinite(amount)||amount<=0||amount>1000000000)fail('Valor de descuento inválido.');
 return amount;
};
const couponCurrency=value=>{
 if(value===null||value===undefined||value==='')return null;
 if(!currencies.includes(value))fail('Moneda de cupón inválida.');
 return value;
};
async function actor(db,session,req){
 const user=await session(req);if(!user)fail('No autenticado',401);
 if(user.demo_owner_user_id||user.demo_source_id)fail('El Demo no accede a la administración global.',403);
 const membership=(await db.query('select user_id from platform_administrators where user_id=$1 and active=true',[user.id])).rows[0];
 if(!membership)fail('No tenés acceso a la administración global.',403);
 return user;
}
async function audit(db,user,action,targetType,targetId){
 await db.query('insert into platform_audit_log(actor_user_id,action,target_type,target_id) values($1,$2,$3,$4)',[user.id,action,targetType,String(targetId)]);
}
function page(url){return {limit:limit(url.searchParams.get('limit')),offset:integer(url.searchParams.get('offset'))};}
function search(url){const value=(url.searchParams.get('q')||'').trim();return value.slice(0,100);}
export async function platformAdmin({req,res,url,db,session,body,send}){
 if(!url.pathname.startsWith('/api/platform/'))return false;
 try{
  const user=await actor(db,session,req);
  if(url.pathname==='/api/platform/overview'&&req.method==='GET'){
   const [agencies,users,subscriptions,coupons]=(await Promise.all([
    db.query("select count(*)::int as total,count(*) filter(where active)::int as active from organizations where demo_owner_user_id is null and demo_source_id is null and slug<>'scale-demo-controles-20260908'"),
    db.query("select count(*)::int as total from users where not is_demo_guest"),
    db.query("select status,count(*)::int as total from organization_subscriptions group by status order by status"),
    db.query('select count(*)::int as total,count(*) filter(where active)::int as active from platform_coupons')
   ])).map(result=>result.rows);
   send(res,200,{agencies:agencies[0],users:users[0],subscriptions,coupons:coupons[0]});return true;
  }
  if(url.pathname==='/api/platform/agencies'&&req.method==='GET'){
   const {limit,offset}=page(url),q=search(url),where=q?'and (o.name ilike $3 or o.slug ilike $3)':'';
   const values=q?[limit,offset,'%'+q+'%']:[limit,offset];
   const result=await db.query(`select o.id,o.name,o.slug,o.active,o.created_at,
     s.status as subscription_status,s.currency as subscription_currency,s.amount as subscription_amount,s.trial_ends_at,s.due_at,
     count(m.user_id) filter(where m.active and m.removed_at is null)::int as active_users
     from organizations o left join organization_subscriptions s on s.organization_id=o.id
     left join organization_members m on m.organization_id=o.id
     where o.demo_owner_user_id is null and o.demo_source_id is null and o.slug<>'scale-demo-controles-20260908' ${where}
     group by o.id,s.status,s.currency,s.amount,s.trial_ends_at,s.due_at order by o.created_at desc limit $1 offset $2`,values);
   send(res,200,{agencies:result.rows,limit,offset});return true;
  }
  if(url.pathname==='/api/platform/users'&&req.method==='GET'){
   const {limit,offset}=page(url),q=search(url),where=q?'where u.email ilike $3':'';
   const values=q?[limit,offset,'%'+q+'%']:[limit,offset];
   const result=await db.query(`select u.id,u.email,u.created_at,
     count(m.organization_id) filter(where m.active and m.removed_at is null)::int as active_agencies,
     exists(select 1 from platform_administrators pa where pa.user_id=u.id and pa.active) as platform_admin
     from users u left join organization_members m on m.user_id=u.id ${where}
     group by u.id order by u.created_at desc limit $1 offset $2`,values);
   send(res,200,{users:result.rows,limit,offset});return true;
  }
  if(url.pathname==='/api/platform/coupons'&&req.method==='GET'){
   const {limit,offset}=page(url),q=search(url),where=q?'where c.code ilike $3':'';
   const values=q?[limit,offset,'%'+q+'%']:[limit,offset];
   const result=await db.query(`select c.id,c.code,c.discount_type,c.discount_value,c.currency,c.active,c.max_redemptions,c.created_at,c.updated_at,u.email as created_by
     from platform_coupons c join users u on u.id=c.created_by_user_id ${where} order by c.created_at desc limit $1 offset $2`,values);
   send(res,200,{coupons:result.rows,limit,offset});return true;
  }
  if(url.pathname==='/api/platform/coupons'&&req.method==='POST'){
   const incoming=await body(req),type=couponType(incoming.discount_type),value=couponValue(incoming.discount_value),currency=couponCurrency(incoming.currency);
   if((type==='percent'&&currency!==null)||(type==='fixed'&&currency===null)||(type==='percent'&&value>100))fail('La configuración del cupón no es válida.');
   const max=incoming.max_redemptions===null||incoming.max_redemptions===undefined||incoming.max_redemptions===''?null:integer(incoming.max_redemptions,-1);
   if(max!==null&&max<1)fail('El máximo de usos debe ser un entero positivo.');
   const result=await db.query('insert into platform_coupons(code,discount_type,discount_value,currency,max_redemptions,created_by_user_id) values($1,$2,$3,$4,$5,$6) returning id,code,discount_type,discount_value,currency,active,max_redemptions,created_at,updated_at',[couponCode(incoming.code),type,value,currency,max,user.id]);
   await audit(db,user,'coupon.create','coupon',result.rows[0].id);send(res,201,{coupon:result.rows[0]});return true;
  }
  const coupon=url.pathname.match(/^\/api\/platform\/coupons\/(\d+)$/);
  if(coupon&&req.method==='PATCH'){
   const incoming=await body(req),id=Number(coupon[1]),current=(await db.query('select * from platform_coupons where id=$1',[id])).rows[0];if(!current)fail('Cupón no encontrado',404);
   const type=incoming.discount_type===undefined?current.discount_type:couponType(incoming.discount_type);
   const value=incoming.discount_value===undefined?Number(current.discount_value):couponValue(incoming.discount_value);
   const currency=incoming.currency===undefined?current.currency:couponCurrency(incoming.currency);
   const active=incoming.active===undefined?current.active:incoming.active;
   if(typeof active!=='boolean'||(type==='percent'&&currency!==null)||(type==='fixed'&&currency===null)||(type==='percent'&&value>100))fail('La configuración del cupón no es válida.');
   const max=incoming.max_redemptions===undefined?current.max_redemptions:incoming.max_redemptions===null||incoming.max_redemptions===''?null:integer(incoming.max_redemptions,-1);
   if(max!==null&&max<1)fail('El máximo de usos debe ser un entero positivo.');
   const result=await db.query('update platform_coupons set discount_type=$1,discount_value=$2,currency=$3,active=$4,max_redemptions=$5,updated_at=now() where id=$6 returning id,code,discount_type,discount_value,currency,active,max_redemptions,created_at,updated_at',[type,value,currency,active,max,id]);
   await audit(db,user,'coupon.update','coupon',id);send(res,200,{coupon:result.rows[0]});return true;
  }
  fail('Ruta de administración global no encontrada.',404);
 }catch(error){send(res,error.status||500,{error:error.status?error.message:'No se pudo completar la operación global.'});return true;}
}
export function platformBootstrapEmails(value){
 return [...new Set(String(value||'').split(',').map(email=>email.trim().toLowerCase()).filter(email=>/^\S+@\S+\.\S+$/.test(email)))];
}
