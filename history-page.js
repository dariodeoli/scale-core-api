import {fail} from './suite-validation.js';

export function historyPage(params){
 const limit=Number(params.get('limit')||10),offset=Number(params.get('offset')||0);
 if(![10,50,100].includes(limit)||!Number.isSafeInteger(offset)||offset<0||offset>100000)fail('Elegí 10, 50 o 100 registros y una página válida');
 return {limit,offset};
}
export function historyResult(rows,{limit,offset}){
 return {records:rows.slice(0,limit),page:{limit,offset,hasMore:rows.length>limit}};
}
