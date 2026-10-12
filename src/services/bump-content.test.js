"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeBumpToTask, upsertTask, taskToBump } = require("./automation-server-service");
const { taskToTemplate } = require("./bump-rules");

async function roundTrip(input) {
  const db = {
    creatorAccount: { findFirst: async () => ({ id: "creator", agencyId: "agency" }) },
    automationTask: { findFirst: async () => null, create: async ({ data }) => ({ ...data, id: "server" }) },
  };
  const { item } = await upsertTask({ agencyId: "agency", userId: "owner", expectedCreatorId: "creator", input: normalizeBumpToTask(input, "creator"), db });
  return { item, editor: taskToBump(item), send: taskToTemplate(item) };
}

test("Bump save/read/planning retains 12,000 characters, all selected media and exact paid content", async () => {
  const messageText = "Long caption ".repeat(1000).slice(0, 12000);
  const media = Array.from({ length: 12 }, (_, i) => ({ id: 90000 + i, type: "photo", thumbUrl: `https://media.example.test/${i}`, files: { full: { url: "https://media.example.test/" + "x".repeat(1800) } }, raw: { token: "must-not-persist" }, irrelevant: "x".repeat(1900) }));
  const { item, editor, send } = await roundTrip({ id: "caption", messageText, price: 12.35, lockedText: true, media });
  assert.equal(editor.messageText, messageText);
  assert.equal(editor.price, 12.35);
  assert.equal(editor.lockedText, true);
  assert.deepEqual(editor.media.map(x => x.id), media.map(x => String(x.id)));
  assert.deepEqual(send.mediaFiles, media.map(x => x.id));
  assert.equal(send.price, 12.35);
  assert.equal(send.lockedText, true);
  assert.equal(send.text, `<p>${messageText}</p>`);
  assert.equal(item.config.priceCents, 1235);
  assert.doesNotMatch(JSON.stringify(item.config), /must-not-persist|irrelevant|files|raw/);
});

test("Cents-only input, primitive media IDs and duplicates have one stable contract", async () => {
  const { editor, send } = await roundTrip({ messageText: "hello", priceCents: 625, media: [21, "21", { mediaId: "34" }] });
  assert.equal(editor.price, 6.25);
  assert.deepEqual(editor.media.map(x => x.id), ["21", "34"]);
  assert.deepEqual(send.mediaFiles, [21, 34]);
});

test("Invalid message intent is rejected before persistence instead of changed or truncated", async () => {
  for (const input of [{ price: -1 }, { price: Infinity }, { price: "nonsense" }, { price: 1, currency: "EUR" }, { media: "broken" }, { media: ["bad"] }, { media: [1.5] }, { media: [Number.MAX_SAFE_INTEGER + 1] }, { media: Array.from({ length: 201 }, (_, i) => i + 1) }, { messageText: "x".repeat(12001) }]) {
    await assert.rejects(roundTrip({ messageText: "hello", ...input }), error => error.code === "AUTOMATION_BUMP_CONTENT_INVALID");
  }
});

test("Switching paid content to free clears locked text and stale cents", async () => {
  const { editor, send } = await roundTrip({ messageText: "free", price: 0, priceCents: 625, lockedText: true, media: [21] });
  assert.equal(editor.price, 0); assert.equal(editor.lockedText, false);
  assert.equal(send.price, 0); assert.equal(send.lockedText, false);
});
