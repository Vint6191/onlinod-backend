"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  const parentFile = String(parent?.filename || "");
  if (request === "../prisma" && parentFile.endsWith("team-dialog-projection-authority-service.js")) return {};
  if (request === "./domain-work-authority-service" && parentFile.endsWith("team-dialog-projection-authority-service.js")) {
    return {
      publishDomainWork: async () => ({ ok: true }),
      WORK_CLASS: {
        TEAM_DIALOG_PROJECTION: "TEAM_DIALOG_PROJECTION",
        TEAM_RESPONSE_RANGE_REPAIR: "TEAM_RESPONSE_RANGE_REPAIR",
      },
    };
  }
  if (request === "./team-pending-projection-service" && parentFile.endsWith("team-dialog-projection-authority-service.js")) {
    return { applyTeamPendingProjection: async () => ({ ok: true }) };
  }
  if (request === "./team-response-projection-service" && parentFile.endsWith("team-dialog-projection-authority-service.js")) {
    return {
      applyTeamResponseProjection: async () => ({ ok: true }),
      upsertCoverageSession: async () => null,
      repairResponseCasesForCoverageEvent: async () => ({ ok: true, complete: true }),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
};
let svc;
try { svc = require("./team-dialog-projection-authority-service"); } finally { Module._load = originalLoad; }

test("dialog historical verification filters irrelevant automation rows before LIMIT", async () => {
  let args = null;
  const relevant = { id: "z-real", agencyId: "agency-1", creatorId: "creator-1", dialogId: "fan-1", eventKind: "FAN_MESSAGE_RECEIVED" };
  const db = { teamActivityEvent: {
    async findMany(input) {
      args = input;
      const semantic = input?.where?.AND?.[0]?.OR || [];
      const manualBranch = semantic.find((row) => row?.eventKind === "MESSAGE_SEND_CONFIRMED");
      const broadBranch = semantic.find((row) => row?.eventKind?.in);
      // Simulate the exact failure mode: without a pre-LIMIT semantic predicate,
      // 25 automation rows would consume the page and hide the later real event.
      const filterIsPreLimit = input.take === 25
        && broadBranch?.eventKind?.in?.includes("FAN_MESSAGE_RECEIVED")
        && !broadBranch?.eventKind?.in?.includes("MESSAGE_SEND_CONFIRMED")
        && manualBranch?.actionSource === "MANUAL"
        && manualBranch?.lifecycle === "CONFIRMED";
      return filterIsPreLimit ? [relevant] : Array.from({ length: 25 }, (_, i) => ({ id: `noise-${i}`, eventKind: "MESSAGE_SEND_CONFIRMED", actionSource: "AUTOMATION", lifecycle: "CONFIRMED" }));
    },
  } };
  const rows = await svc.listUnprojectedRelevantDialogEvents({ db, agencyId: "agency-1", limit: 25 });
  assert.deepEqual(rows, [relevant]);
  assert.equal(args.take, 25);
  assert.ok(Array.isArray(args.where.AND), "semantic and projection predicates must be inside DB where before take");
});

test("dialog work identity is creator-scoped so equal dialog ids cannot cross creators", () => {
  const a = svc.dialogWorkObjectId("creator-a", "fan-1");
  const b = svc.dialogWorkObjectId("creator-b", "fan-1");
  assert.notEqual(a, b);
  assert.deepEqual(svc.parseDialogWorkObjectId(a), { creatorId: "creator-a", dialogId: "fan-1" });
  assert.deepEqual(svc.parseDialogWorkObjectId(b), { creatorId: "creator-b", dialogId: "fan-1" });
});
