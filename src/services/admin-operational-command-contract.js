"use strict";
const {z}=require("zod");
const id=z.string().trim().min(1).max(180),reason=z.string().trim().min(1).max(500),revision=z.string().datetime();
const scope={agencyId:id,reason},epoch=z.number().int().positive();
const schemas={
 "agency.update":z.object({reason,expectedUpdatedAt:revision,name:z.string().trim().min(1).max(120)}).strict(),
 "agency.retire":z.object({reason,expectedUpdatedAt:revision,hard:z.boolean().default(false)}).strict(),
 "agency.restore":z.object({reason,expectedUpdatedAt:revision}).strict(),
 "member.role.set":z.object({...scope,expectedAccessEpoch:epoch,role:z.enum(["OWNER","ADMIN","MANAGER","OPERATOR"])}).strict(),
 "member.permissions.set":z.object({...scope,expectedAccessEpoch:epoch,permissions:z.record(z.boolean()).refine(v=>Object.keys(v).length<=200,"Too many permissions")}).strict(),
 "member.remove":z.object({...scope,expectedAccessEpoch:epoch}).strict(),
 "user.update":z.object({reason,expectedUpdatedAt:revision,name:z.string().trim().min(1).max(120).optional(),disabled:z.boolean().optional(),disabledReason:z.string().max(500).nullable().optional()}).strict().refine(v=>v.name!==undefined||v.disabled!==undefined,"No changes supplied"),
 "user.logout":z.object({reason}).strict(),
 "user.password.reset":z.object({reason,expectedUpdatedAt:revision,passwordFingerprint:z.string().length(64)}).strict(),
 "creator.retire":z.object({...scope,expectedUpdatedAt:revision,hard:z.boolean().default(false)}).strict(),
 "device.kick":z.object({...scope,userId:id}).strict(),
 "maintenance.subscriber.requeue":z.object({...scope,creatorId:id}).strict(),
};
const OPERATIONAL_ACTIONS=Object.freeze(Object.fromEntries(Object.entries(schemas).map(([action,schema])=>[action,{roles:["SUPER_ADMIN"],schema,isolationLevel:"Serializable"}])));
module.exports={OPERATIONAL_ACTIONS};
