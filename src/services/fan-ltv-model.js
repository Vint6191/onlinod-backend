"use strict";
const { utcDay, DAY_MS } = require('./analytics-range-contract');
const RANGES = Object.freeze(['all','7d','30d','90d','180d','365d']);
const CATEGORIES = Object.freeze(['subscriptions','messages','tips','posts','streams','other']);
const FIELDS = Object.freeze(['netCents','knownNetCents','knownPayments','unknownPayments','payingFans']);
function fail(code) { return Object.assign(new Error(code),{code,retryable:false}); }
function integer(value) { const n=Number(value ?? 0);if(!Number.isSafeInteger(n)||n<0)throw fail('FAN_LTV_AMOUNT_INVALID');return n; }
function fanId(value) { return typeof value==='string' && /^[A-Za-z0-9_-]{1,180}$/.test(value) ? value : null; }
function contribution(row,now) {
 if(!row)return null;
 const at=new Date(row.occurredAt),net=integer(row.netCents);
 if(!Number.isFinite(+at)||!['done','loading','undo'].includes(row.status))throw fail('FAN_LTV_FACT_INVALID');
 const today=+utcDay(now),day=+utcDay(at),ranges=[],due=[];
 // Future observations (including an accepted clock skew) enter on their real
 // occurrence, rather than distorting today's period or lifetime value.
 if(+at>+now)due.push(+at);
 else if(row.status!=='undo'&&net>0){
  for(const key of RANGES){
   if(key==='all')ranges.push(key);
   else {const expiry=day+Number(key.slice(0,-1))*DAY_MS;if(expiry>today){ranges.push(key);due.push(expiry);}}
  }
 }
 return {fanId:fanId(row.fanOnlyFansUserId),netCents:net,category:CATEGORIES.includes(row.category)?row.category:'other',
  status:row.status,occurredAt:at.toISOString(),ranges,nextDueAt:due.length?new Date(Math.min(...due)).toISOString():null};
}
function prefixes(net) { const hex=integer(net).toString(16).padStart(14,'0');return Array.from({length:7},(_,i)=>hex.slice(0,(i+1)*2)); }
function rangeDto(metric={},types=[]) {
 const row=Object.fromEntries(FIELDS.map(field=>[field,integer(metric[field])]));
 return {...row,averageCents:row.payingFans?Number((BigInt(row.knownNetCents)*2n+BigInt(row.payingFans))/(BigInt(row.payingFans)*2n)):null,
  attributionComplete:row.unknownPayments===0,types:types.map(type=>({key:type.category,netCents:integer(type.values.knownNetCents),unknownNetCents:integer(type.values.netCents)-integer(type.values.knownNetCents)}))};
}
module.exports={RANGES,CATEGORIES,FIELDS,fail,integer,fanId,contribution,prefixes,rangeDto};
