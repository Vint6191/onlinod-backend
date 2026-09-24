"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),vm=require("node:vm"),{webcrypto}=require("node:crypto");
const {policyFixture}=require("../../scripts/test-support/commercial-policy-fixture");
const source=fs.readFileSync(require.resolve("../../public/admin/modules/admin-billing/admin-commercial-policy.js"),"utf8");
function browser(overrides={}){
 let token="session-a";const listeners={},sent=[],storage=new Map();
 const elements=new Map();let html="";
 const element=()=>({value:"",disabled:false,textContent:"",handlers:{},addEventListener(k,fn){this.handlers[k]=fn;}});
 const root={isConnected:true,get innerHTML(){return html;},set innerHTML(value){html=value;elements.clear();for(const match of value.matchAll(/(?:name|id)="([^"]+)"[^>]*?(?:value="([^"]*)")?[^>]*>/g)){const node=element();const valueMatch=match[0].match(/value="([^"]*)"/);node.value=valueMatch?.[1]||"";elements.set(match[1],node);}const form=elements.get("blPolicyForm");if(form)form.querySelectorAll=()=>[...elements.entries()].filter(([k])=>!k.startsWith("blPolicy")).map(([,v])=>v);},querySelector(sel){return elements.get(sel.startsWith("#")?sel.slice(1):sel.match(/name="([^"]+)"/)[1])||null;}};
 const api={getToken:()=>token,commercialPolicy:async()=>policyFixture(),saveCommercialPolicy:async body=>{sent.push(structuredClone(body));return {ok:true,revision:2,settings:body.settings};},resolveCommand:async()=>({ok:true,pending:false}),...overrides};
 const window={OnlinodAdminApi:api,OnlinodAdminRouter:{escapeHtml:v=>String(v??"").replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;").replaceAll(">","&gt;")},addEventListener:(name,fn)=>{listeners[name]=fn;}};
 vm.runInNewContext(source,{window,crypto:webcrypto,TextEncoder,sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
 return{root,api,sent,storage,render:()=>window.OnlinodAdminCommercialPolicy.render(root),input:(key,value)=>{elements.get(key).value=value;},submit:()=>elements.get("blPolicyForm").handlers.submit({preventDefault(){}}),click:key=>elements.get(key).handlers.click(),status:()=>elements.get("blPolicyStatus")?.textContent||"",setToken:value=>{token=value;listeners['onlinod:admin-session-changed']();}};
}
test("global UI renders 14 days and converts displayed dollars to integer cents with revision and reason",async()=>{
 const b=browser();await b.render();assert.match(b.root.innerHTML,/name="trialDays"[^>]+value="14"/);b.input("trialDays","21");b.input("starterPriceCents","27.35");b.input("reason","New commercial terms");await b.submit();
 assert.equal(b.sent[0].expectedRevision,1);assert.equal(b.sent[0].settings.trialDays,21);assert.equal(b.sent[0].settings.starterPriceCents,2735);assert.equal(b.sent[0].reason,"New commercial terms");assert.equal(b.storage.size,0);
});
test("invalid prices, fractional duration and absent reason do not submit",async()=>{
 for(const [key,value] of [["trialDays","1.5"],["trialDays","0"],["starterPriceCents","0"],["starterPriceCents","1.001"],["reason",""]]){const b=browser();await b.render();b.input("reason","Change terms");b.input(key,value);await b.submit();assert.equal(b.sent.length,0);assert.ok(b.status());}
});
test("uncertain response retains exact intent through retry and page reload",async()=>{
 const sent=[];const b=browser({saveCommercialPolicy:async body=>{sent.push(JSON.stringify(body));return{ok:false,code:"NETWORK",error:"Result unknown"};}});await b.render();b.input("trialDays","30");b.input("reason","Launch terms");await b.submit();await b.render();await b.submit();assert.equal(sent.length,2);assert.equal(sent[0],sent[1]);assert.equal(b.storage.size,1);
});
test("stale revision rejection is visible and explicit reload obtains current revision",async()=>{
 const b=browser({saveCommercialPolicy:async()=>({ok:false,code:"BILLING_COMMERCIAL_POLICY_CHANGED",commandId:"cmd",httpStatus:409,error:"Reload current settings"})});await b.render();b.input("reason","Edit");await b.submit();assert.match(b.status(),/Reload/);b.api.commercialPolicy=async()=>({...policyFixture(),revision:5});await b.click("blPolicyReload");assert.match(b.root.innerHTML,/Revision 5/);assert.equal(b.storage.size,0);
});
test("late read from a prior admin session cannot populate a new session",async()=>{
 let release,started;const signal=new Promise(resolve=>{started=resolve;});const b=browser({commercialPolicy:()=>{started();return new Promise(resolve=>{release=resolve;});}});const pending=b.render();await signal;b.setToken("session-b");release(policyFixture());await pending;assert.equal(b.root.innerHTML,"");
});
test("late committed response after logout is discarded and error text is escaped",async()=>{
 let release;const b=browser({saveCommercialPolicy:()=>new Promise(resolve=>{release=resolve;})});await b.render();b.input("reason","Edit");const pending=b.submit();b.setToken("session-b");release({ok:true});await pending;assert.equal(b.root.innerHTML,"");
 const e=browser({commercialPolicy:async()=>({ok:false,error:'<img src=x onerror="x">'})});await e.render();assert.doesNotMatch(e.root.innerHTML,/<img/);assert.match(e.root.innerHTML,/&lt;img/);
});
