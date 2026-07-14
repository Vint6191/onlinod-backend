"use strict";

const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");
const exists = (relative) => fs.existsSync(path.join(root, relative));
const checks = [];
const check = (name, ok) => checks.push({ name, ok: Boolean(ok) });

const schema = read("prisma/schema.prisma");
const jobs = read("src/routes/jobs.js");
const stats = read("src/routes/stats.js");
const lease = read("src/services/job-lease-service.js");
const scheduler = read("src/services/job-scheduler.js");
const traffic = read("src/services/traffic-service.js");
const catalog = read("src/services/job-catalog.js");

for (const field of ["idempotencyKey", "leaseTokenHash", "leaseRevision", "workId", "continuation", "progress", "lastProgressAt"]) {
  check(`JobInstance.${field}`, schema.includes(field));
}
check('idempotency key is database-unique', /idempotencyKey\s+String\?\s+@unique/.test(schema));
check('migration exists', exists('prisma/migrations/20260714170000_p9_job_leases/migration.sql'));
const migration = read('prisma/migrations/20260714170000_p9_job_leases/migration.sql');
check('migration creates unique idempotency index', migration.includes('CREATE UNIQUE INDEX') && migration.includes('JobInstance_idempotencyKey_key'));
check('claim requires capabilities', jobs.includes('jobKeys: z.array') && lease.includes('jobKey: { in: allowedJobKeys }'));
check('server catalog limits desktop claim keys', ['fetch_earnings','fetch_campaigns','traffic_sources_scan','catchup_notifications_scan'].every((key) => catalog.includes(key)) && lease.includes('filterClaimableDesktopJobKeys'));
check('claim requires fresh READY device binding', lease.includes('lastSeenAt: { gte: freshAfter }') && lease.includes('return bindings.map'));
check('release route is fenced', jobs.includes('/:id/release') && lease.includes('async function releaseJob') && lease.includes('leaseRevision'));
check('expired lease sweep is bulk and bounded', lease.includes('attempts: { increment: 1 }') && !lease.includes('Promise.all(expired.map'));
check('lease revision is required by mutations', jobs.includes('leaseRevisionSchema') && lease.includes('JOB_LEASE_REVISION_STALE'));
check('lease mutations revalidate agency access', lease.includes('DEVICE_AGENCY_ACCESS_REVOKED') && lease.includes('JOB_DEVICE_AGENCY_MISMATCH'));
check('lease token comparison is timing-safe', lease.includes('timingSafeEqual'));
check('failure side effect runs after fenced transition', lease.indexOf('recordJobFailure({ job') > lease.indexOf('Job lease changed before failure report'));
check('manual refresh never resets claimed jobs', scheduler.includes('status: { not: "CLAIMED" }') && scheduler.includes('reason: "already_claimed"'));
check('stats refresh uses central scheduler', stats.includes('scheduleJobNow') && !stats.includes('jobInstance.upsert'));

check('lease token is hashed', lease.includes('createHash("sha256")') && schema.includes('leaseTokenHash'));
check('renew/progress/complete/release/fail routes exist', ['/lease/renew','/:id/progress','/:id/complete','/:id/release','/:id/fail'].every((fragment) => jobs.includes(fragment)));
check('legacy report is fenced', jobs.includes('Compatibility endpoint') && jobs.includes('leaseToken: body.leaseToken'));
check('stats cannot complete jobs', !stats.includes('input.jobId') && !stats.includes('status: "DONE"'));
check('result application is centralized', lease.includes('applyJobResult') && exists('src/services/job-result-service.js'));
check('scheduler assigns idempotency key', scheduler.includes('buildJobIdempotencyKey') && scheduler.includes('idempotencyKey,'));
check('traffic discovery does not hydrate fan values', scheduler.includes('hydrateFanValues: false') && scheduler.includes('hydrateLimit: 0'));
check('fan-value refresh uses separate future key', traffic.includes('TRAFFIC_VALUE_REFRESH_JOB_KEY = "traffic_fan_value_refresh"'));
check('catchup does not spawn hidden hydration', !read('src/services/team-observation-service.js').includes('scheduleTrafficValueRefresh'));
check('claim only returns creator-scoped jobs', lease.includes('creatorId: { in: creatorIds }'));
check('lease writes are conditionally fenced', (lease.match(/leaseTokenHash: hashToken\(leaseToken\)/g) || []).length >= 2);

for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}`);
const failed = checks.filter((item) => !item.ok);
console.log(`P9 backend audit: ${checks.length - failed.length}/${checks.length} passed`);
if (failed.length) process.exitCode = 1;
