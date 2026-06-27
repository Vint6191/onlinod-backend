"use strict";

function mb(bytes) {
  const n = Number(bytes || 0);
  return Math.round((n / 1024 / 1024) * 10) / 10;
}

function buildBackendHealthSnapshot({ database = "unknown" } = {}) {
  const memory = process.memoryUsage?.() || {};
  return {
    ok: database !== "error",
    service: "onlinod-backend",
    time: new Date().toISOString(),
    pid: process.pid,
    node: process.version,
    platform: process.platform,
    uptimeSeconds: Math.round(Number(process.uptime?.() || 0)),
    database,
    memoryMb: {
      rss: mb(memory.rss),
      heapUsed: mb(memory.heapUsed),
      heapTotal: mb(memory.heapTotal),
      external: mb(memory.external),
    },
  };
}

module.exports = { buildBackendHealthSnapshot };
