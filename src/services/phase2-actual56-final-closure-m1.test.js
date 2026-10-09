'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const writers=require('./database-write-contract-service');
function transaction(state='ACTIVE'){
 const calls=[];return{calls,async $executeRawUnsafe(){},async $queryRawUnsafe(sql,...args){calls.push({sql,args});return sql.includes('DomainWorkClaimTopologyState')?[{generation:writers.DOMAIN_WORK_CLAIM_TOPOLOGY_ID,activationState:state}]:[];}};
}
test('current Creator writes carry a transaction-local contract token',async()=>{
 const tx=transaction();await writers.authorizeCreatorAccountWrite(tx);assert.equal(tx.calls.length,1);assert.deepEqual(tx.calls[0].args,['onlinod.phase2_creator_writer_generation',writers.CREATOR_ACCOUNT_WRITER_GENERATION]);assert.match(tx.calls[0].sql,/set_config\(\$1,\$2,true\)/);
});
test('current DomainWork claims lock active topology before admitting the executor',async()=>{
 const tx=transaction();await writers.authorizeDomainWorkExecutor(tx);assert.equal(tx.calls.length,2);assert.match(tx.calls[0].sql,/FOR SHARE/);assert.deepEqual(tx.calls[1].args,['onlinod.phase2_domain_executor_generation',writers.DOMAIN_WORK_EXECUTOR_GENERATION]);
});
test('missing or rebuilding topology rejects claims before writer admission',async()=>{
 for(const state of ['BUILDING','MISSING','']){const tx=transaction(state);await assert.rejects(writers.authorizeDomainWorkExecutor(tx),{code:'DOMAIN_WORK_CLAIM_TOPOLOGY_NOT_ACTIVE'});assert.equal(tx.calls.length,1);}
});
test('root Prisma cannot discard a token in autocommit and falsely admit a later write',async()=>{
 const db={...transaction(),async $transaction(){},async $disconnect(){}};
 for(const authorize of [writers.authorizeCreatorAccountWrite,writers.authorizeDomainWorkExecutor])await assert.rejects(authorize(db),{code:'DB_WRITER_TRANSACTION_REQUIRED'});
 await assert.rejects(writers.assertTeamControlPlaneWriteAdmission(db),{code:'TEAM_CONTROL_PLANE_TRANSACTION_REQUIRED'});assert.equal(db.calls.length,0);
});
test('Team writes use one current transaction token without global release activation',async()=>{
 const tx=transaction();assert.equal((await writers.assertTeamControlPlaneWriteAdmission(tx)).admitted,true);assert.equal(tx.calls.length,1);assert.deepEqual(tx.calls[0].args,[writers.TEAM_CONTROL_PLANE_DB_SETTING,writers.TEAM_CONTROL_PLANE_GENERATION]);
});
