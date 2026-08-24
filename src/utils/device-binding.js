"use strict";

function cleanDeviceId(value) {
  return String(value || "").trim();
}

function resolveRefreshDeviceBinding(storedDeviceId, requestedDeviceId) {
  const stored = cleanDeviceId(storedDeviceId);
  const requested = cleanDeviceId(requestedDeviceId);
  if (stored && requested && stored !== requested) {
    return {
      ok: false,
      code: "REFRESH_DEVICE_MISMATCH",
      error: "Refresh session is bound to a different logical device",
      deviceId: null,
    };
  }
  return { ok: true, deviceId: stored || requested || null };
}

function requireBoundAccessDevice(tokenDeviceId, suppliedDeviceId, {
  requiredCode = "AUTH_DEVICE_BOUND_TOKEN_REQUIRED",
  mismatchCode = "AUTH_DEVICE_MISMATCH",
} = {}) {
  const token = cleanDeviceId(tokenDeviceId);
  const supplied = cleanDeviceId(suppliedDeviceId);
  if (!token) {
    const error = new Error("A device-bound access token is required for this operation");
    error.code = requiredCode;
    error.status = 401;
    throw error;
  }
  if (!supplied || token !== supplied) {
    const error = new Error("Authenticated access token belongs to a different logical device");
    error.code = mismatchCode;
    error.status = 403;
    throw error;
  }
  return token;
}

module.exports = {
  resolveRefreshDeviceBinding,
  requireBoundAccessDevice,
};
