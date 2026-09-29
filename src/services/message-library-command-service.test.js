"use strict";
const test = require('node:test'), assert = require('node:assert/strict');
const { parseCommand, ACTIONS } = require('./message-library-command-service');
const base = () => ({ commandId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA', action: 'save', targetId: 'script', payload: { creatorId: 'creator', id: 'script' } });
test('canonical command identity is stable across object key order', () => {
 const a=base(),b={...a,payload:{id:'script',creatorId:'creator'}};
 assert.equal(parseCommand(a).commandId,a.commandId.toLowerCase());assert.equal(parseCommand(a).fingerprint,parseCommand(b).fingerprint);
});
for(const action of ACTIONS)test(`${action} validates its typed payload`,()=>{
 const input={...base(),action,payload:{creatorId:'creator',...(action.startsWith('block.')?{messageId:'message'}:{})}};assert.equal(parseCommand(input).action,action);
 assert.throws(()=>parseCommand({...input,targetId:''}));assert.throws(()=>parseCommand({...input,commandId:'invalid'}));
});
test('unknown lifecycle fields and mismatched save identity are refused',()=>{
 assert.throws(()=>parseCommand({...base(),action:'trash',payload:{creatorId:'creator',title:'unexpected'}}));
 assert.throws(()=>parseCommand({...base(),payload:{creatorId:'creator',id:'other'}}),{code:'MESSAGE_LIBRARY_COMMAND_TARGET_MISMATCH'});
});
test('copy title and revision must have their declared types',()=>{
 assert.throws(()=>parseCommand({...base(),action:'duplicate',payload:{creatorId:'creator',title:{}}}));
 assert.throws(()=>parseCommand({...base(),payload:{creatorId:'creator',expectedUpdatedAt:'bad date'}}));
});
test('payload budget rejects oversized content before entering any DB root',()=>{
 assert.throws(()=>parseCommand({...base(),payload:{creatorId:'creator',text:'x'.repeat(2*1024*1024)}}),{code:'MESSAGE_LIBRARY_COMMAND_TOO_LARGE'});
});

test('rejected business payload can still be cancelled with the exact same intent fingerprint',()=>{
 const invalid={...base(),action:'duplicate',targetId:'x'.repeat(121),payload:{creatorId:'creator',title:{invalid:true}}};assert.throws(()=>parseCommand(invalid));assert.equal(parseCommand(invalid,{cancel:true}).targetId,invalid.targetId);
 const normal=base();assert.equal(parseCommand(normal).fingerprint,parseCommand(normal,{cancel:true}).fingerprint);
 assert.throws(()=>parseCommand({...invalid,commandId:'bad'},{cancel:true}));
});
