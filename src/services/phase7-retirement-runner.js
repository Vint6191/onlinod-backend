"use strict";
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { manifest, DESTRUCTIVE, COHORTS, q, sha, failure, tableContract, readArchivePage, runDbTransaction } = require('./phase7-legacy-storage-service');
const { handoffLegacyJob } = require('./phase7-obligation-handoff-service');
const md5 = x => crypto.createHash('md5').update(x).digest('hex');
const agencyKey = (t, id) => !t.scopeColumn ? 'g:GLOBAL' : id === null ? 'q:NULL' : 'a:' + id;
const partitionId = (table, key) => table + ':' + md5(key);
function scope(t, agencyId, values) {
  if (!t.scopeColumn) return 'TRUE';
  if (agencyId === null) return `x.${q(t.scopeColumn)} IS NULL`;
  values.push(agencyId); return `x.${q(t.scopeColumn)}=$${values.length}`;
}
async function enumerateCohort({ db, cohortId, budget = 32 }) {
  if (!COHORTS.includes(cohortId)) throw failure('PHASE7_COHORT_INVALID');
  return runDbTransaction(db, async tx => {
    const rows = await tx.$queryRawUnsafe('SELECT * FROM "Phase7RetirementCohort" WHERE "id"=$1 FOR UPDATE', cohortId);
    const c = rows[0];
    if (!c || c.planHash !== manifest.planHash) throw failure('PHASE7_STORAGE_MANIFEST_MISMATCH');
    if (c.enumerationComplete || c.state === 'PURGED') return { complete: true, discovered: 0 };
    const progress = { ...c.enumeration }; let left = Math.max(1, Math.min(64, budget)), discovered = 0;
    for (const t of DESTRUCTIVE.filter(t => t.cohort === cohortId)) {
      const state = { ...(progress[t.table] || {}) };
      if (state.done || left <= 0) continue;
      if (!state.started) {
        // NULL/orphan and global scopes are finite explicit partitions, never
        // a request to enumerate all tenants into an application-side array.
        const nullRows = await tx.$queryRawUnsafe(`SELECT "id" FROM ${q(t.table)} WHERE ${t.scopeColumn ? q(t.scopeColumn) + ' IS NULL' : 'TRUE'} LIMIT 1`);
        if (nullRows.length) {
          const key = agencyKey(t, null);
          await tx.phase7RetirementPartition.upsert({ where: { tableName_agencyKey: { tableName: t.table, agencyKey: key } },
            create: { id: partitionId(t.table,key), cohortId, tableName:t.table, agencyKey:key, agencyId:null }, update:{} });
          discovered++;
        }
        state.started = true;
        if (!t.scopeColumn) state.done = true;
      }
      while (!state.done && left > 0) {
        // Loose index scan: jump over the entire previous agency key instead of
        // scanning all its rows for DISTINCT. Online index is a preflight gate.
        const next = await tx.$queryRawUnsafe(`SELECT ${q(t.scopeColumn)} AS agency FROM ${q(t.table)}
          WHERE ${q(t.scopeColumn)} IS NOT NULL ${state.after === undefined ? '' : `AND ${q(t.scopeColumn)}>$1`}
          ORDER BY ${q(t.scopeColumn)},"id" LIMIT 1`, ...(state.after === undefined ? [] : [state.after]));
        left--;
        if (!next.length) { state.done = true; break; }
        const id = next[0].agency, key = agencyKey(t,id);
        await tx.phase7RetirementPartition.upsert({ where:{tableName_agencyKey:{tableName:t.table,agencyKey:key}},
          create:{id:partitionId(t.table,key),cohortId,tableName:t.table,agencyKey:key,agencyId:id},update:{} });
        state.after = id; discovered++;
      }
      progress[t.table] = state;
    }
    const complete = DESTRUCTIVE.filter(t => t.cohort === cohortId).every(t => progress[t.table]?.done);
    await tx.phase7RetirementCohort.update({ where:{id:cohortId},data:{enumeration:progress,enumerationComplete:complete,state:'DRAINING',revision:{increment:1}} });
    return { complete, discovered };
  }, { timeout: 10000 });
}
async function claimPartition(db, { leaseMs = 30000, onlyId = null } = {}) {
  return runDbTransaction(db, async tx => {
    const token = crypto.randomUUID();
    const rows = await tx.$queryRawUnsafe(`WITH candidate AS (
      SELECT p."id" FROM "Phase7RetirementPartition" p JOIN "Phase7RetirementCohort" c ON c."id"=p."cohortId"
      WHERE c."planHash"=$1 AND c."state" NOT IN ('PURGED','PURGE_READY')
      AND (p."state"='PENDING' OR (p."state"='RUNNING' AND p."leaseUntil"<=clock_timestamp()))
      AND p."nextAt"<=clock_timestamp() AND ($4::text IS NULL OR p."id"=$4)
      ORDER BY p."nextAt",p."agencyKey",p."id" FOR UPDATE OF p SKIP LOCKED LIMIT 1
    ) UPDATE "Phase7RetirementPartition" p SET "state"='RUNNING',"ownerToken"=$2,"leaseRevision"=p."leaseRevision"+1,
      "leaseUntil"=clock_timestamp()+($3::int*interval '1 millisecond'),"lastError"=NULL,"updatedAt"=clock_timestamp()
      FROM candidate c WHERE p."id"=c."id" RETURNING p.*`, manifest.planHash,token,Math.max(5000,Math.min(60000,leaseMs)),onlyId);
    const p = rows[0]; if (!p) return null;
    if (p.upperBound === null) {
      const t = tableContract(p.tableName), values = [];
      const upper = await tx.$queryRawUnsafe(`SELECT x."id"::text AS id FROM ${q(t.table)} x WHERE ${scope(t,p.agencyId,values)} ORDER BY x."id" DESC LIMIT 1`, ...values);
      p.upperBound = upper[0]?.id || null;
      if (!p.upperBound) {
        await tx.phase7RetirementPartition.update({where:{id:p.id},data:{state:'EXPORTED',ownerToken:null,leaseUntil:null}});
        return { ...p, empty:true };
      }
      await tx.phase7RetirementPartition.update({where:{id:p.id},data:{upperBound:p.upperBound}});
    }
    return p;
  }, { timeout:10000 });
}
async function archiveDirectory(directory) {
  const root = path.resolve(directory);
  await fs.mkdir(root,{recursive:true,mode:0o700});
  const st = await fs.lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink() || await fs.realpath(root) !== root) throw failure('PHASE7_ARCHIVE_DIRECTORY_INVALID');
  return root;
}
async function readArtifact(root, name, cap = manifest.pageBytes) {
  if (!/^[a-f0-9]{64}\.(jsonl|manifest\.json)$/.test(name)) throw failure('PHASE7_ARCHIVE_NAME_INVALID');
  const file = path.join(root,name), st = await fs.lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > cap) throw failure('PHASE7_ARCHIVE_FILE_INVALID');
  const h = await fs.open(file, require('node:fs').constants.O_RDONLY | (require('node:fs').constants.O_NOFOLLOW || 0));
  try { const actual = await h.stat(); if (actual.size > cap) throw failure('PHASE7_ARCHIVE_FILE_OVERSIZE'); const buffer=Buffer.alloc(Math.min(cap+1,actual.size+1)); let offset=0;
    while (offset<buffer.length) { const r=await h.read(buffer,offset,buffer.length-offset,null); if (!r.bytesRead) break; offset+=r.bytesRead; }
    if (offset>cap || offset!==actual.size) throw failure('PHASE7_ARCHIVE_FILE_CHANGED');
    const extra=Buffer.alloc(1); if ((await h.read(extra,0,1,null)).bytesRead) throw failure('PHASE7_ARCHIVE_FILE_CHANGED');
    return buffer.subarray(0,offset); }
  finally { await h.close(); }
}
async function durableArtifact(root,name,bytes) {
  if (bytes.length > manifest.pageBytes) throw failure('PHASE7_ARCHIVE_CHUNK_OVERSIZE');
  const temp = path.join(root,'.pending-' + crypto.randomUUID());
  const h = await fs.open(temp,'wx',0o600);
  try { await h.writeFile(bytes); await h.sync(); } finally { await h.close(); }
  try { await fs.link(temp,path.join(root,name)); }
  catch(error) { if (error.code !== 'EEXIST') throw error; if (sha(await readArtifact(root,name)) !== sha(bytes)) throw failure('PHASE7_ARCHIVE_CHUNK_CONFLICT'); }
  finally { await fs.unlink(temp).catch(()=>{}); }
  // fsync the directory makes the committed name survive a host crash.
  const d = await fs.open(root,'r'); try { await d.sync(); } finally { await d.close(); }
}
function chunkManifest(p,c){return {version:1,generation:manifest.generation,planHash:manifest.planHash,partitionId:p.id,tableName:p.tableName,agencyId:p.agencyId,
  sourceEpoch:String(p.sourceEpoch),sequence:c.sequence,startCursor:c.startCursor,endCursor:c.endCursor,rows:c.rows,bytes:c.bytes,digest:c.digest,previousDigest:c.previousDigest};}
async function processPartition({ db, partition, directory, limit = 100 }) {
  const p = partition; if (p.empty) return { partitionId:p.id,empty:true };
  try {
    const page = await readArchivePage({ db,table:p.tableName,agencyId:p.agencyId,cursor:p.cursor,upperBound:p.upperBound,limit,orphanScope:p.agencyId===null });
    if (p.tableName === 'AutomationJob') {
      for (let i=0;i<page.items.length;i++) await handoffLegacyJob({ db,job:page.items[i],sourceHash:page.sourceHashes[i] });
    }
    const root = await archiveDirectory(directory);
    if (p.archiveRoot && p.archiveRoot !== sha(root)) throw failure('PHASE7_EXPORT_ROOT_CHANGED');
    if (!page.items.length) {
      // No unaccounted deletion may silently look like end-of-input.
      return await runDbTransaction(db, async tx => {
        const changed = await tx.$executeRawUnsafe(`UPDATE "Phase7RetirementPartition" SET "state"='EXPORTED',"ownerToken"=NULL,"leaseUntil"=NULL
          WHERE "id"=$1 AND "ownerToken"=$2 AND "leaseRevision"=$3 AND "sourceEpoch"=$4 AND "leaseUntil">clock_timestamp()`,p.id,p.ownerToken,p.leaseRevision,p.sourceEpoch);
        if (!changed) throw failure('PHASE7_STALE_PARTITION_OWNER'); return {partitionId:p.id,empty:true};
      });
    }
    const data = Buffer.from(page.bodies.join('\n')+'\n'), digest = sha(data), sequence = p.sequence + 1;
    const name = sha(JSON.stringify([p.id,String(p.sourceEpoch),sequence,digest]))+'.jsonl';
    await durableArtifact(root,name,data);
    const descriptor=chunkManifest(p,{sequence,startCursor:p.cursor,endCursor:page.nextCursor,rows:page.items.length,bytes:data.length,digest,previousDigest:p.digest});
    await durableArtifact(root,name.replace('.jsonl','.manifest.json'),Buffer.from(JSON.stringify(descriptor)+'\n'));
    const chain = sha(JSON.stringify([p.digest,digest,page.nextCursor,page.items.length,data.length]));
    return await runDbTransaction(db, async tx => {
      const changed = await tx.$executeRawUnsafe(`UPDATE "Phase7RetirementPartition" SET "cursor"=$5,"sequence"=$6,
        "rows"="rows"+$7,"bytes"="bytes"+$8,"digest"=$9,"state"=$10,"archiveRoot"=$11,"ownerToken"=NULL,"leaseUntil"=NULL,
        "nextAt"=clock_timestamp(),"updatedAt"=clock_timestamp()
        WHERE "id"=$1 AND "ownerToken"=$2 AND "leaseRevision"=$3 AND "sourceEpoch"=$4 AND "leaseUntil">clock_timestamp()`,
        p.id,p.ownerToken,p.leaseRevision,p.sourceEpoch,page.nextCursor,sequence,page.items.length,data.length,chain,page.hasMore?'PENDING':'EXPORTED',sha(root));
      if (!changed) throw failure('PHASE7_STALE_PARTITION_OWNER');
      await tx.phase7RetirementChunk.create({data:{id:sha(JSON.stringify([p.id,String(p.sourceEpoch),sequence])),partitionId:p.id,sourceEpoch:p.sourceEpoch,
        sequence,startCursor:p.cursor,endCursor:page.nextCursor,rows:page.items.length,bytes:data.length,digest,previousDigest:p.digest,fileName:name}});
      return { partitionId:p.id,rows:page.items.length,bytes:data.length,state:page.hasMore?'PENDING':'EXPORTED' };
    },{timeout:10000});
  } catch(error) {
    await runDbTransaction(db, tx => tx.$executeRawUnsafe(`UPDATE "Phase7RetirementPartition" SET "state"='BLOCKED',"lastError"=$5,"ownerToken"=NULL,"leaseUntil"=NULL
      WHERE "id"=$1 AND "ownerToken"=$2 AND "leaseRevision"=$3 AND "sourceEpoch"=$4 AND "leaseUntil">clock_timestamp()`,
      p.id,p.ownerToken,p.leaseRevision,p.sourceEpoch,String(error.code || error.message).slice(0,500)));
    throw error;
  }
}
async function verifyPartitionPage({ db, directory, partitionId: id }) {
  const p = await db.phase7RetirementPartition.findUnique({where:{id}});
  if (!p || !['EXPORTED','VERIFIED'].includes(p.state)) throw failure('PHASE7_ARCHIVE_NOT_EXPORTED');
  if (p.state === 'VERIFIED') return {verified:true};
  const chunks = await db.phase7RetirementChunk.findMany({where:{partitionId:id,sourceEpoch:p.sourceEpoch,sequence:{gt:p.verifiedSequence}},orderBy:{sequence:'asc'},take:1});
  let next = p.verifiedSequence, chain = p.verifiedDigest || '', restoreRoot=p.restoreRoot;
  const root = await archiveDirectory(directory);
  if(p.restoreRoot && p.restoreRoot!==sha(root))throw failure('PHASE7_RESTORE_ROOT_CHANGED');
  restoreRoot=sha(root);
  if (chunks.length) {
    if (!p.archiveRoot || sha(root) === p.archiveRoot) throw failure('PHASE7_INDEPENDENT_RESTORE_DIRECTORY_REQUIRED');
    const chunk = chunks[0], data = await readArtifact(root,chunk.fileName);
    const descriptor=JSON.parse((await readArtifact(root,chunk.fileName.replace('.jsonl','.manifest.json'),65536)).toString('utf8'));
    if(JSON.stringify(descriptor)!==JSON.stringify(chunkManifest(p,chunk)))throw failure('PHASE7_ARCHIVE_MANIFEST_MISMATCH');
    const bodies = data.toString('utf8').split('\n'); if (bodies.pop() !== '') throw failure('PHASE7_ARCHIVE_FORMAT_INVALID');
    if (data.length !== chunk.bytes || sha(data) !== chunk.digest || bodies.length !== chunk.rows
        || chunk.sequence !== next+1 || chunk.previousDigest !== chain) throw failure('PHASE7_ARCHIVE_RESTORE_MISMATCH');
    // Restore-decode every row; validate identity/scope, not just equal byte counts.
    const t = tableContract(p.tableName);
    for (const body of bodies) { const row=JSON.parse(body); if (row.id === undefined || (t.scopeColumn && row[t.scopeColumn] !== p.agencyId) || t.secretColumns.some(k=>k in row)) throw failure('PHASE7_ARCHIVE_SCOPE_MISMATCH'); }
    if (String(JSON.parse(bodies.at(-1)).id) !== chunk.endCursor) throw failure('PHASE7_ARCHIVE_CURSOR_MISMATCH');
    chain = sha(JSON.stringify([chain,chunk.digest,chunk.endCursor,chunk.rows,chunk.bytes])); next++;
  }
  const done = next === p.sequence;
  if (done && chain !== p.digest) throw failure('PHASE7_ARCHIVE_CHAIN_MISMATCH');
  await runDbTransaction(db, async tx => {
    const n = await tx.phase7RetirementPartition.updateMany({where:{id,sourceEpoch:p.sourceEpoch,state:'EXPORTED',verifiedSequence:p.verifiedSequence},
      data:{restoreRoot,verifiedSequence:next,verifiedDigest:chain,...(done?{state:'VERIFIED',archiveVerifiedAt:new Date()}:{} )}});
    if (!n.count) throw failure('PHASE7_ARCHIVE_VERIFY_STALE');
  });
  return { partitionId:id,verified:done,verifiedSequence:next };
}
async function resumePartition({ db, id }) {
  return runDbTransaction(db,tx=>tx.phase7RetirementPartition.updateMany({where:{id,state:'BLOCKED'},data:{state:'PENDING',lastError:null,nextAt:new Date()}}));
}
module.exports = { enumerateCohort,claimPartition,processPartition,verifyPartitionPage,resumePartition,
  archiveDirectory,readArtifact,durableArtifact,agencyKey,partitionId };
