"use strict";

const MODULES = [
  { key: "home", label: "Home", status: "wired", description: "Workspace summary dashboard." },
  { key: "creatorAnalytics", label: "Creator Analytics", status: "wired", description: "Creator earnings/campaign snapshots via jobs." },
  { key: "teamAnalytics", label: "Team Analytics", status: "partial", description: "Team state and activity analytics." },
  { key: "vault", label: "Vault", status: "partial", description: "Live vault remains Electron; unsorted sync is backend." },
  { key: "automation", label: "Automation", status: "skeleton", description: "Rules/runs/logs scaffold." },
  { key: "messageLibrary", label: "Message Library", status: "skeleton", description: "Templates/groups/usage scaffold." },
  { key: "settings", label: "Settings", status: "partial", description: "Workspace/module settings." },
];

function getModuleRegistry() {
  return MODULES.map((item) => ({ ...item }));
}

module.exports = { getModuleRegistry };
