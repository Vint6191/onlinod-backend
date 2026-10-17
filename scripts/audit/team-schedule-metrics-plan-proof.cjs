"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { fixture, scope } = require("./analytics-traffic/fixture.cjs");
const alive = setInterval(() => {}, 1000);
const report = { ok: false, runtime: "isolated PGlite + real Prisma", cases: [], plans: [] };
function nodes(plan) { return [plan, ...(plan.Plans || []).flatMap(nodes)]; }
async function main() {
  const f = await fixture(), { db, root } = f;
  try {
    const s = await scope(db), memberId = "member-" + s.agencyId, hiddenId = "metrics-hidden-creator";
    const writers = require(path.join(root, "src/services/database-write-contract-service"));
    await db.$transaction(async tx => {
      await writers.authorizeCreatorAccountWrite(tx);
      await tx.creatorAccount.create({ data: { id: hiddenId, agencyId: s.agencyId, displayName: "Hidden", status: "READY" } });
    });
    const now = new Date(), ago = minutes => new Date(+now - minutes * 60000);
    const pastIds = Array.from({ length: 1001 }, (_, i) => "metrics-past-" + String(i).padStart(4, "0"));
    await db.teamShift.createMany({ data: [
      ...pastIds.map(id => ({ id, agencyId: s.agencyId, memberId, startsAt: ago(120), endsAt: ago(60) })),
      { id: "metrics-upcoming", agencyId: s.agencyId, memberId, startsAt: ago(-60), endsAt: ago(-120) },
      { id: "metrics-long-overlap", agencyId: s.agencyId, memberId, startsAt: ago(4 * 365 * 24 * 60), endsAt: ago(-30) },
    ] });
    await db.teamShiftCreator.createMany({ data: [...pastIds, "metrics-upcoming", "metrics-long-overlap"].flatMap(shiftId =>
      [s.creatorId, hiddenId].map(creatorId => ({ shiftId, creatorId, creatorRefId: creatorId }))) });
    const calls = [], pending = [];
    const watched = new Proxy(db, { get(target, key) {
      if (key === "$queryRawUnsafe") return (sql, ...args) => {
        const call = { sql, args, started: Date.now() }; calls.push(call);
        const promise = target.$queryRawUnsafe(sql, ...args).then(rows => { call.rows = rows.length; return rows; })
          .finally(() => { call.ms = Date.now() - call.started; });
        pending.push(promise); return promise;
      };
      const value = target[key]; return typeof value === "function" ? value.bind(target) : value;
    } });
    const build = require(path.join(root, "src/services/team-schedule-scale-read-service")).buildScheduleScaleRead;
    async function read(allowedCreatorIds) {
      try {
        return await build({ db: watched, agencyId: s.agencyId, authorityNow: now,
          queryRange: { startAt: ago(7 * 1440), endAt: now }, planningRange: { startAt: ago(7 * 1440), endAt: ago(-7 * 1440) },
          allowedCreatorIds, currentResponseGeneration: true,
          context: { members: [{ id: memberId, name: "Owner" }], creators: [s.creatorId, hiddenId].map(id => ({ id, name: id })) },
          includeCreatorWhere: { where: Array.isArray(allowedCreatorIds) ? { creatorRefId: { in: allowedCreatorIds } } : { creatorRefId: { not: null } }, include: { creator: true } },
        });
      } finally { await Promise.allSettled(pending); }
    }
    const empty = await read([s.creatorId]);
    assert.equal(empty.shifts.length, 1000); assert.equal(empty.summary.plannedShifts, 1003);
    assert.equal(empty.detailCoverage.complete, false);
    assert(empty.shifts.some(row => row.id === "metrics-upcoming"));
    assert(empty.shifts.some(row => row.id === "metrics-long-overlap"));
    assert(empty.shifts.every(row => row.responseSamples === 0 && row.actualPresenceSeconds === 0));
    const metrics = calls.find(call => call.sql.includes("resp AS MATERIALIZED"));
    assert(metrics, "The actual production metrics query must have executed");
    async function explain(sql, label) {
      const rows = await db.$queryRawUnsafe("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + sql, ...metrics.args);
      const plan = rows[0]["QUERY PLAN"][0], all = nodes(plan.Plan);
      const responseProbes = all.filter(row => row["Relation Name"] === "TeamResponseCaseCurrent")
        .reduce((sum, row) => sum + row["Actual Loops"], 0);
      report.plans.push({ label, responseProbes, plan });
      return responseProbes;
    }
    const before = await explain(metrics.sql.replaceAll(" AS MATERIALIZED (", " AS ("), "before_aggregate_boundary");
    const after = await explain(metrics.sql, "current_aggregate_boundary");
    assert(before >= 100000, "Cold-statistics fixture must expose the repeated aggregate execution");
    assert(after <= 2000, "Response probes must be bounded by the selected shifts, not their square");
    report.cases.push("Cold-statistics empty metrics: bounded 1000-row detail, exact summary, upcoming and long overlap retained; before/after EXPLAIN");

    await db.teamCoverageSession.createMany({ data: [
      { agencyId: s.agencyId, creatorId: s.creatorId, memberId, coverageId: "metrics-visible", startedAt: ago(115), endedAt: ago(105) },
      { agencyId: s.agencyId, creatorId: hiddenId, memberId, coverageId: "metrics-hidden", startedAt: ago(110), endedAt: ago(90) },
    ] });
    await db.teamResponseCase.createMany({ data: [s.creatorId, hiddenId].map((creatorId, i) => ({
      agencyId: s.agencyId, creatorId, memberId, dialogId: "metrics-dialog-" + i, replyMessageId: "metrics-reply-" + i,
      incomingAt: ago(115), lastIncomingAt: ago(115), replyAt: ago(100), wallClockSeconds: i ? 600 : 60,
      slaEligible: true, sla15Pass: !i, derivationVersion: "team_response_v2", projectionState: "FULL",
    })) });
    const scoped = await read([s.creatorId]), all = await read(null);
    const id = scoped.shifts.find(row => row.id.startsWith("metrics-past-")).id;
    const visible = scoped.shifts.find(row => row.id === id), whole = all.shifts.find(row => row.id === id);
    assert.equal(visible.actualPresenceSeconds, 600); assert.equal(whole.actualPresenceSeconds, 1500);
    assert.equal(visible.responseSamples, 1); assert.equal(whole.responseSamples, 2);
    assert.equal(visible.medianResponseSeconds, 60); assert.equal(whole.medianResponseSeconds, 330);
    assert.equal(visible.sla15Pct, 100); assert.equal(whole.sla15Pct, 50);
    assert.equal(scoped.summary.actualAgainstPlanSeconds, 1002 * 600);
    assert.equal(all.summary.actualAgainstPlanSeconds, 1002 * 1500);
    const summary = calls.findLast(call => call.sql.includes("FROM per_shift"));
    {
      const rows = await db.$queryRawUnsafe("EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + summary.sql, ...summary.args);
      const plan = rows[0]["QUERY PLAN"][0], allNodes = nodes(plan.Plan);
      const entry = { label: "summary_current_nonempty", windowRows: allNodes.filter(row => row["Node Type"] === "WindowAgg")
        .reduce((sum, row) => sum + row["Actual Rows"] * row["Actual Loops"], 0), plan };
      report.plans.push(entry);
      assert(entry.windowRows <= 10000, "Each summary coverage interval must be unioned once");
    }
    report.cases.push("Actor creator scope preserves coverage union, response counts, median, SLA and exact summary");

    await db.$transaction(async tx => {
      await writers.assertTeamControlPlaneWriteAdmission(tx);
      await tx.agencyMember.update({ where: { id: memberId }, data: { assignedCreators: [s.creatorId] } });
    });
    const memberScoped = await read(null);
    assert.equal(memberScoped.shifts.find(row => row.id === id).actualPresenceSeconds, 600);
    assert.equal(memberScoped.shifts.find(row => row.id === id).responseSamples, 1);
    assert.equal(memberScoped.summary.actualAgainstPlanSeconds, 1002 * 600);
    report.cases.push("Member creator scope still fences aggregate reads");

    await db.teamCoverageSession.createMany({ data: [
      { agencyId: s.agencyId, creatorId: s.creatorId, memberId, coverageId: "metrics-active", startedAt: ago(10) },
      { agencyId: s.agencyId, creatorId: s.creatorId, memberId, coverageId: "metrics-stale", startedAt: ago(15 * 60) },
    ] });
    const open = await read([s.creatorId]), creator = open.creators.find(row => row.creatorId === s.creatorId);
    assert.equal(creator.activeNow, true); assert.equal(creator.openSessions, 1); assert.equal(creator.staleOpenSessions, 1);
    assert.equal(open.summary.openSessions, 1); assert.equal(open.summary.staleOpenSessions, 1);
    assert.equal(open.shifts.find(row => row.id === "metrics-long-overlap").actualPresenceSeconds, 44400);
    const denied = await read([]);
    assert.equal(denied.shifts.length, 0); assert.equal(denied.summary.plannedShifts, 0); assert.equal(denied.summary.openSessions, 0);
    report.cases.push("Actual SQL counts one active open session, keeps the 12-hour stale cap, and denies empty actor scope");
    report.queryTimes = calls.map(call => ({ ms: call.ms, rows: call.rows, kind: call.sql.includes("resp AS MATERIALIZED") ? "metrics" : call.sql.includes("FROM per_shift") ? "summary" : "other" }));
    report.ok = true;
  } finally {
    await f.close();
    const output = path.resolve(process.env.ONLINOD_SQL_PROOF_OUTPUT || ".", "evidence/team-schedule-metrics-plan.json");
    fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ ...report, plans: report.plans.map(({ plan, ...rest }) => rest) }));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => clearInterval(alive));
