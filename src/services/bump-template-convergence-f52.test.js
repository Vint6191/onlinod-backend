"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");

function templateRow(index) {
  return {
    id: `server-${String(index).padStart(4, "0")}`,
    clientId: `template-${index}`,
    title: `Template ${index}`,
    config: { messageText: `hello ${index}`, media: [index] },
    triggers: { fanOnline: true },
    rules: {},
    updatedAt: new Date("2026-09-07T18:00:00.000Z"),
    createdAt: new Date(1_700_000_000_000 + index),
  };
}

function loadBumpServiceWithProvenance(classify) {
  const previousLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === "../prisma" && parent?.filename?.endsWith("bump-service.js")) return {};
    if (request === "./custom-content-delivery-service" && parent?.filename?.endsWith("bump-service.js")) {
      return { classifyProgrammaticCustomMediaProvenance: classify };
    }
    if (request === "./automation-pacing-service" && parent?.filename?.endsWith("bump-service.js")) {
      return { nextAutomationWriteSlot: async () => new Date() };
    }
    if (request === "./automation-control-service" && parent?.filename?.endsWith("bump-service.js")) {
      return {
        BUMPS_MODULE_KEY: "bumps",
        assertAutomationEnabled: async () => ({}),
        getAutomationControlSnapshot: async () => ({}),
        requireCreator: async () => ({}),
      };
    }
    return previousLoad.call(this, request, parent, isMain);
  };
  delete require.cache[require.resolve("./bump-service")];
  const service = require("./bump-service");
  Module._load = previousLoad;
  return service;
}

test("F52 legacy CUSTOM templates cannot starve valid template after raw row 500", async () => {
  const rows = Array.from({ length: 501 }, (_, offset) => templateRow(offset + 1));
  const readCalls = [];
  const provenanceCalls = [];
  const db = {
    automationTask: {
      findMany: async (args) => {
        readCalls.push(args);
        const cursorId = args.cursor?.id || null;
        const cursorIndex = cursorId ? rows.findIndex((row) => row.id === cursorId) : -1;
        const start = cursorId ? cursorIndex + Number(args.skip || 0) : 0;
        return rows.slice(start, start + args.take);
      },
    },
  };
  const { activeTemplates } = loadBumpServiceWithProvenance(async ({ mediaIds }) => {
    provenanceCalls.push([...mediaIds]);
    return {
      ok: true,
      customMediaIds: mediaIds.map(String).filter((id) => Number(id) <= 500),
    };
  });

  const result = await activeTemplates({
    agencyId: "agency-1",
    creatorId: "creator-1",
    source: "online",
    eligibleLimit: 1,
    db,
  });

  assert.equal(result.templates.length, 1);
  assert.equal(result.templates[0].id, "template-501");
  assert.equal(result.blockedTemplateIds.length, 500);
  assert.equal(readCalls.length, 3);
  assert.deepEqual(readCalls.map((call) => call.take), [200, 200, 200]);
  assert.deepEqual(readCalls[1].cursor, { id: rows[199].id });
  assert.deepEqual(readCalls[2].cursor, { id: rows[399].id });
  assert.ok(provenanceCalls.every((mediaIds) => mediaIds.length <= 200));
});

test("F52 template selection preserves stable eligible order and stops after enough eligible templates", async () => {
  const rows = Array.from({ length: 450 }, (_, offset) => templateRow(offset + 1));
  const db = {
    automationTask: {
      findMany: async (args) => {
        const cursorId = args.cursor?.id || null;
        const cursorIndex = cursorId ? rows.findIndex((row) => row.id === cursorId) : -1;
        const start = cursorId ? cursorIndex + Number(args.skip || 0) : 0;
        return rows.slice(start, start + args.take);
      },
    },
  };
  const { activeTemplates } = loadBumpServiceWithProvenance(async ({ mediaIds }) => ({
    ok: true,
    customMediaIds: mediaIds.map(String).filter((id) => Number(id) % 2 === 1),
  }));

  const result = await activeTemplates({
    agencyId: "agency-1",
    creatorId: "creator-1",
    source: "online",
    eligibleLimit: 3,
    db,
  });

  assert.deepEqual(result.templates.map((row) => row.id), ["template-2", "template-4", "template-6"]);
  assert.deepEqual(result.blockedTemplateIds.slice(0, 3), ["template-1", "template-3", "template-5"]);
});
