"use strict";
const test=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),path=require("node:path"),vm=require("node:vm");
function ui(){
 const sent=[], values={"#admArchiveReason":{value:"reviewed"},"#admArchiveCutoff":{value:"2026-01-01T00:00"},"#admBulkDel":{}};
 const window={OnlinodAdminApi:{dataArchiveDeliveries:async(id,body)=>{sent.push({id,body});return {ok:false,error:"stop before reload"};}},OnlinodAdminRouter:{toast:()=>{},escapeHtml:String}};
 const source=fs.readFileSync(path.join(__dirname,"../../public/admin/modules/admin-data/admin-data.js"),"utf8").replace("window.OnlinodAdminData = { render };","window.OnlinodAdminData = { render, view, archiveSelected, toggleSel, canSelect, renderTable };");
 vm.runInNewContext(source,{window,Date,confirm:()=>true});const mod=window.OnlinodAdminData;
 Object.assign(mod.view,{entity:"deliveries",filters:{agencyId:"a",creatorId:"c"},rows:[{id:"d",agencyId:"a",creatorId:"c",originKind:"AUTOMATION",status:"COMPLETED",finishedAt:"2025-01-01T00:00:00Z",updatedAt:"2025-02-01T00:00:00Z"}]});mod.view.selected.add("d");
 return {...mod,sent,body:{querySelector:k=>values[k]},values,source};
}
test("actual archive UI sends displayed revision and explicit UTC cutoff and reason",async()=>{
 const m=ui();await m.archiveSelected(m.body);assert.equal(m.sent.length,1);const r=m.sent[0];assert.equal(r.id,"c");assert.equal(r.body.agencyId,"a");assert.equal(r.body.reason,"reviewed");assert.equal(r.body.olderThan,"2026-01-01T00:00:00.000Z");assert.equal(r.body.items[0].expectedUpdatedAt,"2025-02-01T00:00:00Z");
});
test("UI rejects missing scope, cutoff, reason or foreign selection",async()=>{
 for(const kind of ["scope","cutoff","reason","foreign"]){const m=ui();if(kind==="scope")m.view.filters.creatorId="";if(kind==="cutoff")m.values["#admArchiveCutoff"].value="";if(kind==="reason")m.values["#admArchiveReason"].value="";if(kind==="foreign")m.view.rows[0].agencyId="b";await m.archiveSelected(m.body);assert.equal(m.sent.length,0);}
});
test("UI selection is bounded and arbitrary delete controls are absent",()=>{
 const m=ui();for(let i=0;i<200;i++)m.toggleSel(String(i),true);assert.equal(m.view.selected.size,100);assert.doesNotMatch(m.source,/dataBulkDelete|dataDeleteRecord|dataPurgeDeliveries|data-del=|data-fix=/);
});

test("creator detail retains inspect without a second generic delete caller",()=>{
 const source=fs.readFileSync(path.join(__dirname,"../../public/admin/modules/admin-creator-detail/admin-creator-detail.js"),"utf8");assert.match(source,/dataInspect/);assert.doesNotMatch(source,/dataDeleteRecord|data-del=/);
});
