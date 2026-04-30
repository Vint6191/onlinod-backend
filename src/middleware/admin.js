const { adminSessionRequired } = require("./admin-session");

function adminRequired(req, res, next) {
  return adminSessionRequired(req, res, next);
}

module.exports = { adminRequired };
