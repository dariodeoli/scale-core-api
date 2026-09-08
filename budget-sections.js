import {fail,text} from './suite-validation.js';
export const defaultSections=()=>['meta','items','totals','notes'].map(type=>({type,title:'',body:'',enabled:true}));
export function budgetSections(value){
 if(value===undefined||value===null)return defaultSections();
 if(!Array.isArray(value)||value.length<2||value.length>24)fail('Usá entre 2 y 24 secciones');
 const seen=new Set();const result=value.map(s=>{
  if(!s||!['meta','items','totals','notes','text'].includes(s.type))fail('Sección inválida');
  if(s.type!=='text'){if(seen.has(s.type))fail('No dupliques una sección de datos');seen.add(s.type);}
  if(typeof s.enabled!=='boolean')fail('Indicá si la sección está visible');
  return{type:s.type,title:text(s.title||'',120),body:text(s.body||'',5000),enabled:s.enabled};
 });
 for(const required of ['items','totals'])if(!result.some(s=>s.type===required&&s.enabled))fail('El detalle y los totales siempre deben estar visibles');
 return result;
}
