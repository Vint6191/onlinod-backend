"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  sanitizeAutomationRuntimeEvent,
  sanitizeAutomationRuntimeEvents,
} = require("./automation-runtime-event-contract");

test("chat events leave only routing identifiers and time", () => {
  const event = sanitizeAutomationRuntimeEvent({
    type: "chat_message_received",
    source: "ws_frame",
    fanId: "fan-1",
    dialogId: "fan-1",
    messageId: "message-9",
    createdAt: "2026-07-27T10:00:00.000Z",
    text: "private message body",
    mediaIds: ["media-1"],
    media: [{ url: "https://private.invalid/file" }],
    fanSnapshot: { name: "Private profile", avatar: "https://avatar.invalid" },
    raw: { api2_chat_message: { text: "private message body" } },
  });
  assert.deepEqual(event, {
    type: "chat_message_received",
    source: "ws_frame",
    fanId: "fan-1",
    messageId: "message-9",
    createdAt: "2026-07-27T10:00:00.000Z",
  });
  assert.equal(JSON.stringify(event).includes("private"), false);
  assert.equal(JSON.stringify(event).includes("media-1"), false);
});

test("presence and subscription events are reduced to the Automation contract", () => {
  assert.deepEqual(sanitizeAutomationRuntimeEvent({
    type: "presence_online",
    onlineIds: ["1", "1", "2", ""],
    text: "must not leave desktop",
  }), {
    type: "presence_online",
    source: "ws",
    fanIds: ["1", "2"],
  });
  assert.deepEqual(sanitizeAutomationRuntimeEvent({
    type: "subscription_created",
    fanId: "fan-2",
    dialogId: "dialog-2",
    createdAt: "2026-07-27T11:00:00Z",
    fanSnapshot: { name: "not required" },
    amount: 99,
  }), {
    type: "subscription_created",
    source: "ws",
    fanId: "fan-2",
    dialogId: "dialog-2",
    createdAt: "2026-07-27T11:00:00.000Z",
  });
});

test("unsupported and unaddressable events are dropped", () => {
  assert.equal(sanitizeAutomationRuntimeEvent({ type: "chat_message_sent", fanId: "fan" }), null);
  assert.equal(sanitizeAutomationRuntimeEvent({ type: "chat_message_received", text: "no fan" }), null);
  assert.deepEqual(sanitizeAutomationRuntimeEvents([
    { type: "chat_message_sent", fanId: "fan" },
    { type: "chat_message_received", fanId: "fan", messageId: "m" },
  ]), [{ type: "chat_message_received", source: "ws", fanId: "fan", messageId: "m" }]);
});
