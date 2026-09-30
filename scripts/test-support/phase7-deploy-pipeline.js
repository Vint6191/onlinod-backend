"use strict";
const assert=require('node:assert/strict');
module.exports=function pipeline(pkg){
 assert.equal(pkg.scripts['prisma:migrate'],'node scripts/database/phase7-deploy.js');
 const {PRE,POST}=require('../database/phase7-deploy');
 return [...PRE.map(x=>x.join(' ')),'prisma migrate deploy',...POST.map(x=>x.join(' '))].join(' && ');
};
