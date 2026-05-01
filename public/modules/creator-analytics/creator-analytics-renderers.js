(function () {
  "use strict";

  const U = window.OnlinodCreatorAnalyticsUtils;
  const S = window.OnlinodCreatorAnalyticsState;

  // Permission helper. Pulls helpers.can from ctx (set up by
  // app-admin.js renderAdminPanel). Falls open when missing.
  function can(ctx, permKey) {
    return ctx.helpers?.can ? ctx.helpers.can(permKey) : true;
  }

  // Returns true if viewer is allowed to see dollar amounts on this
  // page. When false, every money rendering helper below masks $$$
  // values into "—" so chatters/analysts who lack money.view_earnings
  // don't get accidental leaks through metric cards or row totals.
  function canSeeMoney(ctx) {
    return can(ctx, "money.view_earnings");
  }

  function formatMoney(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return "$0";
    return `$${n.toFixed(2)}`;
  }

  // Money-aware version of formatMoney. When viewer lacks money perm,
  // returns a dash instead of a number so the layout doesn't shift
  // and they don't see what others earn.
  function formatMoneyMasked(ctx, value) {
    if (!canSeeMoney(ctx)) return "—";
    return formatMoney(value);
  }

  function formatSignedPercent(value) {
    const n = Number(value || 0);
    if (!Number.isFinite(n)) return "0%";
    const prefix = n > 0 ? "+" : "";
    return `${prefix}${n.toFixed(1)}%`;
  }

  function h(ctx, value) {
    return U.h(ctx, value);
  }

  function a(ctx, value) {
    return U.a(ctx, value);
  }

  function getReady(ctx) {
    return U.getReady(ctx);
  }

  function getProblems(ctx) {
    return U.getProblems(ctx);
  }

  function sumField(list, field) {
    return list.reduce((acc, item) => acc + Number(item?.[field] || 0), 0);
  }

  function getNumbersEntry(ctx, account, range = null) {
    return S.getNumbersState?.(
      ctx,
      account?.id,
      range || S.getRange?.(ctx) || "7d"
    ) || null;
  }

  function getNumbersSummary(ctx, account, range = null) {
    return getNumbersEntry(ctx, account, range)?.data?.summary || null;
  }

  function getNumbersRaw(ctx, account, range = null) {
    return getNumbersEntry(ctx, account, range)?.data?.raw || null;
  }

  function accountName(ctx, account) {
    if (ctx.helpers?.accountPublicName) {
      return ctx.helpers.accountPublicName(account);
    }

    return (
      account.displayName ||
      account.name ||
      account.username ||
      "Account"
    );
  }

  function accountUsernameLine(ctx, account) {
    if (ctx.helpers?.accountUsernameLine) {
      return ctx.helpers.accountUsernameLine(account);
    }

    const parts = [];
    if (account.username) parts.push(`@${account.username}`);
    if (account.remoteId) parts.push(`ID ${account.remoteId}`);
    return parts.join(" · ");
  }

  function accountAvatar(ctx, account, className) {
    if (ctx.helpers?.accountCardAvatarHtml) {
      return ctx.helpers.accountCardAvatarHtml(account, className);
    }

    const avatar =
      account.avatar ||
      account.avatarThumb ||
      account.avatarThumbs?.c144 ||
      account.avatarThumbs?.c50 ||
      "";

    const initial =
      String(accountName(ctx, account)).trim().slice(0, 1).toUpperCase() || "A";

    if (avatar) {
      return `<img class="${className}" src="${a(ctx, avatar)}" alt="">`;
    }

    return `<div class="${className} fallback">${h(ctx, initial)}</div>`;
  }

  function statusLabel(ctx, account) {
    if (ctx.helpers?.accountStatusLabel) {
      return ctx.helpers.accountStatusLabel(account);
    }

    if (account.status === "ready") return "READY";
    if (account.status === "checking") return "CHECKING";
    if (account.status === "not_creator") return "NOT CREATOR";
    if (account.status === "auth_failed") return "AUTH FAILED";
    return "WAIT LOGIN";
  }

  function getSelectedCreator(ctx, ready) {
    const selectedId = S.getSelectedCreatorId(ctx);
    if (!selectedId) return null;

    return ready.find((account) => String(account.id) === String(selectedId)) || null;
  }

  function getActiveRangeLabel(ctx) {
    const key = S.getRange ? S.getRange(ctx) : "7d";
    const item = (window.OnlinodCreatorAnalyticsConstants?.RANGES || []).find(
      (x) => x.key === key
    );
    return item?.label || "prev 7d";
  }

  function getOverviewEarningsStats(ctx, ready) {
    let total = 0;
    let loadedCount = 0;
    let loadingCount = 0;
    let errorCount = 0;

    for (const account of ready) {
      const entry = getNumbersEntry(ctx, account);

      if (entry?.loading) {
        loadingCount += 1;
      }

      if (entry?.error) {
        errorCount += 1;
      }

      if (entry?.loaded && entry?.data?.summary) {
        loadedCount += 1;
        total += Number(entry.data.summary.total || 0);
      }
    }

    return {
      total,
      loadedCount,
      loadingCount,
      errorCount,
      allLoaded: ready.length > 0 && loadedCount === ready.length,
    };
  }

  function pickNumericValue(item) {
    if (item === null || item === undefined) return null;

    if (typeof item === "number") {
      return Number.isFinite(item) ? item : null;
    }

    if (typeof item === "string") {
      const n = Number(item);
      return Number.isFinite(n) ? n : null;
    }

    if (Array.isArray(item)) {
      // [date, amount] or [timestamp, value] tuples → take last finite number
      for (let i = item.length - 1; i >= 0; i -= 1) {
        const n = Number(item[i]);
        if (Number.isFinite(n)) return n;
      }
      return null;
    }

    if (typeof item === "object") {
      const candidates = [
        item.amount,
        item.total,
        item.sum,
        item.value,
        item.net,
        item.gross,
        item.earnings,
        item.price,
        item.count,
        item.y,
        item.v,
      ];

      for (const candidate of candidates) {
        const n = Number(candidate);
        if (Number.isFinite(n)) return n;
      }
    }

    return null;
  }

  function extractTrendPointsFromArray(list) {
    if (!Array.isArray(list) || !list.length) return [];

    const points = list
      .map((item) => pickNumericValue(item))
      .filter((n) => Number.isFinite(n));

    return points;
  }

  // Well-known places where OF-style chart data can live.
  // Try these in order; fall back to deep scan if none match.
  function extractTrendPoints(raw) {
    if (!raw) return [];

    const earnings = raw.earnings || {};
    const total = earnings.total || raw.total || {};

    const namedCandidates = [
      total.chartAmount,
      total.chartCount,
      total.chart,
      total.list,
      earnings.chartAmount,
      earnings.chartCount,
      earnings.chart,
      earnings.list,
      raw.chartAmount,
      raw.chartCount,
      raw.chart,
      raw.chartData,
      raw.chart?.amount,
      raw.chart?.data,
      raw.data?.chart,
      raw.data?.chartAmount,
      raw.data?.points,
      raw.points,
      raw.series,
      raw.list,
      raw.transactions,
      raw.earnings?.transactions,
    ];

    for (const candidate of namedCandidates) {
      const points = extractTrendPointsFromArray(candidate);
      if (points.length >= 2) return points;
    }

    // Last resort: walk the raw object and pick the longest numeric array.
    const deep = findBestNumericArrayDeep(raw);
    if (deep.length >= 2) return deep;

    // One-time warn so the integrator can inspect the real response shape.
    if (!window.__onlinodTrendShapeWarned) {
      window.__onlinodTrendShapeWarned = true;
      try {
        console.warn(
          "[CREATOR_ANALYTICS] Could not extract trend points. Raw shape:",
          raw
        );
      } catch (_) {
        /* ignore */
      }
    }

    return [];
  }

  function findBestNumericArrayDeep(obj, depth = 0, seen = new WeakSet()) {
    if (!obj || typeof obj !== "object" || depth > 6) return [];
    if (seen.has(obj)) return [];
    seen.add(obj);

    let best = [];

    if (Array.isArray(obj)) {
      const points = extractTrendPointsFromArray(obj);
      if (points.length > best.length) best = points;
    }

    for (const key of Object.keys(obj)) {
      const value = obj[key];
      if (!value) continue;

      if (Array.isArray(value)) {
        const points = extractTrendPointsFromArray(value);
        if (points.length > best.length) best = points;
      } else if (typeof value === "object") {
        const nested = findBestNumericArrayDeep(value, depth + 1, seen);
        if (nested.length > best.length) best = nested;
      }
    }

    return best;
  }

  function renderTinyTrend(points = [], gradientId = "trend") {
    const clean = (Array.isArray(points) ? points : [])
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n));

    if (clean.length < 2) {
      return `
        <svg viewBox="0 0 100 28" class="hq-ca-trend-svg hq-ca-trend-empty" preserveAspectRatio="none">
          <path d="M 0 18 L 100 18" stroke="rgba(255,255,255,0.18)" stroke-width="1" stroke-dasharray="2 3" fill="none"></path>
        </svg>
      `;
    }

    const min = Math.min(...clean);
    const max = Math.max(...clean);
    const span = max - min;

    if (span <= 0) {
      // Flat real data — draw a solid flat line, not a fake zigzag.
      return `
        <svg viewBox="0 0 100 28" class="hq-ca-trend-svg hq-ca-trend-flat" preserveAspectRatio="none">
          <defs>
            <linearGradient id="${gradientId}" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.25"></stop>
              <stop offset="100%" stop-color="#fbbf24" stop-opacity="0"></stop>
            </linearGradient>
          </defs>
          <path d="M 0 18 L 100 18 L 100 28 L 0 28 Z" fill="url(#${gradientId})"></path>
          <path d="M 0 18 L 100 18" stroke="#fbbf24" stroke-width="1.3" fill="none" stroke-linejoin="round" stroke-linecap="round"></path>
        </svg>
      `;
    }

    const width = 100;
    const height = 28;
    const step = clean.length > 1 ? width / (clean.length - 1) : width;

    const linePoints = clean.map((value, index) => {
      const x = index * step;
      const y = height - 6 - ((value - min) / span) * 16;
      return `${x} ${Math.max(4, Math.min(height - 2, y))}`;
    });

    const lineD = linePoints.map((point, index) => `${index === 0 ? "M" : "L"} ${point}`).join(" ");
    const areaD = `${lineD} L ${width} ${height} L 0 ${height} Z`;

    return `
      <svg viewBox="0 0 100 28" class="hq-ca-trend-svg" preserveAspectRatio="none">
        <defs>
          <linearGradient id="${gradientId}" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.25"></stop>
            <stop offset="100%" stop-color="#fbbf24" stop-opacity="0"></stop>
          </linearGradient>
        </defs>
        <path d="${areaD}" fill="url(#${gradientId})"></path>
        <path d="${lineD}" stroke="#fbbf24" stroke-width="1.3" fill="none" stroke-linejoin="round" stroke-linecap="round"></path>
      </svg>
    `;
  }

  function renderRangeDropdown(ctx, { compact = false } = {}) {
    const open = S.isRangeDropdownOpen ? S.isRangeDropdownOpen(ctx) : false;
    const items = window.OnlinodCreatorAnalyticsConstants?.RANGES || [];

    if (compact) {
      return `
        <div class="hq-ca-inline-dropdown">
          <button class="hq-select-pill" type="button" data-hq-range-toggle>
            ${h(ctx, getActiveRangeLabel(ctx))}
            <span>⌄</span>
          </button>

          ${
            open
              ? `
                <div class="hq-ca-inline-dropdown-menu">
                  ${items.map((item) => `
                    <button
                      class="hq-ca-inline-dropdown-item ${String(item.key) === String(S.getRange ? S.getRange(ctx) : "7d") ? "active" : ""}"
                      type="button"
                      data-hq-range-item="${a(ctx, item.key)}"
                    >
                      ${h(ctx, item.label)}
                    </button>
                  `).join("")}
                </div>
              `
              : ""
          }
        </div>
      `;
    }

    return `
      <div class="hq-ca-inline-dropdown">
        <button
          class="hq-ca-inline-dropdown-trigger active"
          type="button"
          data-hq-range-toggle
        >
          ${h(ctx, getActiveRangeLabel(ctx))}
          <span>⌄</span>
        </button>

        ${
          open
            ? `
              <div class="hq-ca-inline-dropdown-menu">
                ${items
                  .map(
                    (item) => `
                  <button
                    class="hq-ca-inline-dropdown-item ${
                      String(item.key) === String(S.getRange ? S.getRange(ctx) : "7d")
                        ? "active"
                        : ""
                    }"
                    type="button"
                    data-hq-range-item="${a(ctx, item.key)}"
                  >
                    ${h(ctx, item.label)}
                  </button>
                `
                  )
                  .join("")}
              </div>
            `
            : ""
        }
      </div>
    `;
  }

  function renderCreatorAnalytics(ctx, { ready, problems }) {
    const selected = getSelectedCreator(ctx, ready);

    if (selected) {
      return renderCreatorProfile(ctx, selected);
    }

    const connected = ready.length;
    const unreadTotal = sumField(ready, "chatMessagesCount");
    const subscribersTotal = sumField(ready, "subscribersCount");
    const earningsStats = getOverviewEarningsStats(ctx, ready);

    const earningsValue =
      earningsStats.loadedCount === 0 && earningsStats.loadingCount > 0
        ? "…"
        : formatMoneyMasked(ctx, earningsStats.total);

    const earningsHint =
      earningsStats.loadingCount > 0
        ? `loading creators ${earningsStats.loadedCount}/${connected}`
        : earningsStats.errorCount > 0
        ? `${earningsStats.loadedCount}/${connected} loaded · ${earningsStats.errorCount} errors`
        : `${getActiveRangeLabel(ctx)} · ${earningsStats.loadedCount}/${connected} loaded`;

    return `
      <section class="hq-ca-page">
        <div class="hq-page-head">
          <div>
            <div class="hq-page-title">Creators</div>
            <div class="hq-page-subtitle">
              ${h(ctx, `${connected} connected · ~/onlinod/creators · analytics live`)}
            </div>
          </div>

          <div class="hq-page-actions">
            <button class="hq-soft-btn" type="button" data-hq-todo="manage-creators">
              Manage
            </button>

            <button class="hq-primary-btn" type="button" data-hq-add-account>
              + Add Account
            </button>
          </div>
        </div>

        <div class="hq-ca-filter-card">
          <div class="hq-ca-filters">
            <div class="hq-search-field">
              <span>⌕</span>
              <span>search creators…</span>
            </div>

            <div class="hq-select-pill">groups: all <span>⌄</span></div>

            <div class="hq-ca-spacer"></div>

            <span class="hq-filter-label">range</span>
            ${renderRangeDropdown(ctx, { compact: true })}
            <div class="hq-select-pill">GMT+3</div>
          </div>

          <div class="hq-ca-metric-grid">
            ${renderCreatorAnalyticsMetric(ctx, "earnings", earningsValue, earningsHint, "money")}
            ${renderCreatorAnalyticsMetric(ctx, "total fans", subscribersTotal, "from users/me", "fans")}
            ${renderCreatorAnalyticsMetric(ctx, "unread", unreadTotal, "live badge", "messages")}
          </div>
        </div>

        <div class="hq-ca-table-card">
          <div class="hq-ca-tabs">
            <div class="hq-ca-tab active">All <span>${h(ctx, String(ready.length))}</span></div>
            <div class="hq-ca-tab">Active <span>${h(ctx, String(ready.length))}</span></div>
            <div class="hq-ca-tab muted">Increasing <span>TODO</span></div>
            <div class="hq-ca-tab muted">Declining <span>TODO</span></div>
          </div>

          <div class="hq-ca-table-head">
            <div>#</div>
            <div>name</div>
            <div>earnings</div>
            <div>trend ${h(ctx, getActiveRangeLabel(ctx))}</div>
            <div>fans</div>
            <div>unread</div>
            <div></div>
          </div>

          <div class="hq-ca-table-body">
            ${
              ready.length
                ? ready.map((account, index) => renderCreatorTableRow(ctx, account, index)).join("")
                : `<div class="hq-empty hq-ca-empty">No connected creators yet.</div>`
            }

            ${
              problems.length
                ? problems.map((account) => renderCreatorProblemRow(ctx, account)).join("")
                : ""
            }
          </div>

          <div class="hq-ca-table-foot">
            <span>showing ${h(ctx, String(ready.length))} connected creators</span>
            <span>
              earnings <b>${h(ctx, earningsValue)}</b>
              · fans <b>${h(ctx, String(subscribersTotal))}</b>
              · unread <b>${h(ctx, String(unreadTotal))}</b>
            </span>
          </div>
        </div>
      </section>
    `;
  }

  function renderCreatorAnalyticsMetric(ctx, label, value, hint, icon) {
    const iconText = icon === "money" ? "$" : icon === "fans" ? "👥" : "✉";

    return `
      <div class="hq-ca-metric-card">
        <div class="hq-ca-metric-icon">${h(ctx, iconText)}</div>

        <div class="hq-ca-metric-main">
          <div class="hq-ca-metric-label">${h(ctx, label)}</div>
          <div class="hq-ca-metric-value-row">
            <span>${h(ctx, String(value))}</span>
            <em>${h(ctx, hint)}</em>
          </div>
        </div>
      </div>
    `;
  }

  function renderCreatorTableRow(ctx, account, index) {
    const subscribers = Number(account.subscribersCount || 0);
    const unread = Number(account.chatMessagesCount || 0);
    const usernameLine = accountUsernameLine(ctx, account);

    const entry = getNumbersEntry(ctx, account);
    const summary = getNumbersSummary(ctx, account);
    const raw = getNumbersRaw(ctx, account);

    const earningsMain = entry?.loading
      ? "…"
      : summary
      ? formatMoneyMasked(ctx, summary.total)
      : "$0";

    const earningsHint = entry?.loading
      ? "loading"
      : entry?.error
      ? "error"
      : summary
      ? formatSignedPercent(summary.delta)
      : "waiting";

    const trendPoints = extractTrendPoints(raw);
    const trendId = `tf-clean-${String(account.id || index)}`;

    return `
      <button class="hq-ca-table-row" type="button" data-hq-open-creator="${a(ctx, account.id)}">
        <div class="hq-ca-index">${h(ctx, String(index + 1).padStart(2, "0"))}</div>

        <div class="hq-ca-creator-cell">
          ${accountAvatar(ctx, account, "hq-ca-avatar")}

          <div class="hq-ca-creator-main">
            <div class="hq-ca-creator-name">${h(ctx, accountName(ctx, account))}</div>
            <div class="hq-ca-creator-meta">${h(ctx, usernameLine || account.id)}</div>
          </div>
        </div>

        <div class="hq-ca-money">
          <b>${h(ctx, earningsMain)}</b>
          <span>${h(ctx, earningsHint)}</span>
        </div>

        <div class="hq-ca-trend">
          ${renderTinyTrend(trendPoints, trendId)}
        </div>

        <div class="hq-ca-number">${h(ctx, String(subscribers))}</div>

        <div class="hq-ca-number">
          ${h(ctx, String(unread))}
        </div>

        <div class="hq-ca-arrow">›</div>
      </button>
    `;
  }

  function renderCreatorProblemRow(ctx, account) {
    return `
      <div class="hq-ca-problem-row">
        <div class="hq-ca-index">!</div>

        <div class="hq-ca-creator-cell">
          ${accountAvatar(ctx, account, "hq-ca-avatar")}

          <div class="hq-ca-creator-main">
            <div class="hq-ca-creator-name">${h(ctx, accountName(ctx, account))}</div>
            <div class="hq-ca-creator-meta">${h(ctx, statusLabel(ctx, account).toLowerCase())}</div>
          </div>
        </div>

        <div class="hq-ca-problem-status">${h(ctx, statusLabel(ctx, account))}</div>

        <button class="hq-resolve-btn" type="button" data-hq-resolve-account="${a(ctx, account.id)}">
          resolve
        </button>
      </div>
    `;
  }

  function renderCreatorProfile(ctx, account) {
    const subscribers = Number(account.subscribersCount || 0);
    const unread = Number(account.chatMessagesCount || 0);
    const username = account.username ? `@${account.username}` : "no username";
    const remoteId = account.remoteId || "unknown";
    const tab = S.getTab(ctx) || "issues";

    const issueCount = getCreatorIssueCount(account);
    const winCount = getCreatorWinCount(account);

    return `
      <section class="hq-helper-page ${tab === "wins" ? "wins-mode" : ""}">
        <div class="hq-helper-topbar">
          <button class="hq-soft-btn" type="button" data-hq-back-creators>
            ← Creators
          </button>

          <div class="hq-profile-path">
            ~/onlinod/creators/<span>${h(ctx, account.username || account.id)}</span>
          </div>

          <div class="hq-profile-spacer"></div>
        </div>

        <div class="hq-helper-header">
          <div class="hq-helper-identity">
            <div class="hq-profile-avatar-wrap">
              ${accountAvatar(ctx, account, "hq-helper-avatar")}
              <span class="hq-profile-online-dot"></span>
            </div>

            <div class="hq-helper-title-block">
              <div class="hq-profile-name-row">
                <h1>${h(ctx, accountName(ctx, account))}</h1>
                <span>${h(ctx, username)} · ID ${h(ctx, remoteId)}</span>
              </div>

              <div class="hq-helper-subline">
                ${
                  tab === "issues"
                    ? `<span class="hq-mode-pill danger">${h(ctx, `${issueCount} ISSUES`)}</span>`
                    : tab === "wins"
                    ? `<span class="hq-mode-pill good">${h(ctx, `${winCount} WINS`)}</span>`
                    : `<span class="hq-mode-pill neutral">NUMBERS</span>`
                }
                <span>${h(ctx, `${subscribers} fans · ${unread} unread · creator account`)}</span>
              </div>
            </div>
          </div>

          <div class="hq-helper-actions">
            <button class="hq-soft-btn" type="button" data-admin-open="${a(ctx, account.id)}">
              Open inbox
            </button>

            <button class="hq-soft-btn" type="button" data-hq-todo="full-report">
              Full report
            </button>
          </div>
        </div>

        <div class="hq-helper-switch-row">
          <div>
            <div class="hq-helper-section-label">
              ${
                tab === "issues"
                  ? "what needs action"
                  : tab === "wins"
                  ? "what's working"
                  : "numbers"
              }
            </div>

            <div class="hq-helper-section-subtitle">
              ${
                tab === "issues"
                  ? "problems and opportunities sorted by impact"
                  : tab === "wins"
                  ? "repeatable patterns and team credits"
                  : "metrics, deltas and benchmarks"
              }
            </div>
          </div>

          <div class="hq-helper-tabs">
            ${renderCreatorTabButton(ctx, "issues", "Issues", issueCount, tab)}
            ${renderCreatorTabButton(ctx, "wins", "Wins", winCount, tab)}
            ${renderCreatorTabButton(ctx, "numbers", "Numbers", "", tab)}
          </div>
        </div>

        ${
          tab === "wins"
            ? renderCreatorWins(ctx, account)
            : tab === "numbers"
            ? renderCreatorNumbers(ctx, account)
            : renderCreatorIssues(ctx, account)
        }
      </section>
    `;
  }

  function getCreatorIssueCount(account) {
    const unread = Number(account.chatMessagesCount || 0);
    let count = 1;

    if (unread >= 10) count += 1;
    if (!account.subscribersCount) count += 1;

    return count;
  }

  function getCreatorWinCount(account) {
    const subscribers = Number(account.subscribersCount || 0);
    let count = 1;

    if (subscribers > 0) count += 1;
    if (account.avatar) count += 1;

    return count;
  }

  function renderCreatorTabButton(ctx, key, label, count, active) {
    const cls = active === key ? "active" : "";

    return `
      <button
        class="${cls}"
        type="button"
        data-hq-creator-tab="${a(ctx, key)}"
      >
        ${h(ctx, label)}
        ${count !== "" ? `<span>${h(ctx, String(count))}</span>` : ""}
      </button>
    `;
  }

  function renderCreatorIssues(ctx, account) {
    const unread = Number(account.chatMessagesCount || 0);
    const subscribers = Number(account.subscribersCount || 0);

    return `
      <div class="hq-action-feed">
        ${renderIssueCard(ctx, {
          severity: unread >= 10 ? "danger" : "warning",
          icon: "!",
          title: "Unread pressure is growing",
          badge: unread ? `${unread} unread` : "watch",
          text:
            unread > 0
              ? `There are ${unread} unread messages. This is the first operational signal to watch before earnings analytics is connected.`
              : "No unread pressure detected right now. Keep watching live badge changes.",
          actionPrimary: "Open inbox",
          actionSecondary: "Mark as watched",
          openAccountId: account.id,
        })}

        ${renderIssueCard(ctx, {
          severity: "warning",
          icon: "↯",
          title: "Earnings analytics is not connected yet",
          badge: "ADD LOGIC",
          text:
            "Revenue, PPV open rate, tips and campaigns are reserved here. Once workers are connected, this card becomes a real diagnosis helper.",
          actionPrimary: "Wire earnings worker",
          actionSecondary: "View TODO",
          todo: "earnings-worker",
        })}

        ${renderIssueCard(ctx, {
          severity: subscribers ? "neutral" : "warning",
          icon: "👥",
          title: subscribers ? "Subscriber base loaded" : "Subscriber count missing",
          badge: subscribers ? `${subscribers} fans` : "missing",
          text:
            subscribers
              ? `users/me gives us ${subscribers} subscribers. Later we can compare this with growth, active fans and paying fans.`
              : "users/me did not provide subscribersCount yet. Refresh creator profile or wait for next users/me capture.",
          actionPrimary: subscribers ? "Refresh profile" : "Refresh users/me",
          actionSecondary: "Open creator",
          refreshAccountId: account.id,
        })}

        ${renderIssueCard(ctx, {
          severity: "neutral",
          icon: "⌁",
          title: "Campaign attribution is reserved",
          badge: "TODO",
          text:
            "Trial links, campaigns, spend/earn and subscriber attribution will live here after Campaign worker is connected.",
          actionPrimary: "Open campaigns TODO",
          actionSecondary: "Later",
          todo: "campaign-attribution",
        })}
      </div>
    `;
  }

  function renderIssueCard(ctx, cfg) {
    const severity = cfg.severity || "neutral";

    return `
      <div class="hq-action-card ${severity}">
        <div class="hq-action-accent"></div>

        <div class="hq-action-icon">
          ${h(ctx, cfg.icon || "!")}
        </div>

        <div class="hq-action-main">
          <div class="hq-action-title-row">
            <h3>${h(ctx, cfg.title)}</h3>
            <span>${h(ctx, cfg.badge || "TODO")}</span>
          </div>

          <p>${h(ctx, cfg.text)}</p>

          <div class="hq-action-buttons">
            ${
              cfg.openAccountId
                ? `<button class="hq-action-primary" type="button" data-admin-open="${a(ctx, cfg.openAccountId)}">${h(ctx, cfg.actionPrimary)}</button>`
                : cfg.refreshAccountId
                ? `<button class="hq-action-primary" type="button" data-admin-refresh-me="${a(ctx, cfg.refreshAccountId)}">${h(ctx, cfg.actionPrimary)}</button>`
                : `<button class="hq-action-primary" type="button" data-hq-todo="${a(ctx, cfg.todo || cfg.title)}">${h(ctx, cfg.actionPrimary)}</button>`
            }

            <button class="hq-action-secondary" type="button" data-hq-todo="${a(ctx, cfg.todo || cfg.actionSecondary)}">
              ${h(ctx, cfg.actionSecondary)}
            </button>
          </div>
        </div>

        <div class="hq-action-visual">
          ${renderActionSparkline(severity)}
        </div>
      </div>
    `;
  }

  function renderActionSparkline(severity) {
    const color =
      severity === "danger"
        ? "#f87171"
        : severity === "warning"
        ? "#fbbf24"
        : "#86efac";

    return `
      <svg viewBox="0 0 140 44" preserveAspectRatio="none">
        <path
          d="M 0 18 L 18 14 L 36 20 L 54 12 L 72 26 L 90 20 L 108 30 L 126 22 L 140 28"
          stroke="${color}"
          stroke-width="1.4"
          fill="none"
          stroke-linejoin="round"
        ></path>
      </svg>
    `;
  }

  function renderCreatorWins(ctx, account) {
    const subscribers = Number(account.subscribersCount || 0);
    const unread = Number(account.chatMessagesCount || 0);

    return `
      <div class="hq-win-highlight">
        <div class="hq-win-icon">🏆</div>

        <div>
          <div class="hq-win-kicker">week highlight</div>
          <div class="hq-win-title">
            Creator profile is healthy enough for automation wiring.
          </div>
          <div class="hq-win-meta">
            ${h(ctx, `${subscribers} fans · ${unread} unread · Browser API Runner ready`)}
          </div>
        </div>

        <button class="hq-win-share" type="button" data-hq-todo="share-to-team">
          share to team →
        </button>
      </div>

      <div class="hq-action-feed">
        ${renderWinCard(ctx, {
          title: "Live badge listener works",
          badge: `${unread} unread`,
          text:
            "Unread messages are tracked from the live browser page instead of blind polling. This is safer and closer to real product behavior.",
          primary: "Open inbox",
          secondary: "View listener",
          openAccountId: account.id,
        })}

        ${renderWinCard(ctx, {
          title: "Creator identity is connected",
          badge: account.username ? `@${account.username}` : "ready",
          text:
            "Avatar, display name, username, remoteId and subscribers are already available from users/me and manifest updates.",
          primary: "Refresh profile",
          secondary: "View manifest",
          refreshAccountId: account.id,
        })}

        ${renderWinCard(ctx, {
          title: "Access snapshots are ready",
          badge: "save / revoke",
          text:
            "Owner can save browser access snapshot. Later this becomes assignedTo for several employees and subscription-based account seats.",
          primary: "Save Access",
          secondary: "Revoke Last",
          snapshotAccountId: account.id,
        })}

        ${renderWinCard(ctx, {
          title: "Browser API Runner is the right path",
          badge: "validated",
          text:
            "Active requests go through the live browser session, not Node HTTP. This keeps the architecture aligned with the old working worker idea.",
          primary: "Wire next worker",
          secondary: "Open TODO",
          todo: "browser-api-runner-next",
        })}
      </div>
    `;
  }

  function renderWinCard(ctx, cfg) {
    return `
      <div class="hq-action-card win">
        <div class="hq-action-accent"></div>

        <div class="hq-action-icon">↗</div>

        <div class="hq-action-main">
          <div class="hq-action-title-row">
            <h3>${h(ctx, cfg.title)}</h3>
            <span>${h(ctx, cfg.badge)}</span>
          </div>

          <p>${h(ctx, cfg.text)}</p>

          <div class="hq-action-buttons">
            ${
              cfg.openAccountId
                ? `<button class="hq-action-primary" type="button" data-admin-open="${a(ctx, cfg.openAccountId)}">${h(ctx, cfg.primary)}</button>`
                : cfg.refreshAccountId
                ? `<button class="hq-action-primary" type="button" data-admin-refresh-me="${a(ctx, cfg.refreshAccountId)}">${h(ctx, cfg.primary)}</button>`
                : cfg.snapshotAccountId
                ? `<button class="hq-action-primary" type="button" data-snapshot-create="${a(ctx, cfg.snapshotAccountId)}">${h(ctx, cfg.primary)}</button>`
                : `<button class="hq-action-primary" type="button" data-hq-todo="${a(ctx, cfg.todo || cfg.primary)}">${h(ctx, cfg.primary)}</button>`
            }

            ${
              cfg.snapshotAccountId
                ? `<button class="hq-action-secondary" type="button" data-snapshot-revoke="${a(ctx, cfg.snapshotAccountId)}">${h(ctx, cfg.secondary)}</button>`
                : `<button class="hq-action-secondary" type="button" data-hq-todo="${a(ctx, cfg.todo || cfg.secondary)}">${h(ctx, cfg.secondary)}</button>`
            }
          </div>
        </div>

        <div class="hq-action-visual">
          ${renderActionBars()}
        </div>
      </div>
    `;
  }

  function renderActionBars() {
    return `
      <div class="hq-action-bars">
        <i style="height:18px"></i>
        <i style="height:34px"></i>
        <i style="height:24px"></i>
        <i style="height:40px"></i>
        <i style="height:28px"></i>
      </div>
    `;
  }

  function renderCreatorNumbers(ctx, account) {
    const subscribers = Number(account.subscribersCount || 0);
    const unread = Number(account.chatMessagesCount || 0);
    const entry = getNumbersEntry(ctx, account);
    const summary = getNumbersSummary(ctx, account);
    const raw = getNumbersRaw(ctx, account);

    const totalValue = entry?.loading ? "…" : summary ? formatMoneyMasked(ctx, summary.total) : "$0";
    const avgSaleValue = entry?.loading ? "…" : summary ? formatMoneyMasked(ctx, summary.avgSale) : "$0";
    const ltvValue = entry?.loading ? "…" : summary ? formatMoneyMasked(ctx, summary.fanLtv) : "$0";

    const totalHint = entry?.loading
      ? "loading selected period"
      : summary
      ? `gross ${formatMoneyMasked(ctx, summary.gross)} · ${formatSignedPercent(summary.delta)}`
      : "waiting for earnings worker";

    const avgHint = entry?.loading
      ? "loading selected period"
      : summary
      ? `${summary.salesCount || 0} sales`
      : "PPV + tips";

    const ltvHint = entry?.loading
      ? "loading selected period"
      : summary
      ? `${summary.uniqueFans || 0} paying fans`
      : "lifetime value per fan";

    const points = extractTrendPoints(raw);

    return `
      <div class="hq-numbers-toolbar">
        <span>compare against</span>

        <div class="hq-numbers-compare">
          ${renderRangeDropdown(ctx)}
          <button type="button" data-hq-todo="workspace-median">workspace median</button>
          <button type="button" data-hq-todo="creator-compare">vs another creator</button>
        </div>

        <div class="hq-profile-spacer"></div>

        <button class="hq-soft-btn" type="button" data-hq-todo="export-disabled">
          export later
        </button>
      </div>

      <div class="hq-number-section">
        <div class="hq-number-section-title">
          <span>$</span>
          <b>money</b>
          <em>after OF cut · ${h(ctx, getActiveRangeLabel(ctx))}</em>
        </div>

        <div class="hq-number-table">
          ${renderNumberRow(ctx, {
            label: "Total earnings",
            hint: totalHint,
            value: totalValue,
            delta: entry?.loading ? "loading" : summary ? formatSignedPercent(summary.delta) : "TODO",
            points,
            todoKey: "total_earnings",
          })}

          ${renderNumberRow(ctx, {
            label: "Avg sale price",
            hint: avgHint,
            value: avgSaleValue,
            delta: entry?.loading ? "loading" : summary ? `${summary.salesCount || 0} sales` : "TODO",
            points,
            todoKey: "avg_sale_price",
          })}

          ${renderNumberRow(ctx, {
            label: "Fan LTV",
            hint: ltvHint,
            value: ltvValue,
            delta: entry?.loading ? "loading" : summary ? `${summary.uniqueFans || 0} fans` : "TODO",
            points,
            todoKey: "fan_ltv",
          })}
        </div>
      </div>

      <div class="hq-number-section">
        <div class="hq-number-section-title">
          <span>👥</span>
          <b>audience</b>
          <em>real values from users/me and live badge</em>
        </div>

        <div class="hq-number-table">
          ${renderNumberRow(ctx, {
            label: "Subscribers",
            hint: "users/me subscribersCount",
            value: subscribers,
            delta: "live",
            points: [Math.max(0, subscribers * 0.82), Math.max(0, subscribers * 0.9), subscribers],
            todoKey: "subscribers",
          })}

          ${renderNumberRow(ctx, {
            label: "Unread messages",
            hint: "live badge listener",
            value: unread,
            delta: unread ? "needs attention" : "clear",
            points: unread ? [unread + 3, unread + 2, unread + 1, unread] : [0, 0, 0, 0],
            todoKey: "unread_messages",
          })}
        </div>
      </div>

      ${renderCreatorCampaignsSection(ctx, account)}
    `;
  }

  // ─────────────────────────────────────────────────────────────
  // Campaigns section — trials/promos/campaigns with live counts
  // and claim-history mini-trend.
  //
  // Expected data shape (from window.desktopAPI.creatorCampaigns.list):
  //   {
  //     ok: true,
  //     campaigns: [
  //       {
  //         id: "2472348",
  //         name: "Trial 7 days",          // required
  //         type: "trial"|"campaign"|"promo", // optional, inferred from name
  //         is_active: true,               // optional
  //         created_at: "2026-01-15T...",   // optional
  //         claimers_count: 9,              // preferred count field
  //         subscribers_count: 9,           // fallback (from countSubscribers)
  //         clicks_count: 142,              // optional (countTransitions)
  //         history: [                      // optional, from campaign_link_stats_history
  //           { snapshot_time: "...", subscribers_count: 2 },
  //           { snapshot_time: "...", subscribers_count: 5 },
  //           ...
  //         ],
  //       },
  //       ...
  //     ]
  //   }
  //
  // If any field is missing, we fall back gracefully: type is inferred
  // from name keywords, trend is extracted via the shared numeric walker,
  // and empty states get their own messaging.

  function inferCampaignType(campaign) {
    if (campaign.type) return String(campaign.type).toLowerCase();

    const name = String(campaign.name || campaign.campaignName || "").toLowerCase();
    if (name.includes("trial")) return "trial";
    if (name.includes("promo")) return "promo";
    if (name.includes("campaign") || name.includes("link")) return "campaign";
    return "campaign";
  }

  function getCampaignClaimers(campaign) {
    const candidates = [
      campaign.claimers_count,
      campaign.claimersCount,
      campaign.subscribers_count,
      campaign.subscribersCount,
      campaign.countSubscribers,
      Array.isArray(campaign.claimers) ? campaign.claimers.length : null,
    ];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
    return 0;
  }

  function getCampaignClicks(campaign) {
    const candidates = [
      campaign.clicks_count,
      campaign.clicksCount,
      campaign.countTransitions,
      campaign.transitions,
    ];
    for (const c of candidates) {
      const n = Number(c);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  function extractCampaignHistoryPoints(campaign) {
    const sources = [
      campaign.history,
      campaign.subscribers_history,
      campaign.trend,
      campaign.trendPoints,
      campaign.points,
    ];

    for (const source of sources) {
      const points = extractTrendPointsFromArray(source);
      if (points.length) return points;
    }

    // Last resort: deep walk this one campaign object.
    const deep = findBestNumericArrayDeep(campaign);
    if (deep.length >= 2) return deep;

    return [];
  }

  function computeCampaignDelta(points, fallback) {
    const clean = (points || []).map((n) => Number(n)).filter((n) => Number.isFinite(n));
    if (clean.length < 2) return fallback || "no history";

    const first = clean[0];
    const last = clean[clean.length - 1];

    if (!Number.isFinite(first) || first === 0) {
      return last > 0 ? `+${last} new` : "no change";
    }

    const pct = ((last - first) / Math.abs(first)) * 100;
    return formatSignedPercent(pct);
  }

  function renderCreatorCampaignsSection(ctx, account) {
    const entry = S.getCampaignsState
      ? S.getCampaignsState(ctx, account.id)
      : null;

    const loading = !!entry?.loading;
    const error = entry?.error || null;
    const data = entry?.data || null;
    const notWired = !!(data && data.notWired);
    const campaigns = Array.isArray(data?.campaigns) ? data.campaigns : [];

    let body = "";

    if (loading && !campaigns.length) {
      body = `<div class="hq-campaign-empty">Loading campaigns…</div>`;
    } else if (error) {
      body = `<div class="hq-campaign-empty">Failed to load campaigns: ${h(ctx, error)}</div>`;
    } else if (notWired) {
      body = `
        <div class="hq-campaign-empty">
          Campaigns worker is not wired to the UI yet.<br>
          Expose <code>window.desktopAPI.creatorCampaigns.list(account, range)</code> to populate this section.
        </div>
      `;
    } else if (!campaigns.length) {
      body = `<div class="hq-campaign-empty">No campaigns or trials for this creator yet.</div>`;
    } else {
      body = `
        <div class="hq-number-table">
          ${campaigns.map((c) => renderCampaignRow(ctx, c)).join("")}
        </div>
      `;
    }

    return `
      <div class="hq-number-section">
        <div class="hq-number-section-title">
          <span>📣</span>
          <b>campaigns &amp; trials</b>
          <em>claim links · live counts · ${h(ctx, getActiveRangeLabel(ctx))}</em>
        </div>

        ${body}
      </div>
    `;
  }

  function renderConvBar(convRate) {
    // Honest conversion bar for when we don't have time-series history yet.
    // convRate is 0..100 or null.
    const pct = Number.isFinite(convRate) ? Math.max(0, Math.min(100, convRate)) : 0;
    return `
      <div class="hq-cmp-convbar" aria-label="conversion ${pct.toFixed(1)}%">
        <div class="hq-cmp-convbar-fill" style="width: ${pct.toFixed(2)}%"></div>
      </div>
    `;
  }

  function renderCampaignRow(ctx, campaign) {
    const type = inferCampaignType(campaign);
    const claimers = getCampaignClaimers(campaign);
    const clicks = getCampaignClicks(campaign);
    const isActive = campaign.is_active !== false && !campaign.isDeleted;

    const name = String(campaign.name || campaign.campaignName || `campaign ${campaign.id || ""}`).trim();
    const trendPoints = extractCampaignHistoryPoints(campaign);
    const trendId = `cmp-${a(ctx, campaign.id || name)}`;
    const hasHistory = trendPoints.length >= 2;

    // Live-computed conversion rate (honest, from real clicks/claimers).
    let convRate = null;
    if (clicks !== null && clicks > 0) {
      convRate = Math.max(0, Math.min(100, (claimers / clicks) * 100));
    }

    // Structured hint line under the name: each piece gets its own span so
    // CSS can colour clicks (muted) / claimers (amber) / conv (subtle) /
    // inactive (grey) independently — instead of all sharing the same
    // muted .hq-number-row span colour.
    const hintPieces = [];
    if (clicks !== null) {
      hintPieces.push(
        `<span class="hq-cmp-meta-clicks">${h(ctx, String(clicks))} clicks</span>`
      );
    }
    hintPieces.push(
      `<span class="hq-cmp-arrow">→</span>` +
      `<span class="hq-cmp-meta-claimers">${h(ctx, String(claimers))} claimers</span>`
    );
    if (convRate !== null) {
      hintPieces.push(
        `<span class="hq-cmp-meta-conv">${convRate.toFixed(1)}% conv</span>`
      );
    }
    if (!isActive) {
      hintPieces.push(`<span class="hq-cmp-meta-inactive">inactive</span>`);
    }

    // Right-side delta text:
    //   - inactive   → "inactive"
    //   - has history → signed % delta from sparkline
    //   - no history, has conv → show conv% there too (column stays useful)
    //   - otherwise  → em-dash
    let deltaText = "—";
    let deltaMod = "";
    if (!isActive) {
      deltaText = "inactive";
    } else if (hasHistory) {
      deltaText = computeCampaignDelta(trendPoints, "—");
      if (deltaText.startsWith("+") && deltaText !== "+0.0%") deltaMod = "up";
      else if (deltaText.startsWith("-")) deltaMod = "down";
    } else if (convRate !== null) {
      deltaText = `${convRate.toFixed(0)}% conv`;
    }

    // Middle visualisation column:
    //   - history present → real sparkline
    //   - no history     → horizontal conversion bar (not a fake zigzag)
    const vizInner = hasHistory
      ? renderTinyTrend(trendPoints, trendId)
      : renderConvBar(convRate);

    const rowClass = `hq-number-row campaign-row ${isActive ? "" : "inactive"}`.trim();
    const badgeMod = isActive ? type : "inactive";

    return `
      <div class="${rowClass}">
        <div class="hq-cmp-name-cell">
          <div class="hq-cmp-name-line">
            <span class="hq-campaign-badge ${a(ctx, badgeMod)}">${h(ctx, type)}</span>
            <strong class="hq-cmp-name">${h(ctx, name)}</strong>
          </div>
          <div class="hq-cmp-meta">
            ${hintPieces.join('<span class="hq-cmp-meta-sep">·</span>')}
          </div>
        </div>

        <div class="hq-number-value">${h(ctx, String(claimers))}</div>

        <div class="hq-number-trend">
          ${vizInner}
        </div>

        <div class="hq-number-delta ${deltaMod}">
          ${h(ctx, deltaText)}
        </div>

        <button type="button" data-hq-todo="campaign-${a(ctx, campaign.id || name)}">›</button>
      </div>
    `;
  }

  function renderNumberRow(ctx, cfg) {
    return `
      <div class="hq-number-row">
        <div>
          <strong>${h(ctx, cfg.label)}</strong>
          <span>${h(ctx, cfg.hint)}</span>
        </div>

        <div class="hq-number-value">${h(ctx, String(cfg.value))}</div>

        <div class="hq-number-trend">
          ${renderTinyTrend(cfg.points || [], `nr-${a(ctx, cfg.todoKey || cfg.label)}`)}
        </div>

        <div class="hq-number-delta">
          ${h(ctx, cfg.delta)}
        </div>

        <button type="button" data-hq-todo="${a(ctx, cfg.todoKey || cfg.label)}">›</button>
      </div>
    `;
  }

  function render(ctx) {
    const ready = getReady(ctx);
    const problems = getProblems(ctx);

    return renderCreatorAnalytics(ctx, { ready, problems });
  }

  window.OnlinodCreatorAnalyticsRenderers = {
    render,
  };
})();