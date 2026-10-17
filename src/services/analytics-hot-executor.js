"use strict";
const {currentCommitContext,deferCommitHint}=require("./db-commit-kernel");
const instances=new Set();
function wakeAfterCommit() {
  const notify=()=>{for(const instance of instances)instance.wake();};
  const context=currentCommitContext();
  if(context)deferCommitHint(context,"analytics-hot-wake",notify);else notify();
}
async function due(db) {
  const rows=await db.$queryRawUnsafe(`SELECT c.name FROM (VALUES ('ANALYTICS_PUBLICATION'),('MONEY_RESOLUTION')) c(name)
    WHERE EXISTS(SELECT 1 FROM "DomainWorkItem" w WHERE w."workClass"=c.name AND w."isOutstanding" AND w.state='READY' AND w."availableAt"<=clock_timestamp())
    OR EXISTS(SELECT 1 FROM "DomainWorkItem" w WHERE w."workClass"=c.name AND w."isOutstanding" AND w.state='CLAIMED' AND w."leaseUntil"<=clock_timestamp())
    OR (c.name='MONEY_RESOLUTION' AND EXISTS(SELECT 1 FROM "MoneyResolutionAdoption" WHERE id='v7' AND NOT complete))`);
  return new Set(rows.map(x=>x.name));
}
function start({db,probe=due,publication=input=>require("./analytics-publication-service").runAnalyticsPublicationSweep(input),
  resolution=input=>require("./money-resolution-service").runSweep(input),schedule=setTimeout,cancel=clearTimeout,now=Date.now,onError=()=>{},idleMs=2000,maxIdleMs=10000}={}) {
  let stopped=false,timer=null,running=null,woken=false,idle=idleMs;
  const health={running:false,rounds:0,units:0,errors:0,lastCompletedAt:null,lastDurationMs:0};
  function arm(delay){if(stopped)return;if(timer!==null)cancel(timer);timer=schedule(dispatch,delay);timer?.unref?.();}
  async function tick(){
    timer=null;woken=false;health.running=true;const started=now();let busy=false,failed=false;
    try {
      const pending=await probe(db);
      // One bounded owner per lane locally. Other replicas share the durable
      // tenant/partition fairness and claim fences; no model-wide timer scans.
      for(const [name,run] of [["ANALYTICS_PUBLICATION",publication],["MONEY_RESOLUTION",resolution]])if(pending.has(name)&&!stopped) {
        const result=await run({db,limit:2,maxRuntimeMs:2000,maxUnitsPerClaim:8});
        health.rounds++;health.units+=result.processed||0;busy ||= Boolean(result.processed||result.adopted);
        if(result.ok===false){failed=true;health.errors++;onError(result);}
      }
    }catch(error){failed=true;health.errors++;onError(error);}
    finally{health.running=false;health.lastCompletedAt=now();health.lastDurationMs=now()-started;
      idle=busy||woken?idleMs:Math.min(maxIdleMs,idle*2);
      arm(failed?idleMs:woken||busy?25:idle);
    }
  }
  function dispatch(){if(stopped)return Promise.resolve();if(running){woken=true;return running;}running=tick().finally(()=>{running=null;});return running;}
  const instance={wake(){if(stopped)return;woken=true;if(!running)arm(0);},stop(){stopped=true;instances.delete(instance);if(timer!==null)cancel(timer);timer=null;return running||Promise.resolve();},snapshot(){return{...health,stopped};}};
  instances.add(instance);arm(0);return instance;
}
module.exports={start,wakeAfterCommit,due};
