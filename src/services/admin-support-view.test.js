"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),vm=require("node:vm"),fs=require("node:fs"),path=require("node:path");
const code=fs.readFileSync(path.join(__dirname,"../../public/admin/core/admin-support-view.js"),"utf8");
function runtime({read,revoke,open}={}){
 const nodes=new Map(),listeners=new Map(),calls=[],timers=[];let token="admin-a",dialog=null;
 const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:"",innerHTML:"",disabled:false});return nodes.get(id);};
 const document={getElementById:()=>dialog,createElement:()=>{const obj={style:{},innerHTML:"",querySelector:node,showModal(){},close(){},remove(){dialog=null;},addEventListener(name,fn){listeners.set(name,fn);}};return obj;},body:{appendChild(x){dialog=x;}}};
 const grant={id:"g",agencyId:"a",expiresAt:"2030-01-01T00:15:00Z"};
 const response={ok:true,grant,agency:{id:"a",name:"Agency",status:"TRIAL",plan:"trial"},creators:[{id:"c",displayName:"<script>bad</script>",status:"DRAFT"}],nextCursor:null,authorityNow:"2030-01-01T00:00:00Z"};
 const window={OnlinodAdminApi:{getToken:()=>token,openSupport:async p=>{calls.push({open:p});return open?open(p):{ok:true,grant};},readSupport:read|| (async()=>response),revokeSupport:async(...args)=>{calls.push({revoke:args});return revoke?revoke(...args):{ok:true};}},OnlinodAdminRouter:{toast:m=>calls.push({toast:m}),escapeHtml:s=>String(s??"").replaceAll("<","&lt;").replaceAll(">","&gt;")},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
 vm.runInNewContext(code,{window,document,prompt:()=>"Support case",performance:{now:()=>0},Date,setTimeout:(fn)=>{timers.push(fn);return timers.length;},clearTimeout(){}});
 return {window,nodes,node,listeners,calls,timers,response,getDialog:()=>dialog,setToken:v=>{token=v;},open:()=>window.OnlinodAdminSupport.open("a")};
}
test("support view renders escaped diagnostics and has explicit expiry and revoke",async()=>{
 const r=runtime();await r.open();assert.match(r.node("#admSupportContent").innerHTML,/&lt;script&gt;/);assert.equal(r.node("#admSupportNext").disabled,true);
 r.timers.at(-1)();assert.match(r.node("#admSupportContent").textContent,/expired/);assert.equal(r.node("#admSupportRefresh").disabled,true);
 await r.node("#admSupportEnd").onclick();await new Promise(setImmediate);assert.equal(r.getDialog(),null);assert.equal(r.calls.filter(c=>c.revoke).length,1);
});
test("logout clears support content and a delayed response cannot restore it",async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);const r=runtime({read:()=>pending});const opening=r.open();await new Promise(setImmediate);
 r.setToken("");r.listeners.get("onlinod:admin-session-changed")();resolve(r.response);await opening;
 assert.equal(r.getDialog(),null);assert.equal(r.node("#admSupportContent").textContent,"");
});
test("cross-agency or wrong-grant responses never render their data",async()=>{
 const r=runtime({read:async()=>({ok:true,grant:{id:"foreign"},agency:{id:"b",name:"secret"}})});await r.open();assert.match(r.node("#admSupportContent").textContent,/context changed/);assert.equal(r.node("#admSupportContent").innerHTML,"");
});
test("failed revocation clears data and preserves a retry action",async()=>{
 const r=runtime({revoke:async()=>({ok:false,error:"Network uncertain"})});await r.open();await r.node("#admSupportEnd").onclick();await new Promise(setImmediate);
 assert.ok(r.getDialog());assert.equal(r.node("#admSupportEnd").disabled,false);assert.equal(r.node("#admSupportContent").textContent,"Network uncertain");
});
test("rejected grant does not open a support context",async()=>{
 const r=runtime({open:async()=>({ok:false,error:"retired agency"})});await r.open();assert.equal(r.getDialog(),null);assert.ok(r.calls.some(c=>c.toast==="retired agency"));
});
test("changing admin during grant issuance cannot open the previous admin's context",async()=>{
 let resolve;const pending=new Promise(r=>resolve=r);const r=runtime({open:()=>pending});const opening=r.open();
 r.setToken("new-admin");resolve({ok:true,grant:r.response.grant});await opening;assert.equal(r.getDialog(),null);
});
test("support commands preserve UUID across uncertain retry and are session-scoped",async()=>{
 const {webcrypto}=require("node:crypto"),storage=new Map(),window={};
 vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../../public/admin/core/admin-command-client.js"),"utf8"),{window,crypto:webcrypto,TextEncoder,Map,sessionStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)}});
 const command={path:"/api/admin/support/grants",method:"POST",body:{agencyId:"a",reason:"case"},token:"admin-one"};
 const first=await window.OnlinodAdminCommands.prepare(command),again=await window.OnlinodAdminCommands.prepare(command);
 assert.equal(first.commandId,again.commandId);assert.notEqual((await window.OnlinodAdminCommands.prepare({...command,token:"admin-two"})).commandId,first.commandId);
 assert.ok((await window.OnlinodAdminCommands.prepare({...command,path:"/api/admin/support/grants/g/revoke",body:{reason:"done"}})).commandId);
});
