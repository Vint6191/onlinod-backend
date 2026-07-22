"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  isTerminalDialogText,
  isTerminalDialogOutcome,
} = require("./dialog-terminal-outcome");

test("OnlyFans User not found is a terminal unavailable dialog", () => {
  assert.equal(isTerminalDialogText("OF_REQUEST_FAILED: User not found"), true);
  assert.equal(isTerminalDialogOutcome({
    code: "OF_REQUEST_FAILED",
    error: "User not found",
    retryable: false,
  }), true);
});

test("machine codes and terminal HTTP statuses remain terminal", () => {
  assert.equal(isTerminalDialogOutcome({ code: "USER_NOT_FOUND" }), true);
  assert.equal(isTerminalDialogOutcome({ status: 404, error: "missing" }), true);
  assert.equal(isTerminalDialogOutcome({ error: "DIALOG_BATCH_ITEM_ID_MISSING" }), true);
  assert.equal(isTerminalDialogText("DIALOG_UNAVAILABLE: HTTP 403"), true);
  assert.equal(isTerminalDialogText("OF_REQUEST_FAILED: HTTP 404"), true);
});

test("technical failures are not hidden as unavailable", () => {
  assert.equal(isTerminalDialogOutcome({ code: "OF_REQUEST_FAILED", error: "Request timed out" }), false);
  assert.equal(isTerminalDialogOutcome({ status: 500, error: "Internal server error" }), false);
  assert.equal(isTerminalDialogText("SQLITE_BUSY: database is locked"), false);
});
