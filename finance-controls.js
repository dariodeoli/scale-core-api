import {fail,text,id,optId,amount,date,owned} from './suite-validation.js';
const today=()=>new Date().toISOString().slice(0,10);
async function retryRecord(c,table,org,key){
 if(!key)return null;if(typeof key!=='string'||! /^[a-f0-9-]{36}$/.test(key))fail('Identificador de operación inválido');
 await c.query('select pg_advisory_xact_lock(hashtextextended($1,0))',[`${table}:${org}:${key}`]);
 return(await c.query(`select * from ${table} where organization_id=$1 and request_key=$2`,[org,key])).rows[0]||null;
}
export async function financeControls({req,res,url,db,session,body,send}){
 const route=url.pathname.match(/^\/api\/agency\/(payments|transfers|reconciliation)(?:\/(\d+))?(?:\/(reverse|match|unmatch|auto))?$/);
 if(!route)return false;
 let c,tx=false;
 try{
  const user=await session(req);if(!user)fail('No autenticado',401);
  if(!['owner','admin','finance'].includes(user.role))fail('Tu rol no permite operar las cuentas',403);
  c=await db.connect();await c.query('begin');tx=true;
  await c.query("select set_config('app.current_user',$1,true),set_config('app.current_ip',$2,true)",[String(user.id),req.socket.remoteAddress||'']);
  const org=user.organization_id,kind=route[1],key=route[2],action=route[3];let result,status=200;
  if(kind==='payments'){
   if(req.method==='GET'&&!key)result={payments:(await c.query('select p.*,i.number as invoice_number,cl.name as client_name,a.name as account_name,a.account_type,a.currency,u.email as received_by_email,r.id as reversal_id,r.reason as reversal_reason,r.reversed_on from agency_payments p join agency_invoices i on i.id=p.invoice_id join agency_clients cl on cl.id=i.client_id join bank_accounts a on a.id=p.account_id left join users u on u.id=p.received_by_user_id left join agency_payment_reversals r on r.payment_id=p.id where p.organization_id=$1 order by p.received_on desc,p.id desc',[org])).rows};
   else if(req.method==='POST'&&!key){
    const b=await body(req),paid=amount(b.amount);if(!paid)fail('El importe debe ser mayor a cero');
    const retry=await retryRecord(c,'agency_payments',org,b.requestId);
    if(retry){if(String(retry.invoice_id)!==String(b.invoiceId)||String(retry.account_id)!==String(b.accountId)||Number(retry.amount)!==paid)fail('El identificador ya fue usado para otro cobro',409);await c.query('commit');tx=false;send(res,200,{payment:retry,alreadyRecorded:true});return true;}
    const invoice=await owned(c,'agency_invoices',b.invoiceId,org),account=await owned(c,'bank_accounts',b.accountId,org);
    if(!account.active||account.currency!==invoice.currency)fail('La cuenta debe estar activa y usar la moneda de la factura');
    if(['cancelled','draft'].includes(invoice.status)||Math.round(paid*100)>Math.round((Number(invoice.total)-Number(invoice.paid_amount))*100))fail('El cobro supera el saldo pendiente o la factura no está emitida');
    const receiver=optId(b.receivedByUserId)||user.id;if(!(await c.query('select 1 from organization_members where organization_id=$1 and user_id=$2 and active=true',[org,receiver])).rows.length)fail('La persona debe tener acceso activo a la empresa');
    result={payment:(await c.query('insert into agency_payments(organization_id,invoice_id,account_id,amount,received_on,reference,received_by_user_id,request_key) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[org,invoice.id,account.id,paid,date(b.receivedOn)||today(),text(b.reference||'',120),receiver,b.requestId||null])).rows[0]};status=201;
   }else if(req.method==='POST'&&key&&action==='reverse'){
    const b=await body(req),reason=text(b.reason,500);if(reason.length<5)fail('Explicá el motivo de la reversión');
    const p=await owned(c,'agency_payments',key,org);
    const existing=(await c.query('select * from agency_payment_reversals where payment_id=$1',[p.id])).rows[0];
    if(existing)result={reversal:existing,alreadyReversed:true};
    else{await owned(c,'agency_invoices',p.invoice_id,org);const a=await owned(c,'bank_accounts',p.account_id,org);if(Number(a.balance)<Number(p.amount))fail('Saldo insuficiente en la cuenta original. Registrá primero el retorno del dinero.',409);
     result={reversal:(await c.query('insert into agency_payment_reversals(organization_id,payment_id,reason,reversed_on,created_by_user_id) values($1,$2,$3,$4,$5) returning *',[org,p.id,reason,date(b.reversed_on)||today(),user.id])).rows[0]};status=201;}
   }else fail('Método no permitido',405);
  }else if(kind==='transfers'){
   if(req.method==='GET'&&!key)result={transfers:(await c.query('select t.*,f.name as from_account_name,d.name as to_account_name,f.currency as from_currency,d.currency as to_currency,coalesce(t.received_amount,t.amount) as received_amount,u.email as created_by_email from account_transfers t join bank_accounts f on f.id=t.from_account_id join bank_accounts d on d.id=t.to_account_id left join users u on u.id=t.created_by_user_id where t.organization_id=$1 order by t.transferred_on desc,t.id desc',[org])).rows};
   else if(req.method==='POST'&&!key){const b=await body(req),sourceId=id(b.fromAccountId),destId=id(b.toAccountId),debit=amount(b.amount);if(sourceId===destId||!debit)fail('Seleccioná dos cuentas distintas y un importe positivo');
    const retry=await retryRecord(c,'account_transfers',org,b.requestId);if(retry){if(String(retry.from_account_id)!==sourceId||String(retry.to_account_id)!==destId||Number(retry.amount)!==debit||b.receivedAmount!==undefined&&Number(retry.received_amount)!==Number(b.receivedAmount))fail('El identificador ya fue usado para otra transferencia',409);await c.query('commit');tx=false;send(res,200,{transfer:retry,alreadyRecorded:true});return true;}
    const accounts=(await c.query('select * from bank_accounts where organization_id=$1 and id=any($2::bigint[]) order by id for update',[org,[sourceId,destId]])).rows;
    const source=accounts.find(a=>String(a.id)===sourceId),dest=accounts.find(a=>String(a.id)===destId);if(!source?.active||!dest?.active)fail('Las cuentas deben estar activas y pertenecer a la empresa');
    if(Number(source.balance)<debit)fail('Saldo insuficiente en la cuenta de origen',409);
    const credit=source.currency===dest.currency?debit:amount(b.receivedAmount);if(!credit)fail('Ingresá cuánto recibe la cuenta de destino en su moneda');
    if(credit/debit<0.00000001||credit/debit>999999999999)fail('El tipo de cambio está fuera del rango permitido');
    if(source.currency===dest.currency&&b.receivedAmount!==undefined&&amount(b.receivedAmount)!==debit)fail('En la misma moneda, los importes deben coincidir');
    result={transfer:(await c.query('insert into account_transfers(organization_id,from_account_id,to_account_id,amount,received_amount,transferred_on,reference,notes,created_by_user_id,request_key) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning *',[org,sourceId,destId,debit,credit,date(b.transferredOn)||today(),text(b.reference||'',120),text(b.notes||'',1000),user.id,b.requestId||null])).rows[0]};status=201;
   }else fail('Método no permitido',405);
  }else{
   if(req.method==='GET'&&!key){const accountId=id(url.searchParams.get('accountId'));await owned(c,'bank_accounts',accountId,org);
    result={lines:(await c.query('select s.*,m.id as match_id,m.movement_type,m.movement_id from agency_statement_lines s left join agency_reconciliation_matches m on m.statement_line_id=s.id where s.organization_id=$1 and s.account_id=$2 order by s.booked_on desc,s.id desc limit 1000',[org,accountId])).rows,movements:(await c.query('select v.* from agency_cash_movements v where v.organization_id=$1 and v.account_id=$2 and not exists(select 1 from agency_reconciliation_matches m where m.account_id=v.account_id and m.movement_type=v.movement_type and m.movement_id=v.movement_id) order by v.booked_on desc limit 1000',[org,accountId])).rows};
   }else if(req.method==='POST'&&!key){const b=await body(req),account=await owned(c,'bank_accounts',b.accountId,org);if(!Array.isArray(b.lines)||!b.lines.length||b.lines.length>1000)fail('Importá entre 1 y 1.000 filas');let imported=0;
    for(const line of b.lines){const external=text(line.external_id,120),on=date(line.booked_on),n=Number(line.amount);if(!external||!on||!Number.isFinite(n)||!n||Math.abs(n)>999999999999||Math.round(n*100)/100!==n)fail('Cada fila requiere ID, fecha e importe firmado con hasta dos decimales');
     const reference=text(line.reference||'',500),existing=(await c.query('select * from agency_statement_lines where account_id=$1 and external_id=$2',[account.id,external])).rows[0];
     if(existing){if(Number(existing.amount)!==n||date(existing.booked_on)!==on||existing.reference!==reference)fail('Un ID del extracto ya existe con otros datos. Revisá el archivo.',409);continue;}
     await c.query('insert into agency_statement_lines(organization_id,account_id,external_id,booked_on,amount,reference,created_by_user_id) values($1,$2,$3,$4,$5,$6,$7)',[org,account.id,external,on,n,reference,user.id]);imported++;}
    result={imported};status=201;
   }else if(req.method==='POST'&&key&&action==='auto'){
    await owned(c,'bank_accounts',key,org);
    const pairs=(await c.query(`with candidates as (
      select s.id as line_id,v.movement_type,v.movement_id,
       count(*) over(partition by s.id) as line_count,
       count(*) over(partition by v.movement_type,v.movement_id) as move_count
      from agency_statement_lines s join agency_cash_movements v on v.organization_id=s.organization_id and v.account_id=s.account_id and v.booked_on=s.booked_on and v.amount=s.amount and lower(trim(v.reference))=lower(trim(s.reference))
      where s.organization_id=$1 and s.account_id=$2 and trim(s.reference)<>''
       and not exists(select 1 from agency_reconciliation_matches m where m.statement_line_id=s.id)
       and not exists(select 1 from agency_reconciliation_matches m where m.account_id=v.account_id and m.movement_type=v.movement_type and m.movement_id=v.movement_id)
     ) select * from candidates where line_count=1 and move_count=1`,[org,key])).rows;
    let matched=0;for(const pair of pairs){const r=await c.query('insert into agency_reconciliation_matches(organization_id,statement_line_id,account_id,movement_type,movement_id,created_by_user_id) values($1,$2,$3,$4,$5,$6) on conflict do nothing returning id',[org,pair.line_id,key,pair.movement_type,pair.movement_id,user.id]);matched+=r.rows.length;}
    result={matched};
   }else if(req.method==='POST'&&key&&['match','unmatch'].includes(action)){
    const line=await owned(c,'agency_statement_lines',key,org);
    if(action==='unmatch'){await c.query('delete from agency_reconciliation_matches where statement_line_id=$1 and organization_id=$2',[line.id,org]);result={ok:true};}
    else{const b=await body(req),move=(await c.query('select * from agency_cash_movements where organization_id=$1 and account_id=$2 and movement_type=$3 and movement_id=$4',[org,line.account_id,text(b.movement_type,30),id(b.movement_id)])).rows[0];if(!move||Number(move.amount)!==Number(line.amount))fail('El movimiento debe pertenecer a esta cuenta y tener el mismo importe firmado');
     await c.query('insert into agency_reconciliation_matches(organization_id,statement_line_id,account_id,movement_type,movement_id,created_by_user_id) values($1,$2,$3,$4,$5,$6)',[org,line.id,line.account_id,move.movement_type,move.movement_id,user.id]);result={ok:true};}
   }else fail('Método no permitido',405);
  }
  await c.query('commit');tx=false;send(res,status,result);
 }catch(e){if(tx)await c.query('rollback');const status=e.status||(e.code==='23505'?409:500);console.error(JSON.stringify({event:'finance_controls_error',status,code:e.code}));send(res,status,{error:e.status?e.message:e.code==='23505'?'El movimiento ya está conciliado o registrado.':'No se pudo completar la operación financiera'});}finally{c?.release();}
 return true;
}
