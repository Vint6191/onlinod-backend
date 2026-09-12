"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.join(__dirname, "..", "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const between = (source, startNeedle, endNeedle) => {
  const start = source.indexOf(startNeedle);
  assert.ok(start >= 0, `missing start ${startNeedle}`);
  const end = endNeedle ? source.indexOf(endNeedle, start + startNeedle.length) : source.length;
  assert.ok(end > start, `missing end ${endNeedle}`);
  return source.slice(start, end);
};
const ordered = (source, needles, label) => {
  let cursor = -1;
  for (const needle of needles) {
    const next = source.indexOf(needle, cursor + 1);
    assert.ok(next > cursor, `${label}: ${needle} must follow previous lock/mutation edge`);
    cursor = next;
  }
};

const migration = read("prisma/migrations/20260912002000_phase2_actual56_management_lock_topology/migration.sql");
const customAccess = read("src/services/custom-management-access-authority-service.js");
const telegramContact = read("src/services/creator-telegram-contact-authority-service.js");
const telegramIdentity = read("src/services/creator-telegram-identity.js");
const admin = read("src/routes/admin.js");
const auth = read("src/routes/auth.js");
const invitations = read("src/routes/invitations.js");
const lifecycle = read("src/services/creator-lifecycle-authority-service.js");
const management = read("src/services/management-commit-authority-service.js");
const workflow = read("src/services/custom-content-workflow-service.js");
const telegramInbound = read("src/services/telegram-inbound-authority-service.js");
const creatorScope = read("src/services/creator-access-scope-authority-service.js");
const teamControl = read("src/services/team-control-plane-authority-service.js");
const teamAdministration = read("src/services/team-administration-service.js");


test("C2-A scope trigger fences only newly introduced Creator IDs in deterministic order", () => {
  assert.match(migration, /v_old_ids := "phase2_scope_creator_ids"\(OLD\."assignedCreators"\)/);
  assert.match(migration, /WHERE NOT \(x = ANY\(v_old_ids\)\)/);
  assert.match(migration, /array_agg\(x ORDER BY x\)/);
  assert.doesNotMatch(migration, /FOREACH[\s\S]*IN ARRAY v_new_ids/);
});


test("C2-B Telegram mutations own Creator FOR UPDATE before actor/member commit proof", () => {
  for (const source of [telegramContact, telegramIdentity]) {
    const creatorLock = source.indexOf("await lockCreatorPipelineLifecycle");
    const authority = source.indexOf("await assertManagementCommitAuthority");
    assert.ok(creatorLock >= 0 && authority > creatorLock);
    assert.match(source.slice(authority, authority + 500), /creatorRowsAlreadyLocked:\s*true/);
  }
});


test("C2-C Customs creator-scoped human authority converges on Agency -> Creator -> Member", () => {
  const agency = customAccess.indexOf("await lockAgencyPipelineLifecycle");
  const creator = customAccess.indexOf("await lockCreatorPipelineLifecycle", agency);
  const commit = customAccess.indexOf("await assertManagementCommitAuthority", creator);
  assert.ok(agency >= 0 && creator > agency && commit > creator);
  assert.match(customAccess.slice(commit, commit + 700), /creatorRowsAlreadyLocked:\s*true/);
  assert.doesNotMatch(customAccess, /SELECT "id" FROM "AgencyMember"[\s\S]*FOR SHARE/);
  const compatAgency = workflow.indexOf("await lockAgencyPipelineLifecycle", workflow.indexOf("resolveRetiredCreatorPendingCustomOrder"));
  const compatCreator = workflow.indexOf("await lockCreatorPipelineLifecycle", compatAgency);
  const compatMember = workflow.indexOf("await lockCurrentAgencyMember", compatCreator);
  assert.ok(compatAgency >= 0 && compatCreator > compatAgency && compatMember > compatCreator);
});


test("C2-C Telegram inbound manual assignment takes target Creator before actor Member authority", () => {
  const start = telegramInbound.indexOf('const assign = async (tx) => {');
  const end = telegramInbound.indexOf('const assigned = await runInboundReviewTransaction', start);
  assert.ok(start >= 0 && end > start);
  const branch = telegramInbound.slice(start, end);
  const target = branch.indexOf('const target = await tx.customOrder.findFirst');
  const creatorAuthority = branch.indexOf('await assertCustomManagementCreatorAccess', target);
  const projected = branch.indexOf('await createCustomContentSubmissionFromInboundEvent', creatorAuthority);
  const nestedAssignment = branch.indexOf('await assignCustomContentSubmission', projected);
  assert.ok(target >= 0 && creatorAuthority > target && projected > creatorAuthority && nestedAssignment > projected);
  assert.doesNotMatch(branch.slice(0, creatorAuthority), /lockCurrentAgencyMember/);
  assert.match(branch.slice(creatorAuthority, creatorAuthority + 500), /permissionKey:\s*"content\.review_customs"/);
});


test("C2 total order starts Agency lifecycle -> Team topology and preserves the checkpoint-13 advisory identity", () => {
  assert.match(teamControl, /phase2:creator-access-topology:/);
  const topologyFn = between(teamControl, "async function lockTeamControlPlaneTopology", "function normalizeCreatorIds");
  ordered(topologyFn, ["await assertTeamControlPlaneWriteAdmission(tx)", "await lockAgencyLifecycleBarrier", "await lockDbAdvisoryXact"], "Team topology prefix");
  assert.match(topologyFn, /mode:\s*"exclusive"/);

  const creatorFn = between(teamControl, "async function lockLiveTeamControlPlaneCreators", "module.exports");
  assert.match(teamControl, /filter\(Boolean\)[\s\S]{0,10}\.sort\(\)/);
  assert.match(creatorFn, /CreatorAccount[\s\S]*FOR SHARE/);
  assert.match(creatorFn, /deletedAt" IS NULL/);

  // Backward-compatible aliases must resolve to the same authority/key rather than
  // keeping a second Creator-scope-only serialization root alive.
  assert.match(creatorScope, /return teamControlPlaneTopologyLockKey\(agencyId\)/);
  assert.match(creatorScope, /return lockTeamControlPlaneTopology\(/);
});


test("C2 Creator retirement is Agency -> topology -> Creator -> actor proof -> Member cleanup", () => {
  const retire = between(lifecycle, "async function retireCreatorWithinTransaction", "module.exports");
  ordered(retire, [
    "if (!agencyAlreadyLocked) await lockAgencyPipelineLifecycle",
    "await lockTeamControlPlaneTopology",
    "await lockCreatorPipelineLifecycle",
    "await assertManagementCommitAuthority",
    "await retireCreatorCurrentAccess",
  ], "Creator retirement total order");
  assert.match(retire, /creatorRowsAlreadyLocked:\s*true/);
  assert.match(retire, /agencyAlreadyLocked:\s*true/);
});


test("C2 management authority acquires deterministic Creator rows before actor User/Member", () => {
  const commit = between(management, "async function assertManagementCommitAuthority", "module.exports");
  ordered(commit, ["await lockLiveTeamControlPlaneCreators", "await lockLiveActor"], "management Creator -> actor");
  assert.match(commit, /creatorRowsAlreadyLocked/);
  assert.match(teamControl, /Array\.from\(new Set\([\s\S]*\)\)\.sort\(\)/);
});


test("C2 all Team current-authority Member writers enter topology before role/creator/actor/member mutation", () => {
  const update = between(teamAdministration, "async function updateMemberSettings", "async function setMemberStatus");
  ordered(update, ["await lockTeamControlPlaneTopology", "await lockTeamRoleLifecycles", "await assertManagementCommitAuthority", "await tx.agencyMember.update"], "member settings role path");
  assert.match(update, /roleKeys:\s*\[memberRoleKey\(liveTarget\), liveNextRoleKey\]/);
  assert.match(update, /creatorIds:\s*creatorCommitIds/);
  assert.match(update, /agencyAlreadyLocked:\s*true/);

  const status = between(teamAdministration, "async function setMemberStatus", "async function removeMember");
  ordered(status, ["await lockTeamControlPlaneTopology", "await lockTeamRoleLifecycle", "await assertManagementCommitAuthority", "await tx.agencyMember.update"], "member status reactivation path");

  const removal = between(teamAdministration, "async function removeMember", "async function updateMemberAccessByPlatformAdmin");
  ordered(removal, ["await lockTeamControlPlaneTopology", "await assertManagementCommitAuthority", "await tx.agencyMember.update"], "member removal human path");
  assert.doesNotMatch(removal, /team-owner-safety:/);

  const platform = between(teamAdministration, "async function updateMemberAccessByPlatformAdmin", "async function materializeInvitationMemberWithinTransaction");
  ordered(platform, ["await lockTeamControlPlaneTopology", "await lockTeamRoleLifecycle", "FOR UPDATE", "await tx.agencyMember.update"], "platform admin role path");
});


test("C2 role current-authority writers are topology -> Role -> actor -> bulk Member epoch", () => {
  const sections = [
    between(teamAdministration, "async function setRoleAccess", "async function setRolePermission"),
    between(teamAdministration, "async function setRolePermission", "async function resetRole"),
    between(teamAdministration, "async function resetRole", "async function deleteCustomRole"),
  ];
  for (const [index, source] of sections.entries()) {
    ordered(source, [
      "await lockTeamControlPlaneTopology",
      "await lockTeamRoleLifecycle",
      "await assertManagementCommitAuthority",
      "await bumpLiveRoleMemberAccessEpochs",
    ], `role current-authority writer ${index}`);
    assert.match(source, /agencyAlreadyLocked:\s*true/);
  }
  const roleLocks = between(teamAdministration, "async function lockTeamRoleLifecycles", "async function bumpLiveRoleMemberAccessEpochs");
  assert.match(roleLocks, /filter\(Boolean\)[\s\S]{0,10}\.sort\(\)/);
});


test("C2 invitation claim/restore is topology -> Role -> Creator -> User/Member materialization", () => {
  for (const [label, source, startNeedle] of [
    ["authenticated claim", invitations, "const result = await prisma.$transaction"],
    ["registration claim", auth, "if (inviteToken) {"],
  ]) {
    const branch = source.slice(source.indexOf(startNeedle));
    ordered(branch, [
      "await lockTeamControlPlaneTopology",
      "await lockTeamRoleLifecycle",
      "await lockLiveTeamControlPlaneCreators",
      "await materializeInvitationMemberWithinTransaction",
    ], label);
    assert.match(branch, /agencyAlreadyLocked:\s*true/);
    assert.match(branch, /INVITE_CREATOR_SCOPE_STALE/);
  }
  const materialize = between(teamAdministration, "async function materializeInvitationMemberWithinTransaction", "function invitationUrl");
  ordered(materialize, ["FROM \"User\"", "FOR SHARE", "FROM \"AgencyMember\"", "FOR UPDATE", "agencyMember.findUnique"], "invitation materializer User -> Member");
  assert.match(materialize, /Caller must already hold the Team control-plane topology fence/);
});


test("C2 ordinary Creator-scoped business authorities do not acquire the Team topology mutex", () => {
  for (const [label, source] of [
    ["Custom management", customAccess],
    ["Telegram contact", telegramContact],
    ["Telegram identity", telegramIdentity],
    ["Telegram inbound", telegramInbound],
  ]) {
    assert.doesNotMatch(source, /team-control-plane-authority-service|lockTeamControlPlaneTopology/, `${label} must stay outside Agency-wide Team topology serialization`);
  }
});


test("C2-D admin Creator retirement joins Agency lifecycle before billing row lock", () => {
  const route = admin.slice(admin.indexOf('router.delete("/creators/:id"'));
  const agencyBarrier = route.indexOf("await lockAgencyPipelineLifecycle");
  const billing = route.indexOf("await lockAgencyBillingMutation");
  const retire = route.indexOf("await retireCreatorWithinTransaction");
  assert.ok(agencyBarrier >= 0 && billing > agencyBarrier && retire > billing);
  assert.match(route.slice(retire, retire + 900), /agencyAlreadyLocked:\s*true/);
  assert.match(lifecycle, /agencyAlreadyLocked = false/);
  assert.match(lifecycle, /if \(!agencyAlreadyLocked\) await lockAgencyPipelineLifecycle/);
});


test("C2 User disable remains cross-agency User -> Member and does not acquire per-Agency topology", () => {
  const route = admin.slice(admin.indexOf('router.patch("/users/:id"'));
  ordered(route, ['SELECT "id" FROM "User" WHERE "id"=$1 FOR UPDATE', 'UPDATE "AgencyMember"'], "User disable suffix");
  assert.doesNotMatch(route, /lockTeamControlPlaneTopology/);
});


test("C2 anti-map inventories every direct AgencyMember writer and keeps legacy epoch mutators unreachable", () => {
  const productionFiles = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.endsWith(".test.js")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".js")) productionFiles.push(full);
    }
  };
  walk(path.join(root, "src"));

  const writerPattern = /agencyMember\.(?:create|update|updateMany|delete|deleteMany|upsert)\s*\(|(?:UPDATE|INSERT INTO|DELETE FROM)\s+"AgencyMember"/;
  const writers = productionFiles
    .filter((file) => writerPattern.test(fs.readFileSync(file, "utf8")))
    .map((file) => path.relative(root, file).replaceAll(path.sep, "/"))
    .sort();
  assert.deepEqual(writers, [
    "src/routes/admin.js",                  // cross-Agency User lifecycle: User -> Member
    "src/routes/auth.js",                   // brand-new Agency + OWNER in one creating transaction
    "src/services/access-epoch-service.js", // legacy helpers; production bump callers forbidden below
    "src/services/creator-access-scope-authority-service.js", // Creator retirement under topology
    "src/services/team-administration-service.js",            // canonical Team topology writers
  ]);

  for (const file of productionFiles) {
    if (file.endsWith(`${path.sep}access-epoch-service.js`)) continue;
    const source = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(source, /\bbumpMemberAccessEpoch\b|\bbumpAgencyAccessEpoch\b/, `${path.relative(root, file)} must not revive legacy direct epoch writers`);
  }

  const register = between(auth, 'router.post("/register"', 'router.post("/login"');
  ordered(register, ["await tx.agency.create", "await tx.agencyMember.create"], "new Agency OWNER bootstrap");
});
