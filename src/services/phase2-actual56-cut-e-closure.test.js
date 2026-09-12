"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(root, rel), "utf8");
const slice = (source, from, to) => {
  const a = source.indexOf(from);
  const b = source.indexOf(to, a + from.length);
  assert.ok(a >= 0 && b > a, `missing source slice ${from}`);
  return source.slice(a, b);
};

const migration = read("../prisma/migrations/20260911213000_phase2_actual56_cut_e_lifecycle_access_authority/migration.sql");

test("F56-09/F56-10 creator retirement uses indexed inverse scope and one commit fence", () => {
  const creators = read("routes/creators.js");
  const lifecycle = read("services/creator-lifecycle-authority-service.js");
  const scope = read("services/creator-access-scope-authority-service.js");
  const management = read("services/management-commit-authority-service.js");
  const teamControl = read("services/team-control-plane-authority-service.js");
  const removal = slice(creators, 'router.delete("/:id"', 'router.post("/:id/complete-connection"');

  assert.match(removal, /retireCreatorWithinTransaction/);
  assert.doesNotMatch(removal, /scanRowsById|agencyMember\.findMany|agencyInvitation\.findMany/);
  assert.match(scope, /AgencyMember[\s\S]*phase2_remove_creator_from_access_scope/);
  assert.match(scope, /AgencyInvitation[\s\S]*phase2_remove_creator_from_access_scope/);
  assert.match(scope, /FROM "AgencyMember"[\s\S]*ORDER BY m\."id"[\s\S]*FOR UPDATE[\s\S]*UPDATE "AgencyMember"/);
  assert.match(scope, /FROM "AgencyInvitation"[\s\S]*ORDER BY i\."id"[\s\S]*FOR UPDATE[\s\S]*UPDATE "AgencyInvitation"/);
  assert.match(migration, /AgencyMember_live_assignedCreators_gin_idx/);
  assert.match(migration, /AgencyInvitation_pending_assignedCreators_gin_idx/);
  assert.match(migration, /AgencyMember_phase2_creator_scope_fence/);
  assert.match(migration, /AgencyInvitation_phase2_creator_scope_fence/);
  assert.match(migration, /phase2_fence_creator_access_scope[\s\S]*deletedAt" IS NULL[\s\S]*FOR SHARE/);
  assert.match(management, /lockLiveTeamControlPlaneCreators/);
  assert.match(teamControl, /CreatorAccount[\s\S]*FOR SHARE/);
  assert.match(teamControl, /normalizeCreatorIds[\s\S]*\.sort\(\)/);
  assert.match(removal, /managementActorMember:\s*req\.auth\.membership/);
  assert.match(lifecycle, /assertManagementCommitAuthority\([\s\S]*creatorRowsAlreadyLocked:\s*true/);
  assert.match(lifecycle, /retireCreatorCurrentAccess/);
  assert.match(lifecycle, /teamShiftCreator\.updateMany/);
});

test("F56-11 platform admin member lifecycle/access delegates to Team authority and preserves history", () => {
  const admin = read("routes/admin.js");
  const team = read("services/team-administration-service.js");
  const deletion = slice(admin, 'router.delete("/members/:memberId"', '// ════════════════════════════════════════════════════════════\n// USERS');
  const role = slice(admin, 'router.patch("/members/:memberId/role"', 'const memberPermsSchema');
  const perms = slice(admin, 'router.patch("/members/:memberId/permissions"', 'router.delete("/members/:memberId"');

  assert.match(deletion, /removeTeamMember/);
  assert.match(deletion, /platformAdmin:\s*true/);
  assert.doesNotMatch(deletion, /agencyMember\.delete/);
  assert.match(role, /updateMemberAccessByPlatformAdmin/);
  assert.match(perms, /updateMemberAccessByPlatformAdmin/);
  assert.match(team, /lockTeamControlPlaneTopology/);
  assert.doesNotMatch(team, /team-owner-safety:/);
  assert.match(team, /assertOwnerSafety\([\s\S]*removing:\s*true/);
  assert.match(team, /deletedAt, deactivatedAt: deletedAt, accessEpoch: \{ increment: 1 \}/);
  assert.match(team, /historicalAttributionPreserved:\s*true/);
});

test("F56-12 all Creator removal entry points converge on CreatorLifecycleAuthority", () => {
  const admin = read("routes/admin.js");
  const destructive = read("services/phase2-destructive-delete-authority-service.js");
  assert.match(admin, /retireCreatorWithinTransaction\([\s\S]*mode: hard \? "HARD" : "SOFT"/);
  assert.match(destructive, /ensureAgencyCreatorCleanupBatch[\s\S]*retireCreatorWithinTransaction/);
  assert.doesNotMatch(destructive, /ensureAgencyCreatorCleanupBatch[\s\S]{0,1800}creatorAccount\.update\(\{ where: \{ id: creatorId \}, data: \{ deletedAt/);
});

test("F56-06/F56-07 Team current reads consume live Creator Member User and access scope", () => {
  const schedule = read("services/team-schedule-service.js");
  const scale = read("services/team-schedule-scale-read-service.js");
  const pending = read("services/team-pending-read-service.js");
  const admin = read("routes/admin.js");

  assert.match(schedule, /creatorRefId/);
  assert.match(schedule, /user:\s*\{ is:\s*\{ disabledAt:\s*null \} \}/);
  assert.match(scale, /CreatorAccount[\s\S]*deletedAt" IS NULL/);
  assert.match(scale, /AgencyMember[\s\S]*deactivatedAt" IS NULL/);
  assert.match(scale, /User[\s\S]*disabledAt" IS NULL/);
  assert.match(scale, /phase2_scope_allows_creator/);
  assert.match(schedule, /memberAllowsCurrentCreator/);
  assert.match(schedule, /filterShiftCurrentCreatorLinks/);
  assert.match(pending, /creator:\s*\{ is:\s*\{ deletedAt:\s*null \} \}/);
  assert.match(pending, /OPERATIONAL_OWNER_INELIGIBLE/);
  const operationalMigration = read("../prisma/migrations/20260912003000_phase2_actual56_operational_pending_authority/migration.sql");
  assert.match(operationalMigration, /phase2_scope_allows_creator/);
  assert.match(pending, /TeamOperationalPendingCurrent/);
  assert.match(admin, /UPDATE "AgencyMember"[\s\S]*"accessEpoch"="accessEpoch"\+1/);
  assert.match(admin, /SELECT "id" FROM "User" WHERE "id"=\$1 FOR UPDATE/);
});

test("F56-05/F56-08 destructive internal authority is explicit and narrow", () => {
  const worker = read("services/phase2-destructive-delete-authority-service.js");
  assert.match(worker, /set_config\('onlinod\.phase2_destructive_agency_id'/);
  assert.match(worker, /set_config\('onlinod\.phase2_destructive_creator_id'/);
  assert.match(migration, /phase2_internal_agency_destructive_authorized/);
  assert.match(migration, /phase2_internal_creator_destructive_authorized/);
  assert.match(migration, /phase2_assert_agency_destructive_mutation_allowed/);
  assert.match(migration, /phase2_assert_creator_destructive_insert_allowed/);
  const intent = slice(migration, 'CREATE OR REPLACE FUNCTION "phase2_intent_domain_work_trigger"', 'CREATE OR REPLACE FUNCTION "phase2_submission_domain_work_trigger"');
  assert.match(intent, /TG_OP='DELETE'[\s\S]*phase2_internal_creator_destructive_authorized[\s\S]*RETURN OLD/);
  const submission = migration.slice(migration.indexOf('CREATE OR REPLACE FUNCTION "phase2_submission_domain_work_trigger"'));
  assert.match(submission, /TG_OP='DELETE'[\s\S]*phase2_internal_creator_destructive_authorized[\s\S]*RETURN OLD/);
  assert.doesNotMatch(migration, /session_replication_role|DISABLE TRIGGER/);
});

test("operational Pending ownership rejects disabled/deactivated/out-of-scope members", () => {
  const pending = read("services/team-pending-read-service.js");
  const fn = slice(pending, "function memberHasCurrentCreatorAccess", "async function operationalOwnerMapForRows");
  assert.match(fn, /member\.deletedAt \|\| member\.deactivatedAt \|\| member\.user\?\.disabledAt/);
  assert.match(fn, /normalizeAssignedCreators\(member\.assignedCreators\)/);
  assert.match(fn, /normalized\.mode === \"all\"/);
  assert.match(fn, /normalized\.creatorIds\.map\(String\)\.includes\(String\(creatorId \|\| \"\"\)\)/);
});



test("invitation restore uses canonical MemberLifecycleAuthority with live User and serialized membership row", () => {
  const invitations = read("routes/invitations.js");
  const auth = read("routes/auth.js");
  const team = read("services/team-administration-service.js");
  assert.match(invitations, /lockTeamControlPlaneTopology\(\{ tx, agencyId: currentInvite\.agencyId[\s\S]*lockTeamRoleLifecycle\(\{ tx, agencyId: currentInvite\.agencyId[\s\S]*lockLiveTeamControlPlaneCreators\([\s\S]*materializeInvitationMemberWithinTransaction\(\{/);
  assert.match(auth, /lockTeamControlPlaneTopology\(\{ tx, agencyId: inv\.agencyId[\s\S]*lockTeamRoleLifecycle\(\{ tx, agencyId: inv\.agencyId[\s\S]*lockLiveTeamControlPlaneCreators\([\s\S]*materializeInvitationMemberWithinTransaction\(\{/);
  const helper = slice(team, "async function materializeInvitationMemberWithinTransaction", "function invitationUrl");
  assert.match(helper, /FROM "User"[\s\S]*"disabledAt" IS NULL FOR SHARE/);
  assert.match(helper, /FROM "AgencyMember"[\s\S]*FOR UPDATE/);
  assert.match(helper, /existing && !existing\.deletedAt/);
  assert.match(helper, /MEMBER_DEACTIVATED/);
  assert.match(helper, /deletedAt: null,[\s\S]*deactivatedAt: null,[\s\S]*accessEpoch: \{ increment: 1 \}/);
});

test("CUT E migration repairs legacy dead creator scope and soft-retired schedule edges", () => {
  assert.match(migration, /phase2_filter_live_creator_scope/);
  assert.match(migration, /UPDATE "AgencyMember"[\s\S]*"accessEpoch"=m\."accessEpoch"\+1/);
  assert.match(migration, /SELECT i\."id", "phase2_filter_live_creator_scope"[\s\S]*FROM "AgencyInvitation"[\s\S]*UPDATE "AgencyInvitation"/);
  assert.match(migration, /UPDATE "TeamShiftCreator"[\s\S]*SET "creatorRefId"=NULL[\s\S]*"deletedAt" IS NULL/);
});

test("current Schedule defensively joins live Creator even before legacy repair convergence", () => {
  const schedule = read("services/team-schedule-service.js");
  const scale = read("services/team-schedule-scale-read-service.js");
  assert.match(schedule, /where\.creators = \{ some: \{ creatorRefId:[\s\S]*creator: \{ is: \{ deletedAt: null \} \}/);
  assert.match(schedule, /includeCreatorWhere[\s\S]*creatorRefId[\s\S]*creator: \{ is: \{ deletedAt: null \} \}/);
  assert.match(schedule, /teamCoverageSession[\s\S]*creator: \{ is: \{ deletedAt: null \} \}[\s\S]*member: \{ is: \{ deletedAt: null, deactivatedAt: null/);
  assert.match(scale, /JOIN "CreatorAccount" ca ON ca\."id"=sc\."creatorRefId"[\s\S]*ca\."deletedAt" IS NULL/);
  assert.match(scale, /JOIN "CreatorAccount" ca0 ON ca0\."id"=sc0\."creatorRefId"[\s\S]*ca0\."deletedAt" IS NULL/);
});
