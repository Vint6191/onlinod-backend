"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {start}=require("./analytics-hot-executor");
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
function harness(options={}) {
 const timers=new Map();let seq=0;
 const executor=start({...options,schedule(fn,delay){timers.set(++seq,{fn,delay});return seq;},cancel(id){timers.delete(id);}});
 const next=async()=>{const [id,t]=timers.entries().next().value;timers.delete(id);await t.fn();return t.delay;};
 return{executor,timers,next};
}
test("idle executor only probes durable work, bounds retry delay, and a wake interrupts backoff",async()=>{
 let executions=0,probes=0;
 const h=harness({probe:async()=>{probes++;return new Set();},publication:async()=>{executions++;},resolution:async()=>{executions++;}});
 for(let i=0;i<8;i++){await h.next();assert.equal(h.timers.size,1);assert([...h.timers.values()][0].delay<=10000);}
 assert.equal(probes,8);assert.equal(executions,0);
 h.executor.wake();assert.equal([...h.timers.values()][0].delay,0);await h.executor.stop();assert.equal(h.timers.size,0);
});
test("one hundred wakes coalesce during a running commit, shutdown joins it without another reservation",async()=>{
 const held=deferred();let calls=0;
 const h=harness({probe:async()=>new Set(["ANALYTICS_PUBLICATION","MONEY_RESOLUTION"]),publication:()=>{calls++;return held.promise;},resolution:async()=>{calls++;return{ok:true,processed:1};}});
 const run=h.next();await Promise.resolve();await Promise.resolve();
 for(let i=0;i<100;i++)h.executor.wake();assert.equal(calls,1);assert.equal(h.timers.size,0);
 let stopped=false;const stop=h.executor.stop().then(()=>stopped=true);await Promise.resolve();assert.equal(stopped,false);
 held.resolve({ok:true,processed:2});await run;await stop;assert.equal(calls,1);assert.equal(h.timers.size,0);
});
test("both hot lanes get a bounded turn and errors back off without losing future wakeups",async()=>{
 const calls=[],errors=[];let fail=true;
 const h=harness({probe:async()=>new Set(["ANALYTICS_PUBLICATION","MONEY_RESOLUTION"]),publication:async input=>{calls.push(["publication",input.limit,input.maxUnitsPerClaim]);if(fail)throw Error("transient");return{ok:true,processed:2};},resolution:async input=>{calls.push(["resolution",input.limit]);return{ok:true,processed:1};},onError:e=>errors.push(e)});
 await h.next();assert.equal(errors.length,1);assert.equal([...h.timers.values()][0].delay,2000);
 fail=false;h.executor.wake();await h.next();assert.deepEqual(calls.slice(-2),[["publication",2,8],["resolution",2]]);assert.equal([...h.timers.values()][0].delay,25);await h.executor.stop();
});
test("Fan LTV adoption and backlog share the bounded hot executor and a failing sibling cannot starve them",async()=>{
 const calls=[],errors=[];
 const h=harness({probe:async()=>new Set(["ANALYTICS_PUBLICATION","MONEY_RESOLUTION","FAN_LTV_PROJECTION"]),
  publication:async()=>{calls.push('publication');throw Error('unrelated transient');},
  resolution:async()=>{calls.push('resolution');return{ok:true,processed:0};},
  fanLtv:async input=>{calls.push('ltv');assert.equal(input.limit,2);assert.equal(input.maxRuntimeMs,2000);return{ok:true,processed:1,seed:{visited:25}};},
  onError:error=>errors.push(error)});
 await h.next();assert.deepEqual(calls,['publication','resolution','ltv']);assert.equal(errors.length,1);
 assert.equal(h.executor.snapshot().units,1);assert.equal(h.timers.size,1);await h.executor.stop();
});
