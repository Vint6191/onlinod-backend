"use strict";
// Applies to read DTOs only. Issuance endpoints have their own explicit secret
// contracts. Keep dates/metrics intact; remove credential material recursively.
const SECRET_KEY=/(password|tokenhash|refreshtoken|accesstoken|authorization|cookie|secret|private.?key|ciphertext|encrypted|keywrap|wrappedkey|recoverycode|recoverykey|csrf)/i;
function redactAdminRead(value){
 if(value==null||value instanceof Date)return value;
 if(typeof value==="bigint")return String(value);
 if(Array.isArray(value))return value.map(redactAdminRead);
 if(typeof value!=="object")return value;
 return Object.fromEntries(Object.entries(value).filter(([key])=>!SECRET_KEY.test(key)).map(([key,item])=>[key,redactAdminRead(item)]));
}
function adminReadBoundary(req,res,next){
 if(req.method==="GET"){
  const json=res.json;
  res.json=function(body){return json.call(this,redactAdminRead(body));};
 }
 next();
}
module.exports={redactAdminRead,adminReadBoundary};
