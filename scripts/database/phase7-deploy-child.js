'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 6 * 60 * 60 * 1000;

function stageTimeout(env = process.env) {
  const raw = env.PHASE7_DEPLOY_STAGE_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(raw)) throw new Error('PHASE7_DEPLOY_STAGE_TIMEOUT_INVALID');
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1000 || value > MAX_TIMEOUT_MS) {
    throw new Error('PHASE7_DEPLOY_STAGE_TIMEOUT_INVALID');
  }
  return value;
}

function stageName(args) {
  if (args[1] === 'migrate' && args[2] === 'deploy') return 'prisma:migrate:deploy';
  // Never put arbitrary arguments (which can contain secrets) in diagnostics.
  const mode = args.slice(1).find(arg => ['--create', '--activate', '--preflight'].includes(arg));
  return path.basename(args[0]) + (mode ? ':' + mode : '');
}

function runStage(args, {
  cwd, env = process.env, timeoutMs = stageTimeout(env), killGraceMs = 5000,
  heartbeatMs = 30000, signal, stdio = 'inherit',
  emit = value => console.log(JSON.stringify(value)),
} = {}) {
  if (!Array.isArray(args) || !args.length || args.some(x => typeof x !== 'string')) {
    return Promise.reject(new Error('PHASE7_DEPLOY_STAGE_ARGUMENT_INVALID'));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS
      || !Number.isSafeInteger(killGraceMs) || killGraceMs < 1
      || !Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1) {
    return Promise.reject(new Error('PHASE7_DEPLOY_STAGE_TIMEOUT_INVALID'));
  }
  const stage = stageName(args), started = performance.now();
  return new Promise((resolve, reject) => {
    let child, timer, escalation, heartbeat, stopped = null, settled = false;
    const elapsedMs = () => Math.round(performance.now() - started);
    const finish = (exitCode, exitSignal, spawnError) => {
      if (settled) return;
      settled = true;
      // The CLI may obey SIGTERM before an engine descendant does. Do not
      // cancel escalation while leaving that owned process group alive.
      if (stopped && child?.pid) kill('SIGKILL');
      clearTimeout(timer); clearTimeout(escalation); clearInterval(heartbeat);
      signal?.removeEventListener('abort', abort);
      const result = { stage, pid: child?.pid ?? null, elapsedMs: elapsedMs(), timeoutMs,
        exitCode, signal: exitSignal || null };
      if (!stopped && !spawnError && exitCode === 0) {
        emit({ event: 'PHASE7_DEPLOY_STAGE_PASS', ...result });
        resolve(result);
      } else {
        const reason = stopped || (spawnError ? 'spawn' : 'exit');
        const error = new Error(reason === 'timeout' ? 'PHASE7_DEPLOY_STAGE_TIMEOUT'
          : reason === 'interrupted' ? 'PHASE7_DEPLOY_INTERRUPTED' : 'PHASE7_DEPLOY_CHILD_FAILED');
        error.phase7Diagnostics = { event: 'PHASE7_DEPLOY_STAGE_FAILED', ...result, reason,
          ...(spawnError ? { spawnCode: spawnError.code || 'UNKNOWN' } : {}) };
        reject(error);
      }
    };
    const kill = kind => {
      if (!child?.pid) return;
      try {
        // Own process group only: terminate Prisma's engine as well as its CLI.
        if (process.platform !== 'win32') process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch (error) {
        if (error.code !== 'ESRCH') emit({ event: 'PHASE7_DEPLOY_STOP_ERROR', stage, signal: kind, code: error.code || 'UNKNOWN' });
      }
    };
    const stop = reason => {
      if (settled || stopped) return;
      stopped = reason;
      emit({ event: 'PHASE7_DEPLOY_STAGE_STOPPING', stage, pid: child?.pid ?? null, reason, elapsedMs: elapsedMs() });
      kill('SIGTERM');
      escalation = setTimeout(() => kill('SIGKILL'), killGraceMs);
    };
    const abort = () => stop('interrupted');
    if (signal?.aborted) { stopped = 'interrupted'; finish(null, null); return; }
    try {
      child = spawn(process.execPath, args, { cwd, env, stdio, detached: process.platform !== 'win32', windowsHide: true });
    } catch (error) { finish(null, null, error); return; }
    child.once('error', error => finish(null, null, error));
    // 'close' drains stdout/stderr; 'exit' can lose the final diagnostic lines.
    child.once('close', (code, exitSignal) => finish(code, exitSignal));
    emit({ event: 'PHASE7_DEPLOY_STAGE_START', stage, pid: child.pid ?? null, timeoutMs });
    timer = setTimeout(() => stop('timeout'), timeoutMs);
    heartbeat = setInterval(() => emit({ event: 'PHASE7_DEPLOY_STAGE_WAIT', stage, pid: child.pid ?? null, elapsedMs: elapsedMs(), timeoutMs }), heartbeatMs);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}

module.exports = { runStage, stageTimeout, stageName, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS };
