"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  cascadeDeletePlanFromConstraints,
  externalCascadeForeignActionPlanFromConstraints,
  directRootForeignActionPlanFromConstraints,
} = require("./phase2-destructive-delete-authority-service");

function source(rel) {
  return fs.readFileSync(path.join(__dirname, rel), "utf8");
}

function edge(constraintName, parentTable, childTable, parentColumns, childColumns, deleteAction = "CASCADE") {
  return { constraintName, parentTable, childTable, parentColumns, childColumns, deleteAction };
}


function prismaRelationEdges() {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const edges = [];
  for (const match of schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)) {
    const childModel = match[1];
    for (const line of match[2].split("\n")) {
      if (!line.includes("@relation") || !line.includes("onDelete:")) continue;
      const relation = line.match(/^\s*\w+\s+([A-Za-z_]\w*)\??(?:\[\])?\s+@relation\(([\s\S]*)\)\s*$/);
      if (!relation) continue;
      const action = relation[2].match(/onDelete:\s*(\w+)/)?.[1] || null;
      if (action) edges.push({ parentModel: relation[1], childModel, deleteAction: action });
    }
  }
  return edges;
}

test("F55-06 cascade planner drains deepest descendants before direct Creator parents and supports composite FKs", () => {
  const plan = cascadeDeletePlanFromConstraints([
    edge("run_creator", "CreatorAccount", "SubscriberScanRun", ["id"], ["creatorId"]),
    edge("item_run", "SubscriberScanRun", "SubscriberScanItem", ["id"], ["runId"]),
    edge("page_run", "SubscriberScanRun", "SubscriberScanPage", ["id"], ["runId"]),
    edge("campaign_creator", "CreatorAccount", "CreatorCampaign", ["agencyId", "id"], ["agencyId", "creatorId"]),
    edge("fan_campaign", "CreatorCampaign", "CreatorCampaignFan", ["creatorId", "id"], ["creatorId", "campaignId"]),
  ], "CreatorAccount");

  const byName = new Map(plan.map((row, index) => [row.tableName, { ...row, index }]));
  assert.equal(byName.get("SubscriberScanItem").depth, 2);
  assert.equal(byName.get("SubscriberScanPage").depth, 2);
  assert.equal(byName.get("CreatorCampaignFan").depth, 2);
  assert.equal(byName.get("SubscriberScanRun").depth, 1);
  assert.equal(byName.get("CreatorCampaign").depth, 1);
  assert.ok(byName.get("SubscriberScanItem").index < byName.get("SubscriberScanRun").index);
  assert.ok(byName.get("CreatorCampaignFan").index < byName.get("CreatorCampaign").index);
  assert.deepEqual(byName.get("CreatorCampaignFan").paths[0][0].parentColumns, ["agencyId", "id"]);
});

test("F55-06 cascade planner fails closed on a reachable cascade cycle", () => {
  assert.throws(() => cascadeDeletePlanFromConstraints([
    edge("creator_a", "CreatorAccount", "A", ["id"], ["creatorId"]),
    edge("a_b", "A", "B", ["id"], ["aId"]),
    edge("b_a", "B", "A", ["id"], ["bId"]),
  ], "CreatorAccount"), (error) => error?.code === "PHASE2_DESTRUCTIVE_CASCADE_CYCLE_UNSUPPORTED");
});

test("F55-06 production destructive worker derives all FK actions and budgets physical rows", () => {
  const destructive = source("phase2-destructive-delete-authority-service.js");
  assert.match(destructive, /FROM pg_constraint con/);
  assert.match(destructive, /con\.confdeltype::text AS "deleteActionCode"/);
  assert.match(destructive, /SET_NULL/);
  assert.match(destructive, /RESTRICT/);
  assert.match(destructive, /NO_ACTION/);
  assert.match(destructive, /parentColumns/);
  assert.match(destructive, /childColumns/);
  assert.match(destructive, /ORDER BY x\.ctid LIMIT \$2/);
  assert.match(destructive, /rootTable: "CreatorAccount"/);
  assert.match(destructive, /destructiveRank/);
  assert.match(destructive, /externalCascadeForeignActionPlanFromConstraints/);
  assert.match(destructive, /indirectForeignMatchPredicate/);
  assert.match(destructive, /externalChanged/);
  assert.match(destructive, /cascade\.workUnits/);
  assert.match(destructive, /deleteRestrictedTables: \[\]/);
  assert.doesNotMatch(destructive, /250 direct parent rows/);
});

test("F55-06 destructive ordering uses non-CASCADE dependencies between root-owned tables", () => {
  const cascades = [
    edge("creator_dialog", "CreatorAccount", "DialogMessageLedger", ["id"], ["creatorId"]),
    edge("creator_purchase", "CreatorAccount", "VaultPurchaseLedger", ["id"], ["creatorId"]),
  ];
  const all = [
    ...cascades,
    edge("purchase_message", "DialogMessageLedger", "VaultPurchaseLedger", ["id"], ["messageId"], "SET_NULL"),
  ];
  const plan = cascadeDeletePlanFromConstraints(cascades, "CreatorAccount", all);
  const order = plan.map((row) => row.tableName);
  assert.ok(order.indexOf("VaultPurchaseLedger") < order.indexOf("DialogMessageLedger"));
});

test("F55-06 bounded cascade planner exposes non-CASCADE actions hanging off intermediate cascade parents", () => {
  const constraints = [
    edge("agency_order", "Agency", "BillingOrder", ["id"], ["agencyId"], "CASCADE"),
    edge("order_attempt", "BillingOrder", "BillingPaymentAttempt", ["id"], ["orderId"], "CASCADE"),
    edge("event_order", "BillingOrder", "BillingProviderEvent", ["id"], ["orderId"], "SET_NULL"),
    edge("event_attempt", "BillingPaymentAttempt", "BillingProviderEvent", ["id"], ["paymentAttemptId"], "SET_NULL"),
  ];
  const cascadePlan = cascadeDeletePlanFromConstraints(
    constraints.filter((row) => row.deleteAction === "CASCADE"),
    "Agency",
    constraints,
  );
  const external = externalCascadeForeignActionPlanFromConstraints(constraints, "Agency", cascadePlan);
  assert.deepEqual(external.map((row) => [row.parentTable, row.childTable, row.deleteAction]), [
    ["BillingPaymentAttempt", "BillingProviderEvent", "SET_NULL"],
    ["BillingOrder", "BillingProviderEvent", "SET_NULL"],
  ]);
});

test("F55-06 direct root actions preserve SET NULL history and expose unclassified RESTRICT policy", () => {
  const constraints = [
    edge("creator_event", "CreatorAccount", "TeamActivityEvent", ["id"], ["creatorId"], "SET_NULL"),
    edge("creator_shift_live", "CreatorAccount", "TeamShiftCreator", ["id"], ["creatorRefId"], "SET_NULL"),
    edge("creator_protected", "CreatorAccount", "CreatorProtectedHistory", ["id"], ["creatorId"], "RESTRICT"),
    edge("creator_owned", "CreatorAccount", "CreatorOwned", ["id"], ["creatorId"], "CASCADE"),
  ];
  const cascadePlan = cascadeDeletePlanFromConstraints(constraints.filter((row) => row.deleteAction === "CASCADE"), "CreatorAccount", constraints);
  const direct = directRootForeignActionPlanFromConstraints(constraints, "CreatorAccount", cascadePlan);
  assert.deepEqual(direct.map((row) => [row.childTable, row.deleteAction]), [
    ["CreatorProtectedHistory", "RESTRICT"],
    ["TeamActivityEvent", "SET_NULL"],
    ["TeamShiftCreator", "SET_NULL"],
  ]);
});


test("F55-06 Actual55 root non-CASCADE policies are exhaustively classified", () => {
  const edges = prismaRelationEdges();
  const direct = (root) => edges
    .filter((row) => row.parentModel === root && row.deleteAction !== "Cascade")
    .map((row) => `${row.childModel}:${row.deleteAction}`)
    .sort();

  assert.deepEqual(direct("CreatorAccount"), [
    "ContentCollection:SetNull",
    "FanList:SetNull",
    "FanListMember:SetNull",
    "MessageTemplateUsageEvent:SetNull",
    "SavedSegment:SetNull",
    "TeamActivityEvent:SetNull",
    "TeamShiftCreator:SetNull",
  ]);
  assert.deepEqual(direct("Agency"), ["AdminActionLog:SetNull"]);

  // Planned-shift history keeps creatorId as a durable scalar while creatorRefId
  // is the nullable live edge. Hard delete must never erase the assignment row.
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const shiftBlock = schema.slice(schema.indexOf("model TeamShiftCreator {"), schema.indexOf("model AnalyticsSnapshot {"));
  assert.match(shiftBlock, /creatorId\s+String/);
  assert.match(shiftBlock, /creatorRefId\s+String\?/);
  assert.match(shiftBlock, /creator CreatorAccount\?[^\n]+creatorRefId[^\n]+onDelete: SetNull/);

  const cascadeReachable = (root) => {
    const reachable = new Set();
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of edges) {
        if (row.deleteAction !== "Cascade") continue;
        if (row.parentModel !== root && !reachable.has(row.parentModel)) continue;
        if (!reachable.has(row.childModel)) { reachable.add(row.childModel); changed = true; }
      }
    }
    return reachable;
  };
  const intermediateExternal = (root) => {
    const reachable = cascadeReachable(root);
    return edges
      .filter((row) => row.parentModel !== root
        && reachable.has(row.parentModel)
        && !reachable.has(row.childModel)
        && row.deleteAction !== "Cascade")
      .map((row) => `${row.parentModel}->${row.childModel}:${row.deleteAction}`)
      .sort();
  };

  assert.deepEqual(intermediateExternal("CreatorAccount"), [
    "CreatorFinancialTransaction->TeamPpvPurchaseLedger:SetNull",
    "CreatorSale->TeamPpvPurchaseLedger:SetNull",
    "CreatorTip->TeamTipLedger:SetNull",
  ]);
  assert.deepEqual(intermediateExternal("Agency"), [
    "BillingOrder->BillingProviderEvent:SetNull",
    "BillingPaymentAttempt->BillingProviderEvent:SetNull",
    "CreatorFinancialTransaction->TeamPpvPurchaseLedger:SetNull",
    "CreatorSale->TeamPpvPurchaseLedger:SetNull",
    "CreatorTip->TeamTipLedger:SetNull",
  ]);
});


test("F55-06 Creator non-FK anti-map classifies every non-cascade creatorId carrier as operational cleanup or retained history", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const models = new Map(Array.from(schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm), (match) => [match[1], match[2]]));
  const relationEdges = [];
  for (const [child, block] of models) {
    for (const line of block.split("\n")) {
      if (!line.includes("@relation") || !line.includes("onDelete:")) continue;
      const target = line.match(/^\s*\w+\s+([A-Za-z_]\w*)\??(?:\[\])?\s+@relation/);
      const action = line.match(/onDelete:\s*(\w+)/);
      if (target && action) relationEdges.push({ parent: target[1], child, action: action[1] });
    }
  }
  const cascadeReachable = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of relationEdges) {
      if (edge.action !== "Cascade" || (edge.parent !== "CreatorAccount" && !cascadeReachable.has(edge.parent))) continue;
      if (!cascadeReachable.has(edge.child)) { cascadeReachable.add(edge.child); changed = true; }
    }
  }
  const nonCascadeCreatorCarriers = Array.from(models.entries())
    .filter(([, block]) => /^\s*creatorId\s+/m.test(block))
    .map(([name]) => name)
    .filter((name) => !cascadeReachable.has(name))
    .sort();
  const directSetNull = relationEdges
    .filter((edge) => edge.parent === "CreatorAccount" && edge.action === "SetNull")
    .map((edge) => edge.child);
  const operationalCleanup = [
    "ProviderOperationalDebt", "TelegramDeliveryIntent", "TelegramInboundEvent", "DomainWorkItem",
    "AutomationTask", "AutomationJob", "TeamSentMessageLedger", "TeamPpvPurchaseLedger", "TeamTipLedger", "TeamPpvResolveJob",
  ];
  const retainedHistory = [
    "BillingOrderLine", "BillingWalletTransaction", "CreatorBillingPeriod", "AutomationEvent",
    "MoneyAttribution", "ContentUsageEvent", "BumpDeliveryStat", "TeamActivityContribution",
    "TeamMemberActivityDaily", "TeamMoneyAttributionFact", "TeamMoneyDailyRollup",
    "TeamMoneyLifetimeRollup", "TeamMoneyRollupContribution",
  ];
  const classified = Array.from(new Set([...directSetNull, ...operationalCleanup, ...retainedHistory])).sort();
  assert.deepEqual(nonCascadeCreatorCarriers, classified);

  const destructive = source("phase2-destructive-delete-authority-service.js");
  assert.match(destructive, /await run\("AutomationJob"[\s\S]*await run\("AutomationTask"/);
  assert.match(destructive, /x\."accountId"=\$2/);
  assert.match(destructive, /FROM "AutomationTask" t/);
});


test("F55-07 Agency non-FK anti-map classifies every non-cascade agencyId carrier", () => {
  const schema = fs.readFileSync(path.join(__dirname, "../../prisma/schema.prisma"), "utf8");
  const models = new Map(Array.from(schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm), (match) => [match[1], match[2]]));
  const relationEdges = [];
  for (const [child, block] of models) {
    for (const line of block.split("\n")) {
      if (!line.includes("@relation") || !line.includes("onDelete:")) continue;
      const target = line.match(/^\s*\w+\s+([A-Za-z_]\w*)\??(?:\[\])?\s+@relation/);
      const action = line.match(/onDelete:\s*(\w+)/);
      if (target && action) relationEdges.push({ parent: target[1], child, action: action[1] });
    }
  }
  const reachable = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of relationEdges) {
      if (edge.action !== "Cascade" || (edge.parent !== "Agency" && !reachable.has(edge.parent))) continue;
      if (!reachable.has(edge.child)) { reachable.add(edge.child); changed = true; }
    }
  }
  const actual = Array.from(models.entries())
    .filter(([, block]) => /^\s*agencyId\s+/m.test(block))
    .map(([name]) => name)
    .filter((name) => !reachable.has(name))
    .sort();
  const directSetNull = relationEdges.filter((edge) => edge.parent === "Agency" && edge.action === "SetNull").map((edge) => edge.child);
  const boundedTenantRoots = [
    "ProviderOperationalDebt", "TelegramDeliveryIntent", "TelegramInboundEvent", "RefreshSession",
    "AnalyticsCollectionDemand", "DeviceCommand", "AutomationTask", "AutomationJob", "AutomationEvent",
    "ContentUsageEvent", "BumpDeliveryStat", "TeamSentMessageLedger", "TeamPpvPurchaseLedger", "TeamTipLedger", "TeamPpvResolveJob",
  ];
  const postCascadeCurrentRoots = ["Phase2WorkFamilyState", "DomainWorkReadyPartition", "DomainWorkReadyAgency"];
  const classified = Array.from(new Set([...directSetNull, ...boundedTenantRoots, ...postCascadeCurrentRoots])).sort();
  assert.deepEqual(actual, classified);

  const destructive = source("phase2-destructive-delete-authority-service.js");
  for (const table of boundedTenantRoots) assert.match(destructive, new RegExp(`"${table}"`));
  for (const table of postCascadeCurrentRoots) assert.match(destructive, new RegExp(`"${table}"`));
});

test("F55-07 Agency route establishes deletion barrier and publishes durable cleanup without tenant-wide cascade", () => {
  const admin = source("../routes/admin.js");
  const start = admin.indexOf('router.delete("/agencies/:id"');
  const restore = admin.indexOf('router.post("/agencies/:id/restore"', start);
  const route = admin.slice(start, restore);
  const hardStart = route.indexOf("if (hard) {");
  const softStart = route.indexOf("const deletedAt", hardStart);
  const hard = route.slice(hardStart, softStart);

  assert.match(hard, /lockAgencyPipelineLifecycleExclusive/);
  assert.match(hard, /assertAgencyCustomPipelineRetirable/);
  assert.match(hard, /assertAgencyMassCampaignRetirable/);
  assert.match(hard, /deletedAt: scheduledAt/);
  assert.match(hard, /refreshSession\.updateMany/);
  assert.match(hard, /DESTRUCTIVE_AGENCY_CLEANUP/);
  assert.match(hard, /Phase2AgencyDestructiveCleanup/);
  assert.match(hard, /res\.status\(202\)/);
  assert.doesNotMatch(hard, /tx\.agency\.delete/);
  assert.doesNotMatch(hard, /purgeAgencyPhase2ProviderLedgersForHardDelete/);

  const hardSelectStart = route.indexOf("...(hard ? {");
  const hardSelectEnd = route.indexOf("} : {", hardSelectStart);
  const hardSelect = route.slice(hardSelectStart, hardSelectEnd);
  assert.doesNotMatch(hardSelect, /members:\s*true/);
  assert.doesNotMatch(hardSelect, /creators:/);
});

test("F55-07 Agency worker composes Creator cleanup, bounded non-FK/history cleanup, proof-zero, then near-empty identity delete", () => {
  const destructive = source("phase2-destructive-delete-authority-service.js");
  const start = destructive.indexOf("async function processAgencyHardDeleteWorkItem");
  const end = destructive.indexOf("async function processCreatorHardDeleteWorkItem", start);
  const worker = destructive.slice(start, end);

  const creator = worker.indexOf("ensureAgencyCreatorCleanupBatch");
  const waitCreators = worker.indexOf("agencyCreatorRowsRemain");
  const nonFk = worker.indexOf("purgeAgencyNonFkTenantBatch");
  const domainWork = worker.indexOf("purgeAgencyDomainWorkBatch");
  const directFk = worker.indexOf("purgeRootDirectForeignActionsBatch");
  const cascade = worker.indexOf("purgeRootCascadeDescendantsBatch");
  const residual = worker.indexOf("rootCascadeRowsRemain");
  const identity = worker.indexOf("tx.agency.delete");
  const currentRoots = worker.indexOf("purgeAgencyPhase2CurrentWorkRootsAfterCascade");

  assert.ok(creator >= 0 && waitCreators > creator);
  assert.ok(nonFk > waitCreators && domainWork > nonFk && directFk > domainWork && cascade > directFk);
  assert.ok(residual > cascade && identity > residual && currentRoots > identity);
  assert.match(worker, /excludeTables: \["CreatorAccount", "DomainWorkItem"\]/);
  assert.match(worker, /maxWait: 10_000, timeout: 30_000/);
});


test("F55-07 hard Agency destructive intent cannot race with soft restore", () => {
  const admin = source("../routes/admin.js");
  const start = admin.indexOf('router.post("/agencies/:id/restore"');
  const end = admin.indexOf('router.post("/agencies/:id/impersonate"', start);
  const restore = admin.slice(start, end);
  assert.match(restore, /lockAgencyPipelineLifecycleExclusive/);
  assert.match(restore, /DESTRUCTIVE_AGENCY_CLEANUP/);
  assert.match(restore, /Phase2AgencyDestructiveCleanup/);
  assert.match(restore, /AGENCY_DESTRUCTIVE_DELETE_IRREVERSIBLE/);
  assert.match(restore, /select: \{ id: true, state: true, isOutstanding: true \}/);
  assert.doesNotMatch(restore, /select: \{ id: true, status: true, isOutstanding: true \}/);
  assert.ok(restore.indexOf("domainWorkItem.findFirst") < restore.indexOf("tx.agency.update"));

  const ui = fs.readFileSync(path.join(__dirname, "../../public/admin/modules/admin-agency-detail/admin-agency-detail-actions.js"), "utf8");
  assert.match(ui, /hard-delete scheduled — cleanup is running/);
});

test("F55-07 scheduler treats final Agency identity deletion as terminal without ACKing a cascaded-away DWI", () => {
  const scheduler = source("job-scheduler.js");
  const start = scheduler.indexOf("async function runAgencyDestructiveCleanupSweep");
  const end = scheduler.indexOf("async function runCreatorDestructiveCleanupSweep", start);
  const sweep = scheduler.slice(start, end);
  assert.match(sweep, /DESTRUCTIVE_AGENCY_CLEANUP/);
  assert.match(sweep, /limit:\s*2/);
  assert.match(sweep, /batchSize:\s*250/);
  assert.match(sweep, /if \(result\?\.identityDeleted\) report\.completed \+= 1/);
  assert.match(sweep, /yieldDomainWorkClaim/);

  const laneAt = scheduler.indexOf('["agencyDestructiveCleanup"');
  const creatorLaneAt = scheduler.indexOf('["creatorDestructiveCleanup"');
  assert.ok(laneAt >= 0 && creatorLaneAt > laneAt);
});

test("F55-07 generation migration registers Agency destructive work in the current immutable DomainWork generation", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260911162000_phase2_actual55_root_e_destructive_lifecycle/migration.sql"), "utf8");
  assert.match(migration, /DESTRUCTIVE_AGENCY_CLEANUP/);
  assert.match(migration, /phase2_domain_work_v3_actual55/);
  assert.match(migration, /ON CONFLICT \("workClass"\) DO UPDATE/);
});

test("F55-07 fresh-source DB fence blocks late inserts into non-FK tenant roots after durable Agency hard-delete intent", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260911170000_phase2_actual55_fresh_source_destructive_fences/migration.sql"), "utf8");
  assert.match(migration, /pg_try_advisory_xact_lock_shared/);
  assert.match(migration, /agency-lifecycle:/);
  assert.match(migration, /PHASE2_AGENCY_LIFECYCLE_BUSY/);
  assert.match(migration, /DESTRUCTIVE_AGENCY_CLEANUP/);
  assert.match(migration, /Phase2AgencyDestructiveCleanup/);
  assert.match(migration, /BEFORE INSERT OR UPDATE/);
  assert.match(migration, /PHASE2_AGENCY_DESTRUCTIVE_DELETE_IN_PROGRESS/);
  for (const table of [
    "ProviderOperationalDebt", "TelegramDeliveryIntent", "TelegramInboundEvent", "RefreshSession",
    "AnalyticsCollectionDemand", "DeviceCommand", "AutomationTask", "AutomationJob", "AutomationEvent",
    "ContentUsageEvent", "BumpDeliveryStat", "TeamSentMessageLedger", "TeamPpvPurchaseLedger", "TeamTipLedger", "TeamPpvResolveJob",
  ]) assert.match(migration, new RegExp(`'${table}'`));
  // Current-work roots are maintained by DomainWorkItem triggers and are purged
  // after final Agency cascade; fencing them would deadlock hard-delete publication.
  assert.doesNotMatch(migration, /'Phase2WorkFamilyState'/);
  assert.doesNotMatch(migration, /'DomainWorkReadyPartition'/);
  assert.doesNotMatch(migration, /'DomainWorkReadyAgency'/);
});


test("F55-06 fresh-source creator proof-zero fences direct and indirect residual inserts without a waiting lock cycle", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260911170000_phase2_actual55_fresh_source_destructive_fences/migration.sql"), "utf8");
  assert.match(migration, /phase2_assert_creator_destructive_insert_allowed/);
  assert.match(migration, /phase2_fence_direct_creator_insert_during_creator_delete/);
  assert.match(migration, /phase2_fence_indirect_creator_residual_insert/);
  assert.match(migration, /BEFORE INSERT OR UPDATE/);
  assert.match(migration, /FOR KEY SHARE NOWAIT/);
  assert.match(migration, /EXCEPTION WHEN lock_not_available/);
  assert.match(migration, /DESTRUCTIVE_CREATOR_CLEANUP/);
  assert.match(migration, /Phase2CreatorDestructiveCleanup/);
  assert.match(migration, /PHASE2_CREATOR_DESTRUCTIVE_DELETE_IN_PROGRESS/);
  for (const table of [
    "ProviderOperationalDebt", "TelegramDeliveryIntent", "TelegramInboundEvent", "DomainWorkItem",
    "AutomationTask", "AutomationJob",
    "TeamSentMessageLedger", "TeamPpvPurchaseLedger", "TeamTipLedger", "TeamPpvResolveJob", "TeamShiftCreator",
  ]) assert.match(migration, new RegExp(`'${table}'`));
  for (const identity of ["customOrderId", "customSubmissionId", "submissionId", "objectType", "accountId", "taskId", "CREATOR_BINDING", "REMINDER_OUTCOME"]) {
    assert.match(migration, new RegExp(identity));
  }
  assert.match(migration, /phase2_fence_creator_dependency_insert_during_creator_delete/);
  assert.match(migration, /PHASE2_REMINDER_DEPENDENCY_PARENT_ABSENT/);
});

test("F55-06 Creator hard-delete retains TeamShiftCreator historical assignment and nulls only the live Creator reference", () => {
  const migration = fs.readFileSync(path.join(__dirname, "../../prisma/migrations/20260911170000_phase2_actual55_fresh_source_destructive_fences/migration.sql"), "utf8");
  const destructive = source("phase2-destructive-delete-authority-service.js");
  const schedule = source("team-schedule-service.js");
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "creatorRefId" TEXT/);
  assert.match(migration, /SET "creatorRefId" = "creatorId"/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS "TeamShiftCreator_creatorId_fkey"/);
  assert.match(migration, /TeamShiftCreator_creatorRefId_fkey[\s\S]*ON DELETE SET NULL/);
  assert.match(migration, /TG_TABLE_NAME = 'TeamShiftCreator'[\s\S]*TG_OP = 'UPDATE'[\s\S]*creatorRefId[\s\S]*IS NULL[\s\S]*RETURN NEW/);
  assert.match(destructive, /deleteRestrictedTables: \[\]/);
  assert.doesNotMatch(destructive, /deleteRestrictedTables: \["TeamShiftCreator"\]/);
  assert.match(schedule, /creatorId, creatorRefId: creatorId/);
});


test("INT5 Root E dependency retarget UPDATE is fenced and TeamShift detach exemption is exact", () => {
  const migration = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "migrations", "20260911183000_phase2_actual55_int5_claim_temporal_destructive_closure", "migration.sql"), "utf8");
  assert.match(migration, /BEFORE INSERT OR UPDATE ON "Phase2DependencyState"/);
  assert.match(migration, /TG_TABLE_NAME = 'TeamShiftCreator'/);
  assert.match(migration, /to_jsonb\(NEW\) - 'creatorRefId'/);
  assert.match(migration, /to_jsonb\(OLD\) - 'creatorRefId'/);
  assert.match(migration, /phase2_assert_agency_destructive_mutation_allowed/);
  assert.match(migration, /v_old_agency_id IS DISTINCT FROM v_new_agency_id/);
  assert.match(migration, /v_old_creator_id IS DISTINCT FROM v_new_creator_id/);
  assert.match(migration, /phase2_assert_creator_destructive_insert_allowed"\(v_old_agency_id, v_old_creator_id/);
  assert.match(migration, /phase2_assert_indirect_creator_residual_row_allowed/);
  assert.match(migration, /v_old_signature IS DISTINCT FROM v_new_signature/);
  assert.match(migration, /OLD\."dependencyKind"[\s\S]*IS DISTINCT FROM[\s\S]*NEW\."dependencyKind"/);
});
