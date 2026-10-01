"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {startCampaignProjectionExecutor}=require('../src/services/campaign-projection-executor');
test('projection backlog runs independently of maintenance and yields finite fair rounds',async()=>{
 const timers=[];let calls=0;
 const e=startCampaignProjectionExecutor({db:{},schedule:(fn,ms)=>{timers.push({fn,ms});return timers.length;},cancel:()=>{},now:()=>0,
  run:async args=>{calls++;assert.equal(args.concurrency,2);assert.equal(args.limit,2);return {ok:true,processed:10,seed:{visited:100}};}});
 assert.equal(timers.shift().ms,0); // initial offer, then exercise its callback below via another fixture
 e.stop();
 const f=startCampaignProjectionExecutor({db:{},schedule:(fn,ms)=>{timers.push({fn,ms});return timers.length;},cancel:()=>{},now:()=>0,
  run:async()=>{calls++;return {ok:true,processed:10,seed:{visited:100}};}});
 await timers.shift().fn();assert.equal(calls,4);assert.equal(f.snapshot().units,40);assert.equal(timers[0].ms,10);
 f.stop();await timers.shift().fn();assert.equal(calls,4);
});
test('idle/error handling backs off and stop during an in-flight round prevents reschedule',async()=>{
 const timers=[];let complete;
 const e=startCampaignProjectionExecutor({db:{},schedule:(fn,ms)=>{timers.push({fn,ms});return timers.length;},cancel:()=>{},run:()=>new Promise(resolve=>complete=resolve)});
 const running=timers.shift().fn();assert.equal(e.snapshot().running,true);e.stop();complete({ok:true,processed:10});await running;assert.equal(timers.length,0);
 const f=startCampaignProjectionExecutor({db:{},schedule:(fn,ms)=>{timers.push({fn,ms});return timers.length;},cancel:()=>{},run:async()=>({ok:true,processed:0,seed:{visited:0}})});
 await timers.shift().fn();assert.equal(timers[0].ms,1000);f.stop();
});
