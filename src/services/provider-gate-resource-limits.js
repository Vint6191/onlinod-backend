"use strict";

// Per-process backpressure keeps HTTP waiters, queue scans and each heartbeat
// finite. It does not replace the durable provider spacing/fairness authority.
module.exports = Object.freeze({
  PROVIDER_GATE_MAX_PENDING: 16_384,
  PROVIDER_GATE_MAX_PENDING_PER_DEVICE: 512,
  PROVIDER_GATE_MAX_PENDING_PER_CREATOR: 256,
  PROVIDER_GATE_HEARTBEAT_BATCH_SIZE: 4_096,
});
