"use strict";

const { createHash } = require("node:crypto");

// JSON field order is not an event revision. Array order and scalar types are.
function hashCanonicalJson(value) {
  const canonical = JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(
      Object.keys(item)
        .sort()
        .map((key) => [key, item[key]])
    );
  });
  return createHash("sha256").update(canonical).digest("hex");
}

module.exports = { hashCanonicalJson };
