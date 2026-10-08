'use strict';

// Cancellation is cooperative for parent-side SQL. Never abandon a pending
// mutation with Promise.race: observe its outcome, retain resource ownership,
// then refuse the next step. Cleanup deliberately remains non-cancellable.
function checkInterrupted(signal, phase, code = 'PHASE7_DEPLOY_INTERRUPTED') {
  if (!signal?.aborted) return;
  const terminationSignal = ['SIGINT', 'SIGTERM'].includes(signal.reason) ? signal.reason : null;
  const error = Object.assign(new Error(code), { code });
  error.phase7Diagnostics = { event: code, phase, signal: terminationSignal };
  throw error;
}

function processInterrupts(code = 'PHASE7_DEPLOY_INTERRUPTED') {
  const controller = new AbortController();
  const onInt = () => controller.abort('SIGINT');
  const onTerm = () => controller.abort('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  return {
    signal: controller.signal,
    check: phase => checkInterrupted(controller.signal, phase, code),
    exitCode: () => controller.signal.reason === 'SIGINT' ? 130 : controller.signal.reason === 'SIGTERM' ? 143 : 1,
    dispose() { process.removeListener('SIGINT', onInt); process.removeListener('SIGTERM', onTerm); },
  };
}

async function disconnectAll(clients) {
  return completeCleanup([...new Set(clients.filter(Boolean))].map(client => () => client.$disconnect()));
}

async function completeCleanup(actions) {
  const results = await Promise.allSettled(actions.map(action => Promise.resolve().then(action)));
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw Object.assign(new AggregateError(errors, 'PHASE7_CLEANUP_FAILED'), { code: 'PHASE7_CLEANUP_FAILED' });
}

function retainFailure(primary, cleanupError) {
  if (!primary) return cleanupError;
  primary.cleanupErrors = [...(primary.cleanupErrors || []), cleanupError];
  return primary;
}

module.exports = { checkInterrupted, processInterrupts, disconnectAll, completeCleanup, retainFailure };
