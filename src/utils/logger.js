"use strict";

function safeMeta(meta) {
  if (!meta || typeof meta !== "object") return meta;
  const out = { ...meta };
  for (const key of Object.keys(out)) {
    if (/token|secret|password|authorization|cookie/i.test(key)) out[key] = "[redacted]";
  }
  return out;
}

function write(level, message, meta = {}) {
  const row = {
    ts: new Date().toISOString(),
    level,
    service: "onlinod-backend",
    message: String(message || ""),
    ...(meta && typeof meta === "object" ? safeMeta(meta) : { meta }),
  };
  const line = JSON.stringify(row);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
  return row;
}

module.exports = {
  debug: (message, meta) => process.env.LOG_LEVEL === "debug" ? write("debug", message, meta) : undefined,
  info: (message, meta) => write("info", message, meta),
  warn: (message, meta) => write("warn", message, meta),
  error: (message, meta) => write("error", message, meta),
};
