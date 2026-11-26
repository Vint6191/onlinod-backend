"use strict";
const { annotateFailure, reportFailure } = require("./install-diagnostics");

function preflightConfiguration(args) {
  const core = require("./install-current");
  core.validateConfiguration(args);
  const conversationConfigured = Boolean(process.env.DIALOGS_DATABASE_URL || process.env.CRM_DATABASE_URL);
  if (!conversationConfigured) return false;
  // Validate all configured targets before changing core. This is a resumable
  // sequence across separate databases, not an atomic multi-database install.
  for (const [domain, key] of [["dialogs", "DIALOGS_DATABASE_URL"], ["crm", "CRM_DATABASE_URL"]]) {
    if (!process.env[key]) throw annotateFailure(Object.assign(new Error("CONVERSATION_DATABASES_NOT_CONFIGURED"), {
      code: "CONVERSATION_DATABASES_NOT_CONFIGURED",
    }), { phase: "CONFIGURATION", domain });
    try {
      const url = new URL(process.env[key]);
      if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === "/")
        throw Object.assign(new Error("CONVERSATION_DATABASE_URL_INVALID"), { code: "CONVERSATION_DATABASE_URL_INVALID" });
      if (url.searchParams.getAll("schema").some(schema => schema && schema !== "public"))
        throw Object.assign(new Error("CONVERSATION_PUBLIC_SCHEMA_REQUIRED"), { code: "CONVERSATION_PUBLIC_SCHEMA_REQUIRED" });
    } catch (error) {
      const safe = error.code === "ERR_INVALID_URL" ? Object.assign(new Error("CONVERSATION_DATABASE_URL_INVALID"), {
        code: "CONVERSATION_DATABASE_URL_INVALID",
      }) : error;
      throw annotateFailure(safe, { phase: "CONFIGURATION", domain });
    }
  }
  try { require("../../src/services/conversation-storage/databases").configuration(); }
  catch (error) { throw annotateFailure(error, { phase: "CONFIGURATION", domain: "conversation" }); }
  return true;
}

async function main(args = process.argv.slice(2)) {
  const completedDatabases = [];
  let phase = "SOURCE_PREPARATION";
  try {
    const core = require("./install-current");
    phase = "CONFIGURATION";
    const conversationConfigured = preflightConfiguration(args);
    let conversation;
    if (conversationConfigured) {
      phase = "SOURCE_PREPARATION";
      conversation = require("./install-conversation-stores");
      phase = "CONVERSATION_PREFLIGHT";
      await conversation.preflight();
    }
    await core.main(args);
    completedDatabases.push("core");
    if (conversation) await conversation.main({
      onDomainComplete: domain => { if (["dialogs", "crm"].includes(domain)) completedDatabases.push(domain); },
    });
    const result = { ok: true, phase: "INSTALL_COMPLETE", completedDatabases };
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    throw annotateFailure(error, { phase, domain: "core", completedDatabases });
  }
}
if (require.main === module)
  main().catch((error) => {
    reportFailure(error);
    process.exitCode = 1;
  });
module.exports = { main, preflightConfiguration };
