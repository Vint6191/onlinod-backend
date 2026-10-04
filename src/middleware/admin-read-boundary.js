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
 if(req.method==="GET"||req.method==="HEAD"){
  res.setHeader("Cache-Control","no-store");
  const json=res.json;
  // Admission middleware authenticates before the query. Revalidate its exact
  // actor/session/epoch after the DTO is ready; no user data is sent on failure.
  const actor={adminId:req.admin?.id,sessionId:req.adminSession?.id,accessEpoch:req.adminSession?.issuedAccessEpoch};
  res.json=async function(body){
   const dto=redactAdminRead(body);
   try{
    await require("../services/admin-session-authority-service").authorizeAdminReadResult({db:require("../prisma"),actor});
   }catch(error){
    if(this.headersSent||this.writableEnded||this.destroyed)return this;
    const status=[401,403].includes(error.status)?error.status:503;
    this.status(status);
    return json.call(this,{ok:false,code:status===503?"ADMIN_READ_AUTHORITY_UNAVAILABLE":error.code,error:status===503?"Could not verify admin access; retry the read":error.message});
   }
   if(this.headersSent||this.writableEnded||this.destroyed)return this;
   return json.call(this,dto);
  };
 }
 next();
}
module.exports={redactAdminRead,adminReadBoundary};
