"use strict";

function ids(rows) {
  return Array.from(new Set((Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.id || "").trim())
    .filter(Boolean)));
}

function scopedOr(creatorId, { orderIds = [], submissionIds = [], intentIds = [], inboundIds = [], deliveryIds = [] } = {}) {
  const or = [{ creatorId: String(creatorId) }];
  if (orderIds.length) or.push({ customOrderId: { in: orderIds } });
  if (submissionIds.length) or.push({ customSubmissionId: { in: submissionIds } });
  if (intentIds.length) or.push({ intentId: { in: intentIds } });
  if (deliveryIds.length) or.push({ objectType: "AutomationDelivery", objectId: { in: deliveryIds } });
  if (inboundIds.length) or.push({ objectType: "TelegramInboundEvent", objectId: { in: inboundIds } });
  return or;
}

async function collectCreatorPhase2DestructiveScope({ db, agencyId, creatorId }) {
  const agency = String(agencyId || "").trim();
  const creator = String(creatorId || "").trim();
  if (!db || !agency || !creator) {
    const error = new Error("Creator destructive scope requires db, agencyId and creatorId");
    error.code = "PHASE2_DESTRUCTIVE_SCOPE_REQUIRED";
    throw error;
  }

  const orderRows = await db.customOrder.findMany({
    where: { agencyId: agency, creatorId: creator },
    select: { id: true },
  });
  const orderIds = ids(orderRows);

  const submissionRows = await db.customContentSubmission.findMany({
    where: { agencyId: agency, creatorId: creator },
    select: { id: true },
  });
  const submissionIds = ids(submissionRows);

  const intentOr = [{ creatorId: creator }];
  if (orderIds.length) intentOr.push({ customOrderId: { in: orderIds } });
  if (submissionIds.length) intentOr.push({ customSubmissionId: { in: submissionIds } });
  const intentRows = await db.telegramDeliveryIntent.findMany({
    where: { agencyId: agency, OR: intentOr },
    select: { id: true },
  });
  const intentIds = ids(intentRows);

  const inboundOr = [{ creatorId: creator }];
  if (orderIds.length) inboundOr.push({ customOrderId: { in: orderIds } });
  if (submissionIds.length) inboundOr.push({ submissionId: { in: submissionIds } });
  const inboundRows = await db.telegramInboundEvent.findMany({
    where: { agencyId: agency, OR: inboundOr },
    select: { id: true },
  });
  const inboundIds = ids(inboundRows);

  const deliveryRows = await db.automationDelivery.findMany({
    where: {
      agencyId: agency,
      creatorId: creator,
      actionType: { in: ["CUSTOM_RELAY_SEND", "CUSTOM_MANUAL_SEND"] },
    },
    select: { id: true },
  });
  const deliveryIds = ids(deliveryRows);

  return { agencyId: agency, creatorId: creator, orderIds, submissionIds, intentIds, inboundIds, deliveryIds };
}

async function purgeAgencyPhase2ProviderLedgersForHardDelete({ db, agencyId }) {
  const agency = String(agencyId || "").trim();
  if (!db || !agency) {
    const error = new Error("Agency provider-ledger purge requires db and agencyId");
    error.code = "PHASE2_DESTRUCTIVE_SCOPE_REQUIRED";
    throw error;
  }

  // These tables intentionally have no Agency FK. They are deleted only inside
  // explicit hard-delete maintenance after Custom/MASS unknown-effect guards.
  // The caller must keep this in the same DB transaction as Agency.delete so a
  // later FK/cascade failure restores every provider ledger automatically.
  const providerDebt = await db.providerOperationalDebt.deleteMany({ where: { agencyId: agency } });
  const telegramDelivery = await db.telegramDeliveryIntent.deleteMany({ where: { agencyId: agency } });
  const telegramInbound = await db.telegramInboundEvent.deleteMany({ where: { agencyId: agency } });
  return {
    providerOperationalDebt: Number(providerDebt?.count || 0),
    telegramDeliveryIntent: Number(telegramDelivery?.count || 0),
    telegramInboundEvent: Number(telegramInbound?.count || 0),
  };
}

async function purgeCreatorPhase2ResidualsForHardDelete({ db, scope }) {
  const agencyId = String(scope?.agencyId || "").trim();
  const creatorId = String(scope?.creatorId || "").trim();
  if (!db || !agencyId || !creatorId) {
    const error = new Error("Creator provider-ledger purge requires a captured destructive scope");
    error.code = "PHASE2_DESTRUCTIVE_SCOPE_REQUIRED";
    throw error;
  }

  const orderIds = Array.from(new Set(scope.orderIds || []));
  const submissionIds = Array.from(new Set(scope.submissionIds || []));
  const intentIds = Array.from(new Set(scope.intentIds || []));
  const inboundIds = Array.from(new Set(scope.inboundIds || []));
  const deliveryIds = Array.from(new Set(scope.deliveryIds || []));

  const telegramIntentOr = [{ creatorId }];
  if (orderIds.length) telegramIntentOr.push({ customOrderId: { in: orderIds } });
  if (submissionIds.length) telegramIntentOr.push({ customSubmissionId: { in: submissionIds } });
  const telegramDelivery = await db.telegramDeliveryIntent.deleteMany({
    where: { agencyId, OR: telegramIntentOr },
  });

  const inboundOr = [{ creatorId }];
  if (orderIds.length) inboundOr.push({ customOrderId: { in: orderIds } });
  if (submissionIds.length) inboundOr.push({ submissionId: { in: submissionIds } });
  const telegramInbound = await db.telegramInboundEvent.deleteMany({
    where: { agencyId, OR: inboundOr },
  });

  const debtOr = scopedOr(creatorId, { orderIds, submissionIds, intentIds, inboundIds, deliveryIds });
  const providerDebt = await db.providerOperationalDebt.deleteMany({
    where: { agencyId, OR: debtOr },
  });

  // CreatorAccount has no FK edge to DomainWorkItem/Phase2DependencyState. More
  // importantly, TelegramDeliveryIntent/CustomContentSubmission DELETE triggers
  // may publish order work while a hard Creator cascade is executing. Therefore
  // this cleanup is intentionally AFTER CreatorAccount.delete and after provider
  // ledger deletion, and removes both pre-existing and trigger-created orphan work.
  const workOr = [
    { creatorId },
    { objectType: "CreatorAccount", objectId: creatorId },
    { dependencyKind: "CREATOR_BINDING", dependencyKey: creatorId },
  ];
  if (orderIds.length) {
    workOr.push({ objectType: "CustomOrder", objectId: { in: orderIds } });
    workOr.push({ dependencyKind: "REMINDER_OUTCOME", dependencyKey: { in: orderIds } });
  }
  if (submissionIds.length) workOr.push({ objectType: "CustomContentSubmission", objectId: { in: submissionIds } });
  if (intentIds.length) {
    workOr.push({ objectType: "TelegramDeliveryIntent", objectId: { in: intentIds } });
    workOr.push({ objectType: "TelegramDeliveryReceipt", objectId: { in: intentIds } });
  }
  if (inboundIds.length) workOr.push({ objectType: "TelegramInboundEvent", objectId: { in: inboundIds } });
  if (deliveryIds.length) workOr.push({ objectType: "AutomationDelivery", objectId: { in: deliveryIds } });

  const domainWork = await db.domainWorkItem.deleteMany({ where: { agencyId, OR: workOr } });

  const dependencyOr = [{ dependencyKind: "CREATOR_BINDING", dependencyKey: creatorId }];
  if (orderIds.length) dependencyOr.push({ dependencyKind: "REMINDER_OUTCOME", dependencyKey: { in: orderIds } });
  const dependencyState = await db.phase2DependencyState.deleteMany({ where: { agencyId, OR: dependencyOr } });

  return {
    telegramDeliveryIntent: Number(telegramDelivery?.count || 0),
    telegramInboundEvent: Number(telegramInbound?.count || 0),
    providerOperationalDebt: Number(providerDebt?.count || 0),
    domainWorkItem: Number(domainWork?.count || 0),
    phase2DependencyState: Number(dependencyState?.count || 0),
  };
}

module.exports = {
  collectCreatorPhase2DestructiveScope,
  purgeAgencyPhase2ProviderLedgersForHardDelete,
  purgeCreatorPhase2ResidualsForHardDelete,
};
