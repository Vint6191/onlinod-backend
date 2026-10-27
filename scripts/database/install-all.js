"use strict";
const core = require("./install-current");
async function main() {
  await core.main();
  if (process.env.DIALOGS_DATABASE_URL || process.env.CRM_DATABASE_URL)
    await require("./install-conversation-stores").main();
}
if (require.main === module)
  main().catch((error) => {
    core.reportFailure(error);
    process.exitCode = 1;
  });
module.exports = { main };
