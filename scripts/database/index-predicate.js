"use strict";
function normalizePredicate(value){
  const literals=[];
  const masked=String(value||'').replace(/'(?:[^']|'')*'/g,s=>{literals.push(s);return `__L${literals.length-1}__`;});
  return masked.replace(/::text\[\]|::text|::jsonb/g,'').replace(/=\s*ANY\s*\(ARRAY\[(.*?)\]\)/gi,'IN($1)').replace(/[\s()"]/g,'').replace(/__L(\d+)__/g,(_m,n)=>literals[Number(n)]);
}
module.exports = { normalizePredicate };
