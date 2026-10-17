"use strict";
// Per-process, bounded single-flight cache. It is a read optimization, never an
// access authority. Both membership fences remain outside the cache.
const TTL_MS = 2000, MAX_ENTRIES = 512;
const pools = new WeakMap();
async function readHomeCached(ctx, kind, read, page = null) {
  let cache = pools.get(ctx.db);
  if (!cache) { cache=new Map(); pools.set(ctx.db,cache); }
  const key=JSON.stringify([kind,ctx.agencyId,ctx.member.broad ? "agency" : ctx.member.id,ctx.member.broad ? null : ctx.member.userId,ctx.member.broad ? null : ctx.member.accessEpoch,
    ctx.member.broad,ctx.billing,ctx.money,ctx.manage,ctx.range.startDay,ctx.range.endDay,
    ctx.previous?.startDay,ctx.previous?.endDay,page]);
  const hit=cache.get(key), now=performance.now();
  if (hit && (hit.pending || hit.until>now)) return hit.promise;
  cache.delete(key);
  while (cache.size>=MAX_ENTRIES) cache.delete(cache.keys().next().value);
  const entry={agencyId:ctx.agencyId,pending:true,until:0,promise:null};
  entry.promise=Promise.resolve().then(read).then(value=>{
    entry.pending=false; entry.until=performance.now()+TTL_MS; return value;
  },error=>{ if(cache.get(key)===entry) cache.delete(key); throw error; });
  cache.set(key,entry);
  return entry.promise;
}
function invalidateAgency(agencyId,db=require("../prisma")) {
  const cache=pools.get(db);if(!cache)return;
  for(const [key,entry] of cache)if(entry.agencyId===agencyId)cache.delete(key);
}
module.exports={readHomeCached,invalidateAgency,TTL_MS,MAX_ENTRIES};
