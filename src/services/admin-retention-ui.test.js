"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm");
const source=fs.readFileSync(require.resolve("../../public/admin/modules/admin-system/admin-system.js"),"utf8").replace('window.OnlinodAdminSystem = { render };','window.OnlinodAdminSystem = { render, state, loadRetention, saveRetention, resetRetention, runRetentionNow, refreshRetentionCommand, renderRetentionResult };');
const policy={ok:true,revision:4,policyHash:"a".repeat(64),settings:{batchSize:100},defaults:{batchSize:2000}};
function browser(overrides={}){
 let token="session-a";const calls=[],listeners={};
 const api={getToken:()=>token,retentionSettings:async()=>structuredClone(policy),saveRetentionSettings:async body=>{calls.push(["set",body]);return {...policy,revision:5,settings:body.settings};},resetRetentionSettings:async body=>{calls.push(["reset",body]);return {...policy,revision:5};},runRetentionSweep:async body=>{calls.push(["run",body]);return {ok:true,accepted:true,commandId:"run-1",status:"QUEUED"};},commandStatus:async()=>({ok:true,commandId:"run-1",status:"PARTIAL",execution:{progress:{report:{totalDeleted:400,remainingWork:true}}}}),...overrides};
 const escape=value=>String(value).replaceAll("<","&lt;").replaceAll(">","&gt;");
 const window={OnlinodAdminApi:api,OnlinodAdminRouter:{escapeHtml:escape,escapeAttr:escape},addEventListener:(name,fn)=>{listeners[name]=fn;}};
 vm.runInNewContext(source,{window,document:{getElementById:()=>null},confirm:()=>true,console,setInterval,clearInterval});
 const ui=window.OnlinodAdminSystem;
 return {ui,calls,api,setToken:value=>{token=value;listeners['onlinod:admin-session-changed']();}};
}
test("retention UI sends displayed revision/hash and reason for set/reset/run",async()=>{
 const b=browser();await b.ui.loadRetention(true);b.ui.state.retentionReason="Investigate backlog";
 await b.ui.saveRetention();await b.ui.resetRetention();await b.ui.runRetentionNow();
 assert.equal(b.calls.length,3);assert.equal(b.calls[0][1].expectedRevision,4);assert.equal(b.calls[1][1].expectedRevision,5);
 for(const [,body] of b.calls){assert.equal(body.expectedPolicyHash,policy.policyHash);assert.equal(body.reason,"Investigate backlog");}
 assert.match(b.ui.renderRetentionResult(),/queued/);assert.doesNotMatch(b.ui.renderRetentionResult(),/completed/);
});
test("an uncertain policy response retains the exact intent for retry",async()=>{
 const sent=[];const b=browser({saveRetentionSettings:async body=>{sent.push(JSON.stringify(body));return {ok:false,code:"NETWORK",error:"Result unknown"};}});
 await b.ui.loadRetention(true);b.ui.state.retentionReason="Keep audit history";await b.ui.saveRetention();await b.ui.saveRetention();assert.equal(sent.length,2);assert.equal(sent[0],sent[1]);assert.equal(b.ui.state.retentionData.revision,4);
});
test("reload discards stale dirty draft together with its obsolete revision",async()=>{
 const b=browser();await b.ui.loadRetention(true);b.ui.state.retentionDraft.batchSize=500;b.ui.state.retentionDirty=true;b.api.retentionSettings=async()=>({...policy,revision:9,settings:{batchSize:300}});await b.ui.loadRetention(true);
 assert.equal(b.ui.state.retentionData.revision,9);assert.equal(b.ui.state.retentionDraft.batchSize,300);assert.equal(b.ui.state.retentionDirty,false);
});
test("session change clears queued status and discards late settings response",async()=>{
 let release;const b=browser({retentionSettings:()=>new Promise(resolve=>{release=resolve;})});const request=b.ui.loadRetention(true);b.setToken("session-b");release(policy);await request;assert.equal(b.ui.state.retentionData,null);assert.equal(b.ui.state.retentionCommand,null);
});
test("session change during mutation cannot publish old session success",async()=>{
 let release;const b=browser({saveRetentionSettings:()=>new Promise(resolve=>{release=resolve;})});await b.ui.loadRetention(true);b.ui.state.retentionReason="Change policy";const request=b.ui.saveRetention();b.setToken("session-b");release({...policy,revision:5});await request;assert.equal(b.ui.state.retentionData,null);assert.equal(b.ui.state.retentionResult,null);
});
test("poll reports PARTIAL truthfully and reload restores last durable run",async()=>{
 const b=browser();await b.ui.loadRetention(true);b.ui.state.retentionReason="Catch up";await b.ui.runRetentionNow();await b.ui.refreshRetentionCommand();assert.match(b.ui.renderRetentionResult(),/remaining work/);assert.doesNotMatch(b.ui.renderRetentionResult(),/Cleanup pass completed/);
 b.api.retentionSettings=async()=>({...policy,lastRun:{commandId:"from-server",status:"RUNNING"}});await b.ui.loadRetention(true);assert.equal(b.ui.state.retentionCommand.commandId,"from-server");
});
test("error report escapes stored text and missing reason prevents submission",async()=>{
 const b=browser();await b.ui.loadRetention(true);await b.ui.runRetentionNow();assert.equal(b.calls.length,0);
 b.ui.state.retentionCommand={status:"FAILED",execution:{progress:{report:{laneErrors:[{lane:"<img>",error:"<script>alert(1)</script>"}]}}}};assert.doesNotMatch(b.ui.renderRetentionResult(),/<script>|<img>/);
});
