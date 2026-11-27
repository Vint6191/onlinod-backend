"use strict";
const MAX_BLOCKS = 500;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA = 2000;
const COLLECTION_FIELDS = ["agencyId","creatorId","kind","title","description","tags","status","clientId","deletedAt","purgeAfter","trashedByUserId","createdByUserId","updatedByUserId","metadata"];
const BLOCK_FIELDS = ["order","role","title","text","priceCents","currency","lockedText","media","note","clientId","metadata"];
const pick = (row, fields) => Object.fromEntries(fields.filter(key => row[key] !== undefined).map(key => [key,row[key]]));
const activeBlock = block => !block.deletedAt && !["trash","deleted"].includes(block.status);
function aggregateState(data, blocks) {
  const media = new Set(blocks.flatMap(block => Array.isArray(block.media) ? block.media.map(item => String(item?.id || "").trim()).filter(Boolean) : []));
  return { activeMessages:blocks.length, distinctMedia:media.size,
    bytes:Buffer.byteLength(JSON.stringify({data:pick(data,COLLECTION_FIELDS),blocks:blocks.map(block => pick(block,BLOCK_FIELDS))})) };
}
function assertMessageLibraryAggregate(data, blocks) {
  const state = aggregateState(data,blocks);
  if (state.activeMessages > MAX_BLOCKS || state.bytes > MAX_BYTES || state.distinctMedia > MAX_MEDIA)
    throw Object.assign(new Error("A script supports at most 500 active messages, 2 MiB of content and 2000 distinct media references"),
      {code:"MESSAGE_LIBRARY_SCRIPT_LIMIT",status:413,limits:state});
  return state;
}
async function assertMessageLibraryRestore(tx, collection, restoredBlock = null) {
  const blocks = await tx.contentBlock.findMany({where:{collectionId:collection.id,deletedAt:null,status:{notIn:["trash","deleted"]}},
    orderBy:[{order:"asc"},{id:"asc"}],take:MAX_BLOCKS+1});
  if (restoredBlock && !blocks.some(block => block.id === restoredBlock.id)) blocks.push(restoredBlock);
  return assertMessageLibraryAggregate(collection,blocks);
}
module.exports = {MAX_BLOCKS,MAX_BYTES,MAX_MEDIA,activeBlock,aggregateState,assertMessageLibraryAggregate,assertMessageLibraryRestore};
