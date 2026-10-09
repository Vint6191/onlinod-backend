"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {redactAdminRead}=require('../middleware/admin-read-boundary');
test('admin reads preserve safe business data and remove nested credentials',()=>{
 const row=redactAdminRead({id:'fact',createdAt:new Date(0),nested:{authorization:'credential',accessToken:'token',safe:'history'}});
 assert.equal(row.id,'fact');assert.equal(row.nested.safe,'history');assert.equal(row.nested.authorization,undefined);assert.equal(row.nested.accessToken,undefined);
});
