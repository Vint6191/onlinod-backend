'use strict';

const assert = require('node:assert/strict');
const { loadNotificationWorker } = require('./notification-chain212-fixture.cjs');
const { workerSession } = require('./notification-chain212-source-cases.cjs');

// Exercise the production Worker and BackendJobClient, including the FULL
// no-source terminal turn. Only HTTP transport enters the real PostgreSQL
// lease owners directly; the provider returns six explicit empty source pages.
async function runCompletionWorkerCases(h, check) {
  const desktop = await loadNotificationWorker(h.desktopRoot);
  try {
    for (const lostTerminalReply of [false, true]) {
      await check(`Actual FULL worker completes through terminal renewal${lostTerminalReply ? ' after lost ACK, restart and late heartbeat' : ''}`, async () => {
        const scope = await h.scope('actual_full_worker_terminal_' + lostTerminalReply);
        const run = await h.start(scope, { forceFull: true });
        const worker = workerSession(h, desktop, run, async () => ({ list: [], hasMore: false }));
        for (let i = 0; i < 6; i++) assert.equal((await worker.execute()).outcome, 'continue');
        const before = await h.jobRow(run);
        assert.equal(await h.db.creatorNotificationFrontierPage.count({ where: { creatorId: scope.creatorId } }), 6);
        assert.equal(before.continuation.driverPhase, 'execute');
        assert.equal(before.continuation.jobContinuation.sourceExhausted, true);
        assert.equal(before.continuation.jobContinuation.allSourceExhausted, true);
        const renew = h.lease.renewLease;
        let dropped = false;
        if (lostTerminalReply) h.lease.renewLease = async input => {
          const result = await renew(input);
          if (!dropped && input.continuation?.driverPhase === 'complete') {
            dropped = true;
            throw Object.assign(Error('LOST_ACTUAL_WORKER_TERMINAL_RENEW_ACK'), { status: 503 });
          }
          return result;
        };
        let outcome;
        try {
          if (lostTerminalReply) {
            await assert.rejects(worker.execute(), /LOST_ACTUAL_WORKER_TERMINAL_RENEW_ACK/);
            const accepted = await h.jobRow(run);
            assert.equal(accepted.continuation.driverPhase, 'complete');
            assert.deepEqual(accepted.continuation.result.events, []);
            const late = await renew({ ...run.credentials, continuation: before.continuation, progress: { percent: 0 } });
            assert.deepEqual(late.continuation, accepted.continuation);
            assert.deepEqual(late.progress, accepted.progress);
            assert.deepEqual((await h.jobRow(run)).continuation, accepted.continuation);
            worker.replace(before.continuation);
          }
          outcome = await worker.execute();
        } finally { h.lease.renewLease = renew; }
        assert.equal(outcome.outcome, 'complete');
        const saved = await h.jobRow(run), state = (await h.scopeState(scope)).state;
        assert.equal(saved.status, 'DONE'); assert.equal(state.status, 'COMPLETE');
        assert.equal(worker.provider.length, 6, 'Completion/restart must not read another provider page');
        assert.equal(await h.db.creatorNotificationFrontierPage.count({ where: { creatorId: scope.creatorId } }), 6);
        assert.equal(await h.db.creatorTip.count({ where: { creatorId: scope.creatorId } }), 0);
        return { providerReads: worker.provider.length, jobStatus: saved.status, stateStatus: state.status,
          lostTerminalReply: dropped, wire: worker.wire };
      });
    }
  } finally { desktop.close(); }
}

module.exports = { runCompletionWorkerCases };
