"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const http=require('node:http');
const {createBackendProcessLifecycle}=require('./backend-process-lifecycle');
const turn=()=>new Promise(setImmediate);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
function fixture() {
 const processPort=Object.assign(new EventEmitter(),{exit:code=>calls.push(['exit',code])}),calls=[],timers=new Set();
 const owner=createBackendProcessLifecycle({db:{$disconnect:async()=>{calls.push('disconnect');}},
  log:{info(){},warn(){},error(...args){calls.push(['error',...args]);}},processPort,
  schedule(fn){const timer={fn};timers.add(timer);return timer;},cancel:t=>timers.delete(t)});
 return {owner,processPort,calls,timers,exits:()=>calls.filter(x=>Array.isArray(x)&&x[0]==='exit')};
}
test('SIGTERM during startup joins verification and never starts later producers',async()=>{
 const f=fixture(),pending=deferred();let started=0;
 const boot=f.owner.start(async({checkpoint})=>{await pending.promise;checkpoint();started++;});await turn();
 f.processPort.emit('SIGTERM');f.processPort.emit('SIGTERM');f.processPort.emit('SIGINT');
 assert.equal(f.owner.getPhase(),'DRAINING');assert.equal(f.calls.includes('disconnect'),false);
 pending.resolve();await boot;await turn();assert.equal(started,0);assert.deepEqual(f.exits(),[['exit',0]]);assert.equal(f.timers.size,0);
});
test('all producers close admission immediately and both HTTP and work drain before Prisma',async()=>{
 const f=fixture(),job=deferred(),request=deferred(),calls=[];
 await f.owner.start(async({own})=>{own('job',()=>{calls.push('job');return job.promise;});own('http',()=>{calls.push('http');return request.promise;});});
 const stopping=f.owner.stop('test');assert.deepEqual(calls,['job','http']);assert.equal(f.owner.stop('repeat'),stopping);
 request.resolve();await turn();assert.equal(f.calls.includes('disconnect'),false);
 job.resolve();await stopping;assert.equal(f.calls.at(-2),'disconnect');assert.deepEqual(f.exits(),[['exit',0]]);
});
test('startup failure drains every already-created owner before disconnecting Prisma',async()=>{
 const f=fixture(),work=deferred();let stopped=0;
 const boot=f.owner.start(async({own})=>{own('worker',()=>{stopped++;return work.promise;});throw Error('bind failed');});await turn();
 assert.equal(stopped,1);assert.equal(f.calls.includes('disconnect'),false);work.resolve();await boot;
 assert.equal(f.calls.at(-2),'disconnect');assert.deepEqual(f.exits(),[['exit',1]]);
});
test('a late owner registered during bootstrap is included in the shutdown join',async()=>{
 const f=fixture(),ready=deferred(),drain=deferred();let stopped=0;
 const boot=f.owner.start(async({own})=>{await ready.promise;own('late',()=>{stopped++;return drain.promise;});});await turn();
 const stopping=f.owner.stop('test');ready.resolve();await turn();assert.equal(stopped,1);assert.equal(f.calls.includes('disconnect'),false);
 drain.resolve();await Promise.all([boot,stopping]);assert.deepEqual(f.exits(),[['exit',0]]);
});
test('unknown cleanup preserves Prisma, drains independent owners, and exits unsuccessfully',async()=>{
 const f=fixture(),other=deferred();let stopped=0;
 await f.owner.start(async({own})=>{own('broken',()=>{throw Error('still active');});own('other',()=>{stopped++;return other.promise;});});
 const stop=f.owner.stop('test');assert.equal(stopped,1);await turn();assert.equal(f.exits().length,0);other.resolve();await stop;
 assert.equal(f.calls.includes('disconnect'),false);assert.deepEqual(f.exits(),[['exit',1]]);
});
test('the process deadline cannot turn an unknown drain into a successful later close',async()=>{
 const f=fixture(),work=deferred();await f.owner.start(async({own})=>own('hung',()=>work.promise));
 const stop=f.owner.stop('test');[...f.timers][0].fn();assert.deepEqual(f.exits(),[['exit',1]]);
 work.resolve();await stop;assert.equal(f.calls.includes('disconnect'),false);assert.equal(f.exits().length,1);
});
test('fatal runtime error during an existing drain upgrades the final status',async()=>{
 const f=fixture(),work=deferred();await f.owner.start(async({own})=>own('worker',()=>work.promise));
 const stop=f.owner.stop('SIGTERM');f.processPort.emit('uncaughtException',Error('fatal'));work.resolve();await stop;assert.deepEqual(f.exits(),[['exit',1]]);
});
test('shutdown ingress returns retryable 503 while existing requests keep their ownership',async()=>{
 const f=fixture(),work=deferred();await f.owner.start(async({own})=>own('worker',()=>work.promise));let admitted=0;
 f.owner.middleware({},null,()=>admitted++);const stop=f.owner.stop('SIGTERM');
 const response={headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 f.owner.middleware({},response,()=>admitted++);assert.equal(admitted,1);assert.equal(response.code,503);assert.equal(response.body.code,'BACKEND_STOPPING');assert.equal(response.headers.Connection,'close');
 work.resolve();await stop;
});
test('real HTTP listener drains an admitted response before the database closes',async()=>{
 const f=fixture(),entered=deferred(),release=deferred();let server;
 await f.owner.start(async({own})=>{
  server=http.createServer((_req,res)=>{entered.resolve();void release.promise.then(()=>res.end('committed'));});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  own('http',()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
 });
 const response=new Promise((resolve,reject)=>http.get(`http://127.0.0.1:${server.address().port}`,res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve(body));}).on('error',reject));
 await entered.promise;const stop=f.owner.stop('SIGTERM');await turn();assert.equal(f.calls.includes('disconnect'),false);
 release.resolve();assert.equal(await response,'committed');await stop;assert.deepEqual(f.exits(),[['exit',0]]);
});
test('a real occupied port fails startup and rolls back workers instead of staying alive silently',async()=>{
 const f=fixture(),occupied=http.createServer();await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));let stops=0,server;
 try {
  await f.owner.start(async({own})=>{
   own('worker',async()=>{stops++;});server=http.createServer();
   own('socket',async()=>{if(server.listening)await new Promise(resolve=>server.close(resolve));});
   await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(occupied.address().port,'127.0.0.1',resolve);});
  });
  assert.equal(stops,1);assert.deepEqual(f.exits(),[['exit',1]]);assert.equal(f.calls.includes('disconnect'),true);
 } finally {await new Promise(resolve=>occupied.close(resolve));}
});
test('a signal emitted synchronously by a disposer shares the original shutdown owner',async()=>{
 const f=fixture();let stops=0;
 await f.owner.start(async({own})=>own('worker',()=>{if(++stops===1)f.processPort.emit('SIGTERM');}));
 await f.owner.stop('SIGINT');assert.equal(stops,1);assert.deepEqual(f.exits(),[['exit',0]]);
});
