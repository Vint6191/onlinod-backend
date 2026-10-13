const test = require('node:test');
const assert = require('node:assert/strict');
const email = require('./email-service');
const retention = require('./retention-policy-definition');

function env(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  function apply(values) { for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value; }
  apply(values); t.after(() => apply(saved));
}

test('NOD authentication mail keeps the configured links and verified sender address', t => {
  env(t, { EMAIL_FROM: 'Onlinod <onlinod@sender.example.test>', APP_URL: 'https://current.example.test' });
  for (const payload of [email.verificationPayload({ email: 'fixture@example.test', token: 'fixture-token', code: '123456' }), email.passwordResetPayload({ email: 'fixture@example.test', token: 'fixture-token' })]) {
    assert.equal(payload.from, 'NOD <onlinod@sender.example.test>');
    assert.match(payload.subject, /NOD/);
    assert.match(payload.text, /https:\/\/current\.example\.test\/(verify-email|reset-password)\?token=fixture-token/);
    assert.doesNotMatch(payload.subject + payload.text + payload.html, /onlinod/i);
  }
});

test('NOD preserves custom sender names and bare addresses', t => {
  env(t, { EMAIL_FROM: 'Studio <mail@sender.example.test>' });
  assert.equal(email.getFrom(), 'Studio <mail@sender.example.test>');
  process.env.EMAIL_FROM = 'onlinod@sender.example.test';
  assert.equal(email.getFrom(), 'onlinod@sender.example.test');
  delete process.env.EMAIL_FROM;
  assert.equal(email.getFrom(), 'NOD <onboarding@resend.dev>');
});

test('NOD retention configuration preserves previously configured cleanup boundaries', t => {
  env(t, { NOD_AUDIT_LOG_DAYS: undefined, ONLINOD_AUDIT_LOG_DAYS: '541' });
  assert.equal(retention.defaultRetentionSettings().auditLogDays, 541);
  process.env.NOD_AUDIT_LOG_DAYS = '730';
  assert.equal(retention.defaultRetentionSettings().auditLogDays, 730);
});
