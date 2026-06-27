"use strict";

function serializableTxOptions({ timeout = 30000, maxWait = 5000 } = {}) {
  return {
    isolationLevel: "Serializable",
    maxWait,
    timeout,
  };
}

module.exports = { serializableTxOptions };
