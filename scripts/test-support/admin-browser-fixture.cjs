"use strict";
const fs = require("node:fs"),
  vm = require("node:vm");
// Existing small DOM fixtures run the same workspace coordinator as the browser.
exports.workspace = function (sandbox) {
  const w = sandbox.window;
  w.addEventListener ||= () => {};
  w.OnlinodAdminState ||= { admin: { id: "unit-admin", role: "SUPER_ADMIN" }, section: "unit" };
  w.OnlinodAdminApi ||= {};
  w.OnlinodAdminApi.getToken ||= () => "unit-session";
  sandbox.document ||= { getElementById: () => null };
  sandbox.document.querySelectorAll ||= () => [];
  Object.assign(sandbox, { setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInNewContext(fs.readFileSync(require.resolve("../../public/admin/core/admin-workspace.js"), "utf8"), sandbox);
  return sandbox;
};
