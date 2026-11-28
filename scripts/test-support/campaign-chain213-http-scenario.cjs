'use strict';
const assert = require('node:assert/strict');

// Uses the current Creator directory -> Numbers/Traffic product flow. The
// retained standalone scanner components have their own real React tests.
exports.runCampaignHttpScenario = async function runCampaignHttpScenario(f) {
  const { page, app, until, home, analytics, commands, traffic, overview, results, pass, calls,
    creatorId, providerReads, showTrafficSource, observeTrafficProgress } = f;
  const number = label => page.locator('.hq-number-row').filter({ has: page.getByText(label, { exact: true }) }).locator('.hq-number-value');
  const view = name => page.getByRole('navigation', { name: 'Creator analytics views', exact: true }).getByRole('button', { name, exact: true }).click();
  const choose = async name => {
    await page.getByRole('button', { name: 'View analytics for ' + name, exact: true }).click();
    await page.getByLabel('Analytics period', { exact: true }).selectOption('7d');
  };
  results.emptyHome = await home.getSummary({ rangeKey: '7d' });
  assert.equal(results.emptyHome.revenue.totalCents, null);
  await app('Analytics'); await choose('model_one');
  await until(async () => await number('Net earnings').textContent() === '—', 'Uncollected money must stay unknown');
  assert.equal((await overview()).campaigns.sourceCoverage.revenue.ready, false);
  pass('Actual current Creator Numbers UI preserves unknown money and unverified Campaign coverage before collection');

  await home.refresh({ rangeKey: '7d' }); f.startWorkers();
  await until(async () => {
    results.home = await home.getSummary({ rangeKey: '7d' });
    results.campaignScan = await analytics.getCampaignScan({ creatorId });
    return results.home.revenue.coverage.reportingCreators === 2 && results.campaignScan.collectorStatus === 'COMPLETE';
  }, 'Initial Financial and Campaign publication did not complete', 300000);
  await until(async () => {
    results.traffic = await traffic(); observeTrafficProgress('initial');
    return results.traffic.projection.ready && results.traffic.totals.sourceMembers === 52
      && results.traffic.totals.subscriptionRevenueCents === 1000;
  }, 'Initial Campaign/FanData/Notifications did not converge to Traffic', 600000);
  await until(async () => {
    results.campaigns = await analytics.getCampaignPage({ creatorId, rangeKey: '7d', limit: 100 });
    return results.campaigns.projection.ready && results.campaigns.totals.netCents === 3600;
  }, 'Campaign financial attribution did not converge', 120000);
  assert.equal(results.home.revenue.totalCents, 3600);
  assert.equal(results.campaigns.totals.memberships, 52); assert.equal(results.campaigns.totals.uniqueFans, 51);
  assert.equal(results.traffic.totals.sources, 51); assert.equal(results.traffic.totals.fanValueCents, 17000);
  assert.equal(results.traffic.totals.valuePendingMembers, 1);
  assert.equal(results.traffic.totals.valueSnapshotMembers + results.traffic.totals.valuePendingMembers, 51);
  assert.equal(results.lostCampaignProgress, true);
  assert.equal(providerReads.get(`${creatorId}:1:directory:0`), 1, 'Lost progress ACK must recover the accepted first directory page');
  pass('Actual worker and PostgreSQL: 51 sources, 52 memberships, 51 unique fans, exact financial attribution and recovered lost progress ACK');

  await until(async () => await number('Net earnings').textContent() === '$36.00', 'Published financial amount did not reach Numbers');
  await page.locator('.coa-main').filter({ hasText: 'Source 02' }).click();
  await page.locator('.coa-drop').getByText('@fan_21001', { exact: true }).waitFor();
  pass('Actual current Numbers page and Campaign accordion display exact earnings and the attributed paying fan');
  await view('Traffic');
  await until(async () => await page.getByRole('button', { name: 'Next sources', exact: true }).isEnabled(), 'Traffic first source page did not load');
  await page.getByRole('button', { name: 'Next sources', exact: true }).click();
  await until(async () => await page.getByRole('table', { name: 'Traffic sources' }).locator('tbody tr').count() === 1, 'Traffic second source page did not load');
  await page.getByRole('button', { name: 'Previous sources', exact: true }).click();
  await showTrafficSource('Source 01');
  await page.getByRole('button', { name: 'View fans from Source 01', exact: true }).click();
  await page.getByRole('button', { name: 'Next fans', exact: true }).click();
  await page.getByText('fan_21051', { exact: false }).last().waitFor();
  await page.getByText('Not available yet', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Previous fans', exact: true }).click();
  pass('Actual Traffic source/member pagination preserves shared-fan totals and explicit unknown lifetime spend');

  await page.getByRole('button', { name: 'Edit cost for Source 01', exact: true }).click();
  await page.getByLabel('Source cost', { exact: true }).fill('25.50');
  await page.getByRole('button', { name: 'Save cost', exact: true }).click();
  await until(async () => { results.cost = (await traffic()).sources.find(row => row.name === 'Source 01'); return results.cost?.costCents === 2550; }, 'Cost editor did not commit');
  assert.equal(results.cost.costRevision, 1);
  await page.getByRole('form', { name: 'Cost for Source 01', exact: true }).waitFor({ state: 'hidden' });
  await page.getByRole('table', { name: 'Traffic sources' }).locator('tr').filter({ hasText: 'Source 01' }).getByText('$25.50', { exact: true }).waitFor();
  pass('Actual Traffic cost editor commits one exact USD amount with its revision and refreshes the displayed source');

  await page.getByRole('button', { name: 'Edit cost for Source 01', exact: true }).click();
  await page.getByLabel('Source cost', { exact: true }).fill('26.75');
  await page.getByLabel('Cost currency', { exact: true }).fill('EUR'); f.loseNextCostReply();
  await page.getByRole('button', { name: 'Save cost', exact: true }).click();
  await page.getByRole('button', { name: 'Recover', exact: true }).click();
  await until(async () => commands.listPending().length === 0, 'Lost cost reply did not recover its durable receipt');
  results.recoveredCost = (await traffic()).sources.find(row => row.name === 'Source 01');
  assert.equal(results.recoveredCost.costCents, 2675); assert.equal(results.recoveredCost.currency, 'EUR');
  assert.equal(results.recoveredCost.costRevision, 2); assert.equal(results.lostCostReply, true);
  assert.equal(results.recoveredCost.roiPercent, null); assert.equal(results.recoveredCost.valueRoiPercent, null);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  pass('Lost command response recovers once, preserves EUR and does not invent ROI by mixing EUR cost with USD income');

  await page.getByLabel('Traffic revenue period').selectOption('prev_year');
  await until(async () => await page.locator('.traffic-metrics article').nth(1).locator('strong').textContent() === '$0.00', 'Traffic historical period did not change revenue');
  assert.equal(await page.locator('.traffic-metrics article').nth(2).locator('strong').textContent(), '$170.00');
  await page.getByLabel('Traffic revenue period').selectOption('30d'); await showTrafficSource('Source 01');
  pass('Traffic period changes subscription revenue while keeping lifetime fan spend separate');

  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; }), promise = new Promise(resolve => { release = resolve; });
  f.holdTrafficResponse({ enter, promise, range: '7d' });
  await page.getByLabel('Traffic revenue period').selectOption('7d');
  await Promise.race([entered, new Promise((_, reject) => setTimeout(() => reject(Error('Expected delayed Traffic read')), 10000))]);
  await page.getByRole('button', { name: '← Creators', exact: true }).click(); await choose('model_two'); await view('Traffic');
  await until(async () => (await page.getByRole('table', { name: 'Traffic sources' }).innerText()).includes('No traffic sources'), 'Empty second creator did not remain isolated');
  release();
  await page.evaluate(() => window.ActualAnalytics.refresh());
  assert.equal(await page.getByText('Source 01', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '← Creators', exact: true }).click(); await choose('model_one'); await view('Traffic');
  await showTrafficSource('Source 01');
  pass('A delayed response for the previous creator cannot populate the newly selected creator or retain its pagination');

  f.correctFinancial(); await view('Numbers');
  const before = calls.length;
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click(); f.wakeWorker();
  await until(async () => { results.correctedOverview = await overview(); return results.correctedOverview.finance.netCents === 5200; }, 'Current UI refresh did not publish the corrected financial fact', 180000);
  await until(async () => {
    results.correctedCampaigns = await analytics.getCampaignPage({ creatorId, rangeKey: '7d', limit: 100 });
    return results.correctedCampaigns.projection.ready && results.correctedCampaigns.totals.netCents === 5200;
  }, 'Campaign attribution did not follow canonical financial correction', 180000);
  await until(async () => await number('Net earnings').textContent() === '$52.00', 'Corrected financial amount did not reach the current React view');
  assert(calls.slice(before).some(call => call.method === 'creatorAnalytics.refreshCreator'));
  assert.equal(results.correctedOverview.finance.refundGrossCents, 0);
  assert.equal((await traffic()).totals.subscriptionRevenueCents, 1000);
  pass('Actual Refresh data correction converges to $52 in financial and Campaign views without changing the separate subscription-revenue total');

  await view('Traffic'); f.updateProviderCampaign();
  await page.getByRole('button', { name: 'Refresh data', exact: true }).click(); f.wakeWorker();
  await until(async () => {
    results.rescan = await traffic(); observeTrafficProgress('rescan');
    return results.rescan.projection.ready && results.rescan.sources.some(row => row.name === 'Source 01 refreshed');
  }, 'Traffic Update sources did not publish the changed provider source', 600000);
  const changed = results.rescan.sources.find(row => row.name === 'Source 01 refreshed');
  assert.equal(changed.costCents, 2675); assert.equal(changed.currency, 'EUR'); assert.equal(changed.costRevision, 2);
  assert.equal(results.rescan.totals.sourceMembers, 52); assert.equal(results.rescan.totals.fanValueCents, 17000);
  await f.reopenBackendAndWorker();
  results.afterRestart = await traffic(); assert.equal(results.afterRestart.totals.sourceMembers, 52);
  assert.equal(results.afterRestart.sources.find(row => row.name === 'Source 01 refreshed').costCents, 2675);
  await page.getByRole('button', { name: 'Refresh view', exact: true }).click();
  await showTrafficSource('Source 01 refreshed');
  await page.getByRole('table', { name: 'Traffic sources' }).locator('tr').filter({ hasText: 'Source 01 refreshed' }).getByText('€26.75', { exact: true }).waitFor();
  assert.deepEqual(f.errors, []); results.browserVersion = await f.browser.version();
  pass('Repeat provider collection preserves manual cost, source identity and exact totals; backend SIGKILL and SQLite reopen retain the actual UI');
};
