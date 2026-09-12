import assert from 'node:assert/strict';
import {createEmailDelivery,emailDeliveryStatus,publicEmailDeliveryStatus} from './email-delivery.js';

const base={apiKey:'re_test_key_123456',from:'Scale OS <acceso@scaleparaguay.com>',appUrl:'https://app.scaleparaguay.com'};
const ready=emailDeliveryStatus(base);
assert.equal(ready.available,true);assert.deepEqual(ready.missing,[]);assert.equal(ready.sender,'Scale OS <acceso@scaleparaguay.com>');
for(const input of [{...base,apiKey:''},{...base,from:''},{...base,from:'Broken <a@b>'},{...base,from:'x@example.com\r\nBcc: bad@example.com'},{...base,appUrl:'http://app.scaleparaguay.com'}]){
 const status=emailDeliveryStatus(input);assert.equal(status.available,false);assert.ok(status.missing.length>0);
 const exposed=publicEmailDeliveryStatus(status);assert.equal(exposed.available,false);assert.equal(Object.hasOwn(exposed,'sender'),false);assert.equal(Object.hasOwn(exposed,'missing'),false);
}
let calls=0;
const disabled=createEmailDelivery({...base,from:'',fetcher:async()=>{calls++;return{ok:true};}});
assert.equal(await disabled.send({to:'person@example.com',message:{subject:'x'}}),false);assert.equal(calls,0);
let headers;
const delivery=createEmailDelivery({...base,fetcher:async(_url,request)=>{calls++;headers=request.headers;return{ok:true};}});
assert.equal(await delivery.send({to:'person@example.com',message:{subject:'x'},idempotencyKey:'fixture'}),true);assert.equal(headers['Idempotency-Key'],'fixture');assert.match(headers.Authorization,/^Bearer /);
const rejected=createEmailDelivery({...base,fetcher:async()=>({ok:false})});assert.equal(await rejected.send({to:'person@example.com',message:{subject:'x'}}),false);
console.log('PASS: email readiness requires provider, verified-shaped sender and HTTPS app URL; disabled delivery performs no outbound request and public status hides configuration details');
