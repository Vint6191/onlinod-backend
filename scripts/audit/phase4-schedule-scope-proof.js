'use strict';
const fs=require('node:fs'),path=require('node:path'),{createRequire}=require('node:module'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'../..');
const text=fs.readFileSync(path.join(root,'src/services/team-schedule-service.js'),'utf8');

const names=['clean','uniqueIds','creatorScopeWhere','creatorAllowed','intersectCreatorScopes'];
const fns=names.map(name=>{const start=text.indexOf('function '+name+'(');assert.ok(start>=0);const body=text.indexOf('{',start);let depth=1,i=body+1;for(;depth&&i<text.length;i++){if(text[i]==='{')depth++;if(text[i]==='}')depth--;}return text.slice(start,i);});
const api=new Function(fns.join('\n')+'\nreturn {creatorScopeWhere,creatorAllowed,intersectCreatorScopes};')();
const ids=Array.from({length:10005},(_,n)=>'paid-'+String(n).padStart(5,'0'));
const result={finding:'F4-R16-05',authorizedPaidCreators:ids.length,returnedCreators:api.creatorScopeWhere(ids).creatorId.in.length,lastCreatorIncluded:api.creatorAllowed(ids.at(-1),ids),dropped:ids.length-api.creatorScopeWhere(ids).creatorId.in.length};
assert.equal(result.returnedCreators,10005);assert.equal(result.lastCreatorIncluded,true);assert.deepEqual(api.intersectCreatorScopes(["a","b"],["b","c"]),["b"]);
console.log(JSON.stringify(result));
