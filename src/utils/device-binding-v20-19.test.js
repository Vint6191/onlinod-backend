"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { resolveRefreshDeviceBinding, requireBoundAccessDevice } = require("./device-binding");

test("refresh token remains pinned to its original logical device", () => {
  assert.deepEqual(resolveRefreshDeviceBinding("device-a", "device-a"), { ok: true, deviceId: "device-a" });
  assert.deepEqual(resolveRefreshDeviceBinding("device-a", null), { ok: true, deviceId: "device-a" });
  assert.deepEqual(resolveRefreshDeviceBinding(null, "device-a"), { ok: true, deviceId: "device-a" });
  const mismatch = resolveRefreshDeviceBinding("device-a", "device-b");
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.code, "REFRESH_DEVICE_MISMATCH");
  assert.equal(mismatch.deviceId, null);
});

test("device-scoped secret actions require the actor device from the signed access-token claim", () => {
  assert.equal(requireBoundAccessDevice("device-a", "device-a"), "device-a");
  assert.throws(
    () => requireBoundAccessDevice(null, "device-a"),
    (error) => error?.code === "AUTH_DEVICE_BOUND_TOKEN_REQUIRED" && error?.status === 401,
  );
  assert.throws(
    () => requireBoundAccessDevice("device-a", "device-b"),
    (error) => error?.code === "AUTH_DEVICE_MISMATCH" && error?.status === 403,
  );
});
