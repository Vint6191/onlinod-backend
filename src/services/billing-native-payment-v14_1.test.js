const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('V14.2 hosted payment browser supersedes the rejected V14.1 native top-up runtime', () => {
  const root = path.resolve(__dirname, '..');
  const route = fs.readFileSync(path.join(root, 'routes', 'billing.js'), 'utf8');
  const service = fs.readFileSync(path.join(__dirname, 'billing-nowpayments-service.js'), 'utf8');
  assert.match(route, /createWalletTopUpCheckout/);
  assert.match(route, /router\.post\("\/wallet\/top-up"/);
  assert.doesNotMatch(route, /wallet\/top-up\/currencies|createWalletTopUpPayment|mode:\s*"native"/);
  assert.match(service, /async function createWalletTopUpCheckout/);
  assert.match(service, /nowPaymentsRequest\("\/invoice",\s*\{ method:\s*"POST", body \}\)/);
  assert.doesNotMatch(service, /BILLING_HOSTED_WALLET_TOP_UP_RETIRED|createWalletTopUpPayment|availablePaymentCurrencies/);
});
