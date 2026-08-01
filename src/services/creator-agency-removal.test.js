"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { agencyRemovalPhrase, removeCreatorFromAssignedCreators } = require("./creator-agency-removal");

test("agency removal phrase uses the normalized username", () => {
  assert.equal(agencyRemovalPhrase({ id: "creator-1", username: " @Model_A " }), "DELETE @model_a");
  assert.throws(() => agencyRemovalPhrase({ id: "creator-1", username: null }), /username is required/);
});

test("creator is removed from every supported member assignment shape", () => {
  assert.deepEqual(removeCreatorFromAssignedCreators(["a", "target", "b"], "target"), { changed: true, value: ["a", "b"] });
  assert.deepEqual(removeCreatorFromAssignedCreators({ ids: ["target", "b"], mode: "selected" }, "target"), { changed: true, value: { ids: ["b"], mode: "selected" } });
  assert.deepEqual(removeCreatorFromAssignedCreators({ creatorIds: ["a", "target"] }, "target"), { changed: true, value: { creatorIds: ["a"] } });
  assert.deepEqual(removeCreatorFromAssignedCreators("all", "target"), { changed: false, value: "all" });
  assert.deepEqual(removeCreatorFromAssignedCreators({ all: true }, "target"), { changed: false, value: { all: true } });
});

test("assignment cleanup is idempotent and does not mutate the source", () => {
  const source = { creatorIds: ["a", "b"], note: "keep" };
  const result = removeCreatorFromAssignedCreators(source, "target");
  assert.equal(result.changed, false);
  assert.equal(result.value, source);
  assert.deepEqual(source, { creatorIds: ["a", "b"], note: "keep" });
});
