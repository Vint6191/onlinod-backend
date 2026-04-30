const crypto = require("node:crypto");

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

function randomCode() {
  return String(crypto.randomInt(100000, 999999));
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function addMinutes(minutes) {
  return new Date(Date.now() + Number(minutes) * 60 * 1000);
}

function addDays(days) {
  return new Date(Date.now() + Number(days) * 24 * 60 * 60 * 1000);
}

module.exports = {
  randomToken,
  randomCode,
  sha256,
  addMinutes,
  addDays,
};
