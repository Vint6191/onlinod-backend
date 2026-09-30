"use strict";
const crypto = require('node:crypto');
const manifest = require('./phase7-legacy-storage-manifest.json');
const { runDbTransaction, lockDbAdvisoryXact } = require('./db-transaction-service');
const GENERATION = manifest.generation;
const TABLES = new Map(manifest.tables.map(t => [t.table, Object.freeze(t)]));
const DESTRUCTIVE = manifest.tables.filter(t => t.disposition === 'COMPAT_DRAIN_DROP');
const COHORTS = [...new Set(DESTRUCTIVE.map(t => t.cohort))];
const q = value => '"' + String(value).replaceAll('"', '""') + '"';
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
function failure(code, details = {}) { return Object.assign(new Error(code), { code, status: 409, ...details }); }
function tableContract(name) { const t = TABLES.get(name); if (!t) throw failure('PHASE7_TABLE_NOT_ALLOWLISTED'); return t; }
function transactionRequired(db) {
  if (!db?.$queryRawUnsafe || typeof db.$transaction === 'function') throw failure('PHASE7_TRANSACTION_REQUIRED');
}
async function authorizeSfsGeneration(db) {
  transactionRequired(db);
  await db.$queryRawUnsafe("SELECT set_config('onlinod.phase7_sfs_generation',$1,true)", GENERATION);
}
async function authorizeLegacyLifecycle(db, { agencyId, creatorId = null }) {
  transactionRequired(db);
  if (!agencyId) throw failure('PHASE7_LIFECYCLE_SCOPE_REQUIRED');
  await db.$queryRawUnsafe(`SELECT set_config('onlinod.phase7_lifecycle_generation',$1,true),
    set_config('onlinod.phase7_lifecycle_agency',$2,true),set_config('onlinod.phase7_lifecycle_creator',$3,true)`,
    GENERATION, String(agencyId), String(creatorId || ''));
}
async function storageState(db) {
  const rows = await db.$queryRawUnsafe('SELECT "id","state","planHash","databaseEpoch","enumerationComplete","revision" FROM "Phase7RetirementCohort" ORDER BY "id"');
  const expected = [...new Set(manifest.tables.map(t => t.cohort))];
  if (rows.length !== expected.length || rows.some(r => !expected.includes(r.id) || r.planHash !== manifest.planHash)) throw failure('PHASE7_STORAGE_MANIFEST_MISMATCH');
  const destructive = rows.filter(r => COHORTS.includes(r.id));
  if (destructive.some(r=>r.state==='PURGED') && !destructive.every(r=>r.state==='PURGED')) throw failure('PHASE7_PARTIAL_PURGE_STATE');
  await verifyStorageFence(db,new Map(rows.map(r=>[r.id,r.state])));
  return { generation: GENERATION, planHash: manifest.planHash, ready: true,
    phase: destructive.every(r => r.state === 'PURGED') ? 'PURGED' : 'BRIDGE',
    targetReady: destructive.every(r => r.state === 'PURGED'), cohorts: rows.map(r => ({ ...r, revision: String(r.revision) })) };
}
async function verifyStorageFence(db,states) {
  const expected=[];
  for(const t of manifest.tables) if(states.get(t.cohort)!=='PURGED') {
    expected.push({table:t.table,name:'phase7_storage_fence',fn:'phase7_legacy_storage_fence',type:31,args:[t.cohort,t.scopeColumn||'',t.disposition]});
    expected.push({table:t.table,name:'phase7_truncate_fence',fn:'phase7_legacy_truncate_fence',type:34,args:[]});
  }
  for(const table of ['AutomationDelivery','JobInstance','DomainWorkItem'])expected.push({table,name:'phase7_execution_generation',fn:'phase7_new_execution_generation',type:23,args:[]});
  expected.push({table:'AutomationDelivery',name:'phase7_sfs_acquisition',fn:'phase7_sfs_acquisition_fence',type:23,args:[]});
  for(const kind of ['Proof','Chunk'])expected.push({table:'Phase7Retirement'+kind,name:'phase7_'+kind.toLowerCase()+'_no_truncate',fn:'phase7_immutable_receipt',type:34,args:[]});
  for(const kind of ['Proof','Chunk'])expected.push({table:'Phase7Retirement'+kind,name:'phase7_'+kind.toLowerCase()+'_immutable',fn:'phase7_immutable_receipt',type:27,args:[]});
  const relations=await db.$queryRawUnsafe(`SELECT c.relname,c.relkind::text AS kind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=ANY($1::text[])`,manifest.tables.map(t=>t.table));
  for(const t of manifest.tables){const actual=relations.find(r=>r.relname===t.table);if(states.get(t.cohort)==='PURGED'?!!actual:actual?.kind!=='r')throw failure('PHASE7_PHYSICAL_TABLE_STATE_MISMATCH',{table:t.table});}
  await require('./phase7-archive-shape-check').check(db,manifest.tables.filter(t=>states.get(t.cohort)!=='PURGED').map(t=>t.table));
  const actual=await db.$queryRawUnsafe(`SELECT c.relname AS table,t.tgname AS name,p.proname AS fn,t.tgtype::int AS type,t.tgenabled::text AS enabled,encode(t.tgargs,'hex') AS args
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_proc p ON p.oid=t.tgfoid
    WHERE n.nspname=current_schema() AND t.tgname LIKE 'phase7_%'`);
  if(actual.length!==expected.length)throw failure('PHASE7_STORAGE_TRIGGER_SET_MISMATCH');
  for(const e of expected){const a=actual.find(a=>a.table===e.table&&a.name===e.name),args=Buffer.from(e.args.length?e.args.join('\0')+'\0':'').toString('hex');
    if(!a||a.fn!==e.fn||a.type!==e.type||a.args!==args||!['O','A'].includes(a.enabled))throw failure('PHASE7_STORAGE_TRIGGER_INVALID',{table:e.table,trigger:e.name});
  }
  const functions=require('./phase7-db-contract.json').functions;
  const found=await db.$queryRawUnsafe(`SELECT p.proname AS name,encode(sha256(convert_to(p.prosrc,'UTF8')),'hex') AS hash FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proname=ANY($1::text[])`,functions.map(f=>f.name));
  if(found.length!==functions.length||functions.some(f=>!found.some(r=>r.name===f.name&&r.hash===f.bodyHash)))throw failure('PHASE7_STORAGE_FUNCTION_MISMATCH');
  return true;
}
async function legacyTablePresent(db, name) {
  const t = tableContract(name);
  const rows = await db.$queryRawUnsafe('SELECT "state","planHash" FROM "Phase7RetirementCohort" WHERE "id"=$1', t.cohort);
  if (rows[0]?.planHash !== manifest.planHash) throw failure('PHASE7_STORAGE_MANIFEST_MISMATCH');
  return rows[0].state !== 'PURGED';
}

// Native id comparisons retain the (agency,id) index. Metadata is read before
// payload materialization; SQL computes serialized, not compressed TOAST bytes.
async function readArchivePage({ db, table, agencyId, cursor = null, upperBound = null,
  limit = 100, maxBytes = manifest.pageBytes, profileId = null, rowId = null, creatorId = null, orphanScope = false }) {
  if (typeof db?.$transaction === 'function') return runDbTransaction(db, tx => readArchivePage({db:tx,table,agencyId,cursor,upperBound,limit,maxBytes,profileId,rowId,creatorId,orphanScope}), {timeout:10000,isolationLevel:"RepeatableRead"});
  const t = tableContract(table);
  if (t.scopeColumn && (agencyId === undefined || (agencyId === null && !orphanScope))) throw failure('PHASE7_ARCHIVE_SCOPE_REQUIRED');
  const indexes=require('../../scripts/database/phase7-legacy-storage-indexes');
  const indexKeys=t.scopeColumn?[t.scopeColumn,...(profileId!==null?['profileId']:creatorId!==null&&t.columns.includes('creatorId')?['creatorId']:[]),'id']:null;
  if(indexKeys){const d=indexes.definitions.find(d=>d.table===table&&JSON.stringify(d.keys)===JSON.stringify(indexKeys));if(!d||!(await indexes.state(db,d)).valid)throw failure('PHASE7_ARCHIVE_INDEX_REQUIRED',{table});}
  const count = Math.max(1, Math.min(manifest.pageRows, Math.floor(Number(limit) || 100)));
  const cap = Math.max(1024, Math.min(manifest.pageBytes, Math.floor(Number(maxBytes) || manifest.pageBytes)));
  const values = [], predicates = [];
  const bind = value => { values.push(value); return '$' + values.length; };
  if (t.scopeColumn) predicates.push(agencyId === null ? `x.${q(t.scopeColumn)} IS NULL` : `x.${q(t.scopeColumn)}=${bind(String(agencyId))}`);
  if (cursor !== null) predicates.push(`x."id">${bind(String(cursor))}::${t.idType}`);
  if (upperBound !== null) predicates.push(`x."id"<=${bind(String(upperBound))}::${t.idType}`);
  if (rowId !== null) predicates.push(`x."id"=${bind(String(rowId))}::${t.idType}`);
  if (creatorId !== null && t.columns.includes("creatorId") && profileId === null) predicates.push(`x."creatorId"=${bind(String(creatorId))}`);
  if (profileId !== null) {
    if (!t.columns.includes('profileId')) throw failure('PHASE7_PROFILE_SCOPE_INVALID');
    predicates.push(`x."profileId"=${bind(String(profileId))}`);
  }
  const redact = t.secretColumns.map(c => ` - '${c}'`).join('');
  const body = `(to_jsonb(x)${redact})::text`;
  const where = predicates.length ? predicates.join(' AND ') : 'TRUE';
  const meta = await db.$queryRawUnsafe(`WITH keys AS MATERIALIZED (
    SELECT x."id" FROM ${q(table)} x WHERE ${where} ORDER BY x."id" LIMIT ${count + 1}
  ) SELECT x."id"::text AS id,octet_length(${body})+1 AS bytes
    FROM keys k JOIN ${q(table)} x ON x."id"=k."id" ORDER BY x."id"`, ...values);
  const chosen = []; let bytes = 0;
  for (const row of meta.slice(0, count)) {
    if (Number(row.bytes) > cap && !chosen.length) throw failure('PHASE7_ARCHIVE_ROW_OVERSIZE', { rowId: row.id, bytes: Number(row.bytes), cap });
    if (bytes + Number(row.bytes) > cap) break;
    chosen.push(row.id); bytes += Number(row.bytes);
  }
  if (!chosen.length) return { items: [], bodies: [], sourceHashes: [], hasMore: false, nextCursor: cursor, bytes: 0 };
  // Scope is checked again on payload fetch. Frozen source cannot be replaced;
  // permitted lifecycle deletion is detected by the runner's source-epoch CAS.
  const rows = await db.$queryRawUnsafe(`SELECT x."id"::text AS id,${body} AS body,
    encode(sha256(convert_to(to_jsonb(x)::text,'UTF8')),'hex') AS "sourceHash"
    FROM ${q(table)} x WHERE ${where} AND x."id"=ANY(${bind(chosen)}::${t.idType}[])
    ORDER BY x."id"`, ...values);
  if (rows.length !== chosen.length) throw failure('PHASE7_ARCHIVE_SOURCE_CHANGED');
  const actualBytes = rows.reduce((n, row) => n + Buffer.byteLength(row.body, 'utf8') + 1, 0);
  if (actualBytes !== bytes || actualBytes > cap) throw failure('PHASE7_ARCHIVE_SOURCE_CHANGED');
  return { items: rows.map(r => JSON.parse(r.body)), bodies: rows.map(r => r.body), sourceHashes: rows.map(r => r.sourceHash),
    bytes, nextCursor: chosen.at(-1), hasMore: meta.length > chosen.length };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
async function putProof(db, input) {
  transactionRequired(db);
  const proof = { cohortId: input.cohortId, sourceTable: input.sourceTable, sourceId: input.sourceId, sourceHash: input.sourceHash,
    kind: input.kind, agencyId: input.agencyId || null, creatorId: input.creatorId || null, providerSubject: input.providerSubject || null,
    targetId: input.targetId || null, generation: input.generation ?? null, deliveryId: input.deliveryId || null,
    consumptionKey: input.consumptionKey || null, evidence: canonical(input.evidence || {}), classifierVersion: 1 };
  if (Buffer.byteLength(JSON.stringify(proof.evidence)) > 8192) throw failure('PHASE7_PROOF_OVERSIZE');
  const id = sha(JSON.stringify([proof.sourceTable, proof.sourceId, proof.sourceHash, proof.kind]));
  await db.$executeRawUnsafe(`INSERT INTO "Phase7RetirementProof"
   ("id","cohortId","sourceTable","sourceId","sourceHash","kind","agencyId","creatorId","providerSubject","targetId","generation","deliveryId","consumptionKey","evidence")
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb) ON CONFLICT DO NOTHING`,
   id,proof.cohortId,proof.sourceTable,proof.sourceId,proof.sourceHash,proof.kind,proof.agencyId,proof.creatorId,proof.providerSubject,
   proof.targetId,proof.generation,proof.deliveryId,proof.consumptionKey,JSON.stringify(proof.evidence));
  const found = await db.phase7RetirementProof.findUnique({ where: { id } });
  if (!found || Object.entries(proof).some(([k,v]) => JSON.stringify(canonical(found[k])) !== JSON.stringify(v))) throw failure('PHASE7_PROOF_IDENTITY_CONFLICT');
  return found;
}
function matchesSfsAttestation({proof,delivery,candidate,providerSubject}) {
  if (!proof || !delivery || !candidate || !providerSubject || proof.id!==delivery.legacyCleanupProofId
      || proof.kind!=='SFS_CLEANUP' || proof.deliveryId!==delivery.id
      || proof.agencyId!==delivery.agencyId || proof.creatorId!==delivery.creatorId
      || proof.targetId!==delivery.targetId || proof.generation!==delivery.generation
      || candidate.agencyId!==delivery.agencyId || candidate.creatorId!==delivery.creatorId
      || candidate.targetUserId!==delivery.targetId || delivery.fanId!==delivery.targetId
      || candidate.safetyUnfollowDeliveryId!==delivery.id || proof.evidence?.candidateId!==candidate.id
      || proof.providerSubject!==providerSubject) return false;
  const meta=object(candidate.metadata);
  return !(meta.followEffectOwnership==='OWNED' && meta.followEffectDeliveryId
    && meta.followEffectDeliveryId!==proof.evidence.followDeliveryId);
}
async function readSfsAttestation({db,delivery,candidate}) {
  if (!db?.phase7RetirementProof?.findMany || !delivery?.legacyCleanupProofId || !candidate) return null;
  const proofs=await db.phase7RetirementProof.findMany({where:{id:delivery.legacyCleanupProofId,deliveryId:delivery.id,kind:'SFS_CLEANUP'},take:2});
  if(proofs.length!==1)return null;
  const creator=await db.creatorAccount.findFirst({where:{id:delivery.creatorId,agencyId:delivery.agencyId},select:{remoteId:true}});
  return matchesSfsAttestation({proof:proofs[0],delivery,candidate,providerSubject:creator?.remoteId})?proofs[0]:null;
}
async function attestedCleanupCandidates(db,candidates) {
  const safe=new Set();
  if(!db?.automationDelivery?.findMany||!db?.phase7RetirementProof?.findMany||!db?.creatorAccount?.findMany)return safe;
  for(let offset=0;offset<candidates.length;offset+=100){
    const batch=candidates.slice(offset,offset+100),ids=batch.map(c=>c.safetyUnfollowDeliveryId).filter(Boolean);
    if(!ids.length)continue;
    const deliveries=await db.automationDelivery.findMany({where:{id:{in:ids}},select:{id:true,agencyId:true,creatorId:true,fanId:true,targetId:true,generation:true,legacyCleanupProofId:true}});
    const proofs=await db.phase7RetirementProof.findMany({where:{deliveryId:{in:ids},kind:'SFS_CLEANUP'},take:100});
    const creators=await db.creatorAccount.findMany({where:{id:{in:[...new Set(batch.map(c=>c.creatorId))]}},select:{id:true,agencyId:true,remoteId:true}});
    const dm=new Map(deliveries.map(d=>[d.id,d])),pm=new Map(proofs.map(p=>[p.deliveryId,p])),cm=new Map(creators.map(c=>[c.id,c]));
    for(const candidate of batch){const delivery=dm.get(candidate.safetyUnfollowDeliveryId),creator=cm.get(candidate.creatorId);
      if(creator?.agencyId===candidate.agencyId&&matchesSfsAttestation({proof:pm.get(delivery?.id),delivery,candidate,providerSubject:creator.remoteId}))safe.add(candidate.id);
    }
  }
  return safe;
}
async function hasHistoricalConsumption(db, { agencyId, creatorId, targetId }) {
  if (!db?.phase7RetirementProof?.findFirst) return false;
  return Boolean(await db.phase7RetirementProof.findFirst({ where: { kind: 'CONSUMED', agencyId, creatorId, targetId }, select: { id: true } }));
}

module.exports = { manifest, GENERATION, TABLES, DESTRUCTIVE, COHORTS, q, sha, object, failure, tableContract,
  transactionRequired, authorizeSfsGeneration, authorizeLegacyLifecycle, storageState, verifyStorageFence, legacyTablePresent,
  readArchivePage, putProof, readSfsAttestation, matchesSfsAttestation, attestedCleanupCandidates, hasHistoricalConsumption, runDbTransaction, lockDbAdvisoryXact };
