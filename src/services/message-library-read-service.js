"use strict";
const fail=(code,message,status=409)=>Object.assign(new Error(message),{code,status});
const {inspectMessageLibraryBlockIdentities}=require('./message-library-lifecycle-service');
const ACTIVE=`"deletedAt" IS NULL AND status NOT IN ('trash','deleted')`;
async function blockSummary(db,collectionIds) {
  if (!collectionIds.length) return new Map();
  const rows=await db.$queryRawUnsafe(`SELECT "collectionId",
    count(*) FILTER(WHERE ${ACTIVE})::integer "activeMessageCount",
    count(*) FILTER(WHERE NOT (${ACTIVE}))::integer "trashedMessageCount",
    coalesce(sum(octet_length(to_jsonb(b)::text)) FILTER(WHERE ${ACTIVE}),0)::bigint "activeBytes",
    md5(coalesce(string_agg(id || ':' || md5(to_jsonb(b)::text),'|' ORDER BY id) FILTER(WHERE ${ACTIVE}),'')) digest
    FROM "ContentBlock" b WHERE "collectionId"=ANY($1::text[]) GROUP BY "collectionId"`,collectionIds);
  return new Map(rows.map(row=>[row.collectionId,{...row,activeBytes:Number(row.activeBytes)}]));
}
function contentSnapshot(collection,summary) {
  return {version:1,revision:new Date(collection.updatedAt).toISOString(),activeCount:summary?.activeMessageCount || 0,
    digest:summary?.digest || 'd41d8cd98f00b204e9800998ecf8427e'};
}
async function readBlockPage(db,collection,{state='active',offset=0,limit=100,snapshotRevision}={}) {
  if (!['active','trash'].includes(state) || !Number.isSafeInteger(offset) || offset<0 || offset>1000000)
    throw fail('MESSAGE_LIBRARY_BLOCK_PAGE_INVALID','Invalid block page',400);
  const heads=await db.$queryRawUnsafe('SELECT revision::text revision FROM "MessageLibraryScopeRevision" WHERE "agencyId"=$1 AND "creatorId"=$2',collection.agencyId,collection.creatorId);
  const revision='ml-blocks.v1.'+Buffer.from(JSON.stringify([collection.id,new Date(collection.updatedAt).toISOString(),heads[0]?.revision || '0',state])).toString('base64url');
  if ((offset>0 && !snapshotRevision) || (snapshotRevision && snapshotRevision!==revision))
    throw fail('MESSAGE_LIBRARY_REVISION_CONFLICT','Script changed; reload its messages');
  const predicate=state==='active' ? ACTIVE : `NOT (${ACTIVE})`;
  const take=Math.max(1,Math.min(100,Math.floor(Number(limit)||100)));
  const rows=await db.$queryRawUnsafe(`WITH candidates AS MATERIALIZED (
      SELECT id,"order",octet_length(to_jsonb(b)::text)+2048 bytes FROM "ContentBlock" b
      WHERE "collectionId"=$1 AND ${predicate} ORDER BY "order",id LIMIT $2 OFFSET $3
    ), sized AS (SELECT *,sum(bytes) OVER(ORDER BY "order",id ROWS UNBOUNDED PRECEDING) used,
      row_number() OVER(ORDER BY "order",id) ordinal FROM candidates)
    SELECT b.* FROM sized s JOIN "ContentBlock" b ON b.id=s.id
      WHERE s.used<=262144 OR (s.ordinal=1 AND s.bytes<=2097152)
      ORDER BY b."order",b.id`,collection.id,take,offset);
  const total=Number((await db.$queryRawUnsafe(`SELECT count(*) n FROM "ContentBlock" WHERE "collectionId"=$1 AND ${predicate}`,collection.id))[0].n);
  if (!rows.length && offset<total) throw fail('MESSAGE_LIBRARY_BLOCK_TOO_LARGE','This block exceeds the readable content limit',413);
  await inspectMessageLibraryBlockIdentities({db,collectionId:collection.id,messageIds:rows.map(row=>row.clientId??row.id)});
  return {rows,count:total,offset,nextOffset:offset+rows.length,hasMore:offset+rows.length<total,snapshotRevision:revision};
}
async function assertCompleteSnapshot(db,collection,payload) {
  const summary=(await blockSummary(db,[collection.id])).get(collection.id), expected=contentSnapshot(collection,summary), got=payload.contentSnapshot;
  if (payload.contentState!=='complete' || !got || got.version!==1 || got.revision!==expected.revision
    || got.activeCount!==expected.activeCount || got.digest!==expected.digest)
    throw fail('MESSAGE_LIBRARY_COMPLETE_CONTENT_REQUIRED','Load the complete current script before replacing its messages',428);
}
async function readMessageLibrarySearchPage(db,{agencyId,creatorId,includeTrash,search,limit,offset}) {
  // Filter tags in the same bounded server query as titles and message content.
  // A client-side filter cannot recover a tag-only script omitted by a page.
  const where=`c."agencyId"=$1 AND c."creatorId"=$2 AND c.kind='message_library_script'
    AND c.status<>'deleting' AND ($3::boolean OR (c."deletedAt" IS NULL AND c.status NOT IN ('trash','deleted')))
    AND (strpos(lower(c.title),lower($4))>0 OR strpos(lower(coalesce(c.description,'')),lower($4))>0
      OR EXISTS (SELECT 1 FROM jsonb_array_elements(CASE WHEN jsonb_typeof(c.tags)='array' THEN c.tags ELSE '[]'::jsonb END) tag(value)
        WHERE jsonb_typeof(tag.value)='string' AND strpos(lower(tag.value #>> '{}'),lower($4))>0)
      OR EXISTS (SELECT 1 FROM "ContentBlock" b WHERE b."collectionId"=c.id AND b."deletedAt" IS NULL AND b.status NOT IN ('trash','deleted')
        AND (strpos(lower(b.text),lower($4))>0 OR strpos(lower(coalesce(b.title,'')),lower($4))>0 OR strpos(lower(coalesce(b.note,'')),lower($4))>0)))`;
  const params=[agencyId,creatorId,includeTrash,search];
  const items=await db.$queryRawUnsafe(`SELECT c.* FROM "ContentCollection" c WHERE ${where} ORDER BY c."updatedAt" DESC,c.id DESC LIMIT $5 OFFSET $6`,...params,limit,offset);
  const count=Number((await db.$queryRawUnsafe(`SELECT count(*) n FROM "ContentCollection" c WHERE ${where}`,...params))[0].n);
  return {items,count};
}
module.exports={blockSummary,contentSnapshot,readBlockPage,assertCompleteSnapshot,readMessageLibrarySearchPage};
