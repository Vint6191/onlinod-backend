"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
test('Phase7 retired analytics-ledger-contracts implementation cannot be imported',()=>{
 assert.equal(fs.existsSync(path.join(__dirname,'analytics-ledger-contracts.js')),false);
 const source=fs.readFileSync(path.join(__dirname,'../server.js'),'utf8');
 assert.match(source,/createLegacyGoneRouter/);
 assert.doesNotMatch(source,/require\(["'].*analytics\-ledger\-contracts/);
});
