"use strict";

const crypto = require("node:crypto");

function clean(value, max = 500) { const text=String(value==null?"":value).trim(); return text ? text.slice(0,max) : ""; }
function ids(values) { return Array.from(new Set((Array.isArray(values)?values:[]).map((v)=>clean(v,100)).filter(Boolean))); }
function num(value) { const n=Number(value); return Number.isFinite(n) && n>=0 ? Math.min(2147483647,Math.round(n)) : 0; }
function bool(value) { return value === true; }
function date(value) { const d=value instanceof Date?new Date(value):new Date(String(value||"")); return Number.isFinite(d.getTime())?d:new Date(); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object" && !(value instanceof Date)) return Object.fromEntries(Object.keys(value).sort().map((k)=>[k,canonical(value[k])]));
  if (value instanceof Date) return value.toISOString();
  return value;
}
function fingerprint(data) { return crypto.createHash("sha256").update(JSON.stringify(canonical(data))).digest("hex"); }

function normalizeReceiptData(input={}) {
  const data={
    agencyId:clean(input.agencyId,180), creatorId:clean(input.creatorId,180), customOrderId:clean(input.customOrderId,180), submissionId:clean(input.submissionId,180),
    writeId:clean(input.writeId,180)||null, writeCommitRevision:Number.isInteger(Number(input.writeCommitRevision))&&Number(input.writeCommitRevision)>0?Number(input.writeCommitRevision):null,
    idempotencyKey:clean(input.idempotencyKey,500)||null, dialogId:clean(input.dialogId,180), messageId:clean(input.messageId,220),
    actorMemberId:clean(input.actorMemberId,180)||null, actorUserId:clean(input.actorUserId,180)||null,
    sentMediaIds:ids(input.sentMediaIds), approvedMediaIds:ids(input.approvedMediaIds), matchedMediaIds:ids(input.matchedMediaIds),
    newlyDeliveredMediaIds:ids(input.newlyDeliveredMediaIds), deliveredMediaIdsAfter:ids(input.deliveredMediaIdsAfter), duplicateMediaIds:ids(input.duplicateMediaIds),
    expectedPriceCents:num(input.expectedPriceCents), actualPriceCents:num(input.actualPriceCents), totalPriceCents:num(input.totalPriceCents), paidAmountCents:num(input.paidAmountCents),
    remainingAmountCents:num(input.remainingAmountCents), previousDeliveryOfferedCents:num(input.previousDeliveryOfferedCents), deliveryOfferedCents:num(input.deliveryOfferedCents),
    paymentStatus:clean(input.paymentStatus,80)||null, paymentMismatch:clean(input.paymentMismatch,80)||null, overrideReason:clean(input.overrideReason,500)||null,
    duplicateOverrideConfirmed:bool(input.duplicateOverrideConfirmed), priceMismatchOverrideConfirmed:bool(input.priceMismatchOverrideConfirmed), complete:bool(input.complete),
    occurredAt:date(input.occurredAt),
  };
  for(const key of ["agencyId","creatorId","customOrderId","submissionId","dialogId","messageId"]) if(!data[key]) throw Object.assign(new Error(`Custom delivery receipt requires ${key}`),{code:"CUSTOM_DELIVERY_RECEIPT_INVALID",status:500});
  data.receiptFingerprint=fingerprint({
    agencyId:data.agencyId, creatorId:data.creatorId, customOrderId:data.customOrderId, submissionId:data.submissionId,
    writeId:data.writeId, writeCommitRevision:data.writeCommitRevision, idempotencyKey:data.idempotencyKey,
    dialogId:data.dialogId, messageId:data.messageId,
    sentMediaIds:data.sentMediaIds, approvedMediaIds:data.approvedMediaIds, matchedMediaIds:data.matchedMediaIds,
    newlyDeliveredMediaIds:data.newlyDeliveredMediaIds, deliveredMediaIdsAfter:data.deliveredMediaIdsAfter, duplicateMediaIds:data.duplicateMediaIds,
    expectedPriceCents:data.expectedPriceCents, actualPriceCents:data.actualPriceCents, totalPriceCents:data.totalPriceCents,
    paidAmountCents:data.paidAmountCents, remainingAmountCents:data.remainingAmountCents,
    previousDeliveryOfferedCents:data.previousDeliveryOfferedCents, deliveryOfferedCents:data.deliveryOfferedCents,
    paymentStatus:data.paymentStatus, paymentMismatch:data.paymentMismatch, overrideReason:data.overrideReason,
    duplicateOverrideConfirmed:data.duplicateOverrideConfirmed, priceMismatchOverrideConfirmed:data.priceMismatchOverrideConfirmed,
    complete:data.complete,
  });
  return data;
}

async function findExistingReceipt({db,data}) {
  if(!db?.customDeliveryReceipt?.findFirst) throw Object.assign(new Error("Custom delivery receipt storage is required"),{code:"CUSTOM_DELIVERY_RECEIPT_STORAGE_REQUIRED",status:500});
  const or=[{agencyId:data.agencyId,creatorId:data.creatorId,messageId:data.messageId}];
  if(data.writeId&&data.writeCommitRevision) or.push({writeId:data.writeId,writeCommitRevision:data.writeCommitRevision});
  return db.customDeliveryReceipt.findFirst({where:{OR:or}});
}
function assertSameReceipt(existing,data) {
  if(!existing) return null;
  if(String(existing.receiptFingerprint||"")!==String(data.receiptFingerprint||"")) {
    throw Object.assign(new Error("Provider message/write identity is already bound to different Custom delivery facts"),{code:"CUSTOM_DELIVERY_RECEIPT_CONFLICT",status:409});
  }
  return existing;
}
async function createCustomDeliveryReceipt({db,input}) {
  if(!db?.customDeliveryReceipt?.create) throw Object.assign(new Error("Custom delivery receipt storage is required"),{code:"CUSTOM_DELIVERY_RECEIPT_STORAGE_REQUIRED",status:500});
  const data=normalizeReceiptData(input);
  const existing=await findExistingReceipt({db,data});
  if(existing) return {receipt:assertSameReceipt(existing,data),idempotent:true,data};
  try {
    const receipt=await db.customDeliveryReceipt.create({data});
    return {receipt,idempotent:false,data};
  } catch (error) {
    if (String(error?.code || "") !== "P2002") throw error;
    const raced=await findExistingReceipt({db,data});
    if (!raced) throw error;
    return {receipt:assertSameReceipt(raced,data),idempotent:true,data};
  }
}

function receiptSignalRows(receipt) {
  if(!receipt) return [];
  const common={
    receiptId:String(receipt.id), customOrderId:String(receipt.customOrderId), submissionId:String(receipt.submissionId), creatorId:String(receipt.creatorId), dialogId:String(receipt.dialogId),
    actorMemberId:receipt.actorMemberId?String(receipt.actorMemberId):null, actorUserId:receipt.actorUserId?String(receipt.actorUserId):null,
    expectedPriceCents:num(receipt.expectedPriceCents), actualPriceCents:num(receipt.actualPriceCents), totalPriceCents:num(receipt.totalPriceCents), paidAmountCents:num(receipt.paidAmountCents),
    remainingAmountCents:num(receipt.remainingAmountCents), messageId:String(receipt.messageId), createdAt:date(receipt.occurredAt),
  };
  const out=[]; const dup=ids(receipt.duplicateMediaIds);
  if(dup.length) out.push({...common,id:`${receipt.id}:duplicate`,type:"CUSTOM_DELIVERY_DUPLICATE_ATTEMPT",duplicateMediaCount:dup.length,reason:null,shortfallCents:0});
  if(common.actualPriceCents>common.expectedPriceCents) out.push({...common,id:`${receipt.id}:override`,type:"CUSTOM_PAYMENT_OVERRIDE",duplicateMediaCount:dup.length,reason:clean(receipt.overrideReason,500)||null,shortfallCents:0});
  else if(common.actualPriceCents<common.expectedPriceCents) out.push({...common,id:`${receipt.id}:undercharge`,type:"CUSTOM_PAYMENT_UNDERCHARGE",duplicateMediaCount:dup.length,reason:null,shortfallCents:common.expectedPriceCents-common.actualPriceCents});
  return out;
}

module.exports={ createCustomDeliveryReceipt, normalizeReceiptData, receiptSignalRows, assertSameReceipt };
