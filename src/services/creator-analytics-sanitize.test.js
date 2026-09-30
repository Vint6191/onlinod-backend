"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {manifest,tableContract}=require('./phase7-legacy-storage-service');
const {redactAdminRead}=require('../middleware/admin-read-boundary');
test('retired impersonation export excludes the credential hash while preserving identity columns',()=>{
 const t=tableContract('ImpersonationToken');assert.deepEqual(t.secretColumns,['tokenHash']);assert(t.columns.includes('targetAgencyId'));assert.equal(t.disposition,'COMPAT_DRAIN_DROP');
});
test('archive admin reads preserve historical data while the existing secret boundary stays active',()=>{
 const row=redactAdminRead({id:'archive',createdAt:new Date(0),nested:{authorization:'credential',accessToken:'token',safe:'history'}});
 assert.equal(row.id,'archive');assert.equal(row.nested.safe,'history');assert.equal(row.nested.authorization,undefined);assert.equal(row.nested.accessToken,undefined);
 assert.equal(manifest.tables.filter(t=>t.disposition==='ARCHIVE_RETAIN').length,27);
});
