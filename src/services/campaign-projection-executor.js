"use strict";

const { runCampaignProjectionSweep } = require("./campaign-read-projection-service");

// Each round gives every work class an admission opportunity. The existing
// domain dispatcher owns tenant/partition fairness and distributed leases.
// At most two commits use the pool concurrently; no recursive unbounded drain.
function startCampaignProjectionExecutor({db,run=runCampaignProjectionSweep,
  schedule=setTimeout,cancel=clearTimeout,now=Date.now,onError=()=>{},idleMs=1000,budgetMs=2000}={}) {
  let stopped=false,timer=null;
  const health={running:false,rounds:0,units:0,seedRows:0,errors:0,lastCompletedAt:null,lastDurationMs:0};
  async function tick(){
    timer=null;if(stopped)return;
    health.running=true;const started=now();let busy=false,failed=false;
    try{
      // Four finite rounds are an additional bound when the clock is injected
      // or a test/stub completes synchronously. Continue on a new event-loop turn.
      for(let round=0;round<4&&!stopped;round++){
        const result=await run({db,limit:2,concurrency:2,maxRuntimeMs:Math.max(1,budgetMs-(now()-started))});
        health.rounds++;health.units+=result.processed||0;health.seedRows+=result.seed?.visited||0;
        if(!result.ok){failed=true;health.errors++;onError(result);break;}
        busy=Boolean(result.processed||result.seed?.visited);
        if(!busy||now()-started>=budgetMs)break;
      }
    }catch(error){failed=true;health.errors++;onError(error);}
    finally{
      health.running=false;health.lastCompletedAt=now();health.lastDurationMs=now()-started;
      if(!stopped)timer=schedule(tick,failed?idleMs:busy?10:idleMs);
    }
  }
  timer=schedule(tick,0);
  return {stop(){stopped=true;if(timer!==null)cancel(timer);timer=null;},snapshot(){return {...health,stopped};}};
}

module.exports={startCampaignProjectionExecutor};
