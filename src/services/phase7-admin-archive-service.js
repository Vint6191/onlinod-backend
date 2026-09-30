'use strict';
const {TABLES,tableContract,readArchivePage,failure}=require('./phase7-legacy-storage-service');
const text=v=>typeof v==='string'&&v.trim()?v.trim():null;
function tableForModel(model){const name=String(model||'');const t=name.charAt(0).toUpperCase()+name.slice(1);return TABLES.has(t)&&TABLES.get(t).disposition!=='COMPAT_DRAIN_DROP'?t:null;}
async function scope(db,query){
 let agencyId=text(query.agencyId),creatorId=text(query.creatorId);
 if(creatorId){const c=await db.creatorAccount.findUnique({where:{id:creatorId},select:{agencyId:true}});if(!c||(agencyId&&agencyId!==c.agencyId))throw failure('PHASE7_ARCHIVE_CREATOR_SCOPE_INVALID',{status:404});agencyId=c.agencyId;}
 if(!agencyId)throw failure('PHASE7_ARCHIVE_AGENCY_REQUIRED',{status:400,message:'Select an agency or creator to browse the historical archive.'});
 return {agencyId,creatorId};
}
function pageDto(page,items=page.items){return {ok:true,authority:'historical_archive',readOnly:true,total:null,items,hasMore:page.hasMore,nextCursor:page.hasMore?page.nextCursor:null,bytes:page.bytes};}
async function creatorDescendantPage({db,table,agencyId,creatorId,query}) {
 const indexes=require("../../scripts/database/phase7-legacy-storage-indexes");
 const required=indexes.definitions.find(d=>d.table==="CrmProfile"&&d.keys.join(",")==="agencyId,creatorId,id");
 if(!(await indexes.state(db,required)).valid)throw failure("PHASE7_ARCHIVE_INDEX_REQUIRED");
 let state=null;const cursor=text(query.cursor);
 if(cursor){try{if(cursor.length>2048||!cursor.startsWith('p7:'))throw Error();state=JSON.parse(Buffer.from(cursor.slice(3),'base64url').toString('utf8'));}catch{throw failure('PHASE7_ARCHIVE_CURSOR_INVALID',{status:400});}
   if(state.table!==table||state.agencyId!==agencyId||state.creatorId!==creatorId||typeof state.profileId!=='string')throw failure('PHASE7_ARCHIVE_CURSOR_SCOPE_INVALID',{status:400});
 }
 const first=state?await db.crmProfile.findFirst({where:{id:state.profileId,agencyId,creatorId},select:{id:true}}):await db.crmProfile.findFirst({where:{agencyId,creatorId},orderBy:{id:'asc'},select:{id:true}});
 if(!first&&state){const next=await db.crmProfile.findFirst({where:{agencyId,creatorId,id:{gt:state.profileId}},orderBy:{id:'asc'},select:{id:true}});if(next)return {items:[],bytes:0,hasMore:true,nextCursor:'p7:'+Buffer.from(JSON.stringify({table,agencyId,creatorId,profileId:next.id,rowCursor:null})).toString('base64url')};}
 if(!first)return {items:[],bytes:0,hasMore:false,nextCursor:null};
 const page=await readArchivePage({db,table,agencyId,profileId:first.id,cursor:state?.rowCursor||null,limit:query.limit,maxBytes:1048576});
 const next=page.hasMore?{profileId:first.id,rowCursor:page.nextCursor}:await db.crmProfile.findFirst({where:{agencyId,creatorId,id:{gt:first.id}},orderBy:{id:'asc'},select:{id:true}}).then(p=>p?{profileId:p.id,rowCursor:null}:null);
 return {...page,hasMore:!!next,nextCursor:next?'p7:'+Buffer.from(JSON.stringify({table,agencyId,creatorId,...next})).toString('base64url'):null};
}
async function list({db,table,query={}}){
 const owner=await scope(db,query),profileId=text(query.profileId),contract=tableContract(table);
 if(profileId){const p=await db.crmProfile.findUnique({where:{id:profileId},select:{agencyId:true,creatorId:true}});if(!p||p.agencyId!==owner.agencyId||(owner.creatorId&&p.creatorId!==owner.creatorId))throw failure('PHASE7_ARCHIVE_PROFILE_SCOPE_INVALID',{status:404});}
 const page=owner.creatorId&&!profileId&&contract.columns.includes('profileId')&&!contract.columns.includes('creatorId')
   ?await creatorDescendantPage({db,table,...owner,query})
   :await readArchivePage({db,table,...owner,cursor:text(query.cursor),profileId:contract.columns.includes('profileId')?profileId:null,limit:query.limit,maxBytes:1048576});
 const q=(text(query.q)||'').toLowerCase();
 const items=page.items.filter(r=>(!text(query.fanId)||String(r.fanId)===text(query.fanId))&&(!text(query.kind)||r.kind===text(query.kind))&&(!text(query.status)||r.status===text(query.status))&&(!q||['name','username','fanId','label','tagKey'].some(k=>String(r[k]||'').toLowerCase().includes(q)))&&(table!=='CrmNote'||!r.deletedAt));
 return {...pageDto(page,items),filterMode:'bounded_page',scannedRows:page.items.length};
}
async function inspect({db,table,id,maxBytes=1048576}){
 const t=tableContract(table),model=t.table.charAt(0).toLowerCase()+t.table.slice(1);
 const row=await db[model].findUnique({where:{id},select:{id:true,[t.scopeColumn]:true}});if(!row)return null;
 const page=await readArchivePage({db,table,agencyId:row[t.scopeColumn],rowId:id,limit:1,maxBytes,orphanScope:row[t.scopeColumn]===null});return page.items[0]||null;
}
const SECTIONS=Object.freeze({tags:'CrmProfileTag',rawTags:'CrmProfileRawTag',notes:'CrmNote',runs:'CrmAnalysisRun'});
async function profile({db,id,query={}}){
 const row=await inspect({db,table:'CrmProfile',id});if(!row)throw failure('NOT_FOUND',{status:404});
 const section=text(query.section);
 async function child(key){const page=await readArchivePage({db,table:SECTIONS[key],agencyId:row.agencyId,profileId:id,limit:50,maxBytes:524288,cursor:section?text(query.cursor):null});return pageDto(page,key==='notes'?page.items.filter(r=>!r.deletedAt):page.items);}
 if(section){if(!SECTIONS[section])throw failure('PHASE7_ARCHIVE_SECTION_INVALID',{status:400});return {id,section,...await child(section)};}
 const pages={};for(const key of Object.keys(SECTIONS)){const p=await child(key);row[key]=p.items;pages[key]={hasMore:p.hasMore,nextCursor:p.nextCursor};}
 return {ok:true,authority:'historical_archive',readOnly:true,profile:row,pages};
}
module.exports={scope,list,profile,inspect,tableForModel,SECTIONS,pageDto};
