#!/usr/bin/env node
"use strict";
const fs = require('node:fs');
const { getDatabases, ready } = require('../../src/services/conversation-storage/databases');
const { inventoryInvalidBudgets, repairInvalidBudget } = require('../../src/services/conversation-storage/crm-budget-repair');
async function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--agency-id','--after','--limit','--apply-reviewed'].includes(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('Usage: --agency-id ID [--after CURSOR] [--limit 100] OR --apply-reviewed review.json');
    if (options[key]) throw new Error('Duplicate argument');
    options[key] = args[++i];
  }
  if (options['--apply-reviewed'] && Object.keys(options).length !== 1) throw new Error('Do not combine review application and inventory arguments');
  if (!options['--apply-reviewed'] && !options['--agency-id']) throw new Error('--agency-id is required for read-only inventory');
  const databases = getDatabases();
  try {
    await ready(databases.crm, 'crm');
    if (!options['--apply-reviewed']) {
      console.log(JSON.stringify(await inventoryInvalidBudgets({ db: databases.crm, agencyId: options['--agency-id'], after: options['--after'] || null, limit: Number(options['--limit'] || 100) }), null, 2));
    } else {
      const review = JSON.parse(fs.readFileSync(options['--apply-reviewed'], 'utf8'));
      if (review.policyVersion !== 1 || review.reviewed !== true || !Array.isArray(review.repairs) || review.repairs.length > 100) throw new Error('Explicit reviewed v1 repair file (maximum 100 entries) required');
      const results = [];
      for (const item of review.repairs) {
        try { results.push({ commandId: item.commandId, status: 'applied-or-replayed', result: await repairInvalidBudget({ ...item, db: databases.crm }) }); }
        catch (error) { results.push({ commandId: item.commandId, status: 'needs-review', code: error.code || 'REPAIR_FAILED', message: error.message }); }
      }
      console.log(JSON.stringify({ policyVersion: 1, mode: 'reviewed-apply', results }, null, 2));
      if (results.some(row => row.status !== 'applied-or-replayed')) process.exitCode = 1;
    }
  } finally { await Promise.allSettled(Object.values(databases).map(db => db.$disconnect())); }
}
if (require.main === module) main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
module.exports = { main };
