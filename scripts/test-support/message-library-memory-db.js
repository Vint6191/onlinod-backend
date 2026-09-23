"use strict";
const {createMemoryDb}=require("./admin-command-memory-db");
// Fault model only: does not emulate PostgreSQL lock contention.
function createContentDb(options={}){
 const at=new Date("2026-01-01T00:00:00Z");
 return createMemoryDb({...options,extendState:{collections:[{id:"collection-a",agencyId:"agency-a",creatorId:"creator-a",clientId:"script-a",kind:"message_library_script",status:"active",deletedAt:null,purgeAfter:null,updatedAt:at,createdAt:at}],blocks:[{id:"block-a",collectionId:"collection-a",clientId:"message-a",status:"active",deletedAt:null,purgeAfter:null}],contentAudit:[],member:{id:"member-a",userId:"user-a",agencyId:"agency-a",role:"OWNER",roleKey:"owner",accessEpoch:1,assignedCreators:"all",deletedAt:null},...options.extendState},extendClient(api,{read,copy,clock}){
  const raw=api.$queryRawUnsafe;
  api.$queryRawUnsafe=async(sql,...args)=>{
   if(sql.includes('FROM "User"'))return options.disabledUser?[]:[{id:args[0]}];
   if(sql.includes('FROM "AgencyMember"'))return read().member?[{id:args[0]}]:[];
   if(sql.includes('FROM "CreatorAccount"') && !Array.isArray(args[0]))return read().creators.filter(row=>row.id===args[0]&&row.agencyId===args[1]&&!row.deletedAt).map(copy);
   if(sql.includes('FROM "ContentCollection"'))return read().collections.filter(row=>row.agencyId===args[0]&&row.clientId===args[1]).map(copy);
   return raw(sql,...args);
  };
  const matches=(row,where={})=>Object.entries(where).every(([k,v])=>{
   if(k==="OR")return v.some(w=>matches(row,w));if(k==="AND")return v.every(w=>matches(row,w));
   if(k==="blocks")return !read().blocks.some(b=>b.collectionId===row.id);
   if(k==="collection")return matches(read().collections.find(c=>c.id===row.collectionId)||{},v);
   if(k==="creator")return read().creators.some(c=>c.id===row.creatorId&&!c.deletedAt);
   if(k==="agency")return read().agencies.some(c=>c.id===row.agencyId&&!c.deletedAt);
   if(v && typeof v==="object" && !(v instanceof Date)){if(v.in)return v.in.includes(row[k]);if(v.notIn)return !v.notIn.includes(row[k]);if(v.not!==undefined)return row[k]!==v.not;if(v.lte)return row[k]!=null&&row[k]<=v.lte;}
   return row[k]===v;
  });
  function model(name){return {
   findFirst:async({where,include})=>{const row=read()[name].find(r=>matches(r,where));return row?{...copy(row),...(include?.blocks?{blocks:copy(read().blocks.filter(b=>b.collectionId===row.id))}:{})}:null;},
   findMany:async({where,take,select})=>{if(take && take>200)throw Error("unbounded selection");return read()[name].filter(r=>matches(r,where)).slice(0,take||200).map(row=>select?.collection?{collection:copy(read().collections.find(c=>c.id===row.collectionId))}:copy(row));},
   update:async({where,data,include})=>{const row=read()[name].find(r=>matches(r,where));if(!row)throw Error("missing row");Object.assign(row,copy(data),{updatedAt:copy(clock)});return {...copy(row),...(include?.blocks?{blocks:copy(read().blocks.filter(b=>b.collectionId===row.id))}:{})};},
   deleteMany:async({where})=>{const rows=read()[name].filter(r=>matches(r,where));read()[name]=read()[name].filter(r=>!rows.includes(r));return {count:rows.length};},
  };}
  api.contentCollection=model("collections");api.contentBlock=model("blocks");
  api.agencyMember={findFirst:async()=>read().member&&!read().member.deletedAt&&!read().member.deactivatedAt?copy(read().member):null};
  api.auditLog={create:async({data})=>{if(options.failContentAudit)throw Error("audit unavailable");read().contentAudit.push(copy(data));return data;}};
  return api;
 }});
}
module.exports={createContentDb};
