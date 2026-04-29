(function () {
  "use strict";

  const U = window.OnlinodHomeUtils;

  // Permission helpers. Pull from ctx.helpers (set up by app-admin.js
  // renderAdminPanel). Fall open when team module isn't loaded so
  // first-boot owner doesn't see an empty UI.
  function can(ctx, permKey) {
    return ctx.helpers?.can ? ctx.helpers.can(permKey) : true;
  }

  function canAccessSection(ctx, sectionKey) {
    return ctx.helpers?.canAccessSection
      ? ctx.helpers.canAccessSection(sectionKey)
      : true;
  }

  function renderHome(ctx) {
    const ready = U.getReady(ctx);
    const problems = U.getProblems(ctx);
    const unreadTotal = U.sumField(ready, "chatMessagesCount");
    const subscribersTotal = U.sumField(ready, "subscribersCount");

    return `
      <section class="hq-hero-card">
        <div class="hq-terminal-line">
          <div class="hq-window-dots">
            <span></span>
            <span></span>
            <span class="active"></span>
          </div>

          <span>~/onlinod/home</span>
          <em>·</em>
          <span>live</span>

          <div class="hq-terminal-spacer"></div>

          <span>↻ passive</span>
        </div>

        <div class="hq-metrics-grid">
          ${renderMetric(ctx, "connected creators", ready.length, "partitions online", "ok")}
          ${renderMetric(ctx, "unread messages", unreadTotal, "DOM/API listener", "")}
          ${renderMetric(ctx, "subscribers", subscribersTotal, "from users/me", "")}
          ${renderMetric(ctx, "problems", problems.length, "draft / auth / not creator", problems.length ? "warn" : "")}
        </div>

        ${renderSparkline()}
      </section>

      <section class="hq-home-grid">
        <div class="hq-panel">
          <div class="hq-panel-head">
            <div>
              <div class="hq-panel-title">creators</div>
              <div class="hq-panel-subtitle">${U.h(ctx, `${ready.length} connected`)}</div>
            </div>

            ${
              canAccessSection(ctx, "creatorAnalytics")
                ? `<button class="hq-link-btn" data-route="creators">→ all</button>`
                : ""
            }
          </div>

          <div class="hq-creator-list">
            ${
              ready.length
                ? ready.map((account) => renderCreatorRow(ctx, account)).join("")
                : `<div class="hq-empty">No connected creators yet.</div>`
            }

            ${
              problems.length
                ? problems.slice(0, 3).map((account) => renderProblemRow(ctx, account)).join("")
                : ""
            }
          </div>
        </div>

        ${
          can(ctx, "workspace.view_team") || can(ctx, "workspace.view_billing")
            ? `<div class="hq-panel">
                <div class="hq-panel-head">
                  <div>
                    <div class="hq-panel-title">audit.log</div>
                    <div class="hq-panel-subtitle">tail -f</div>
                  </div>

                  <span class="hq-todo-badge">TODO</span>
                </div>

                <div class="hq-audit-list">
                  ${renderAuditRow(ctx, "now", "hq.home", "real creators list connected")}
                  ${renderAuditRow(ctx, "live", "badge.listener", `${unreadTotal} unread total`)}
                  ${renderAuditRow(ctx, "sync", "snapshots", "save / revoke enabled, assign later")}
                  ${renderAuditRow(ctx, "next", "creator.analytics", "wire real metrics")}
                </div>
              </div>`
            : ""
        }
      </section>

      <section class="hq-todo-grid">
        ${
          canAccessSection(ctx, "creatorAnalytics")
            ? renderTodoCard(ctx, "Creator Analytics", "Real earnings / fans / campaign attribution", "ADD LOGIC")
            : ""
        }
        ${
          canAccessSection(ctx, "teamAnalytics")
            ? renderTodoCard(ctx, "Team Analytics", "Managers, seats, assigned creators, access control", "TODO")
            : ""
        }
        ${
          canAccessSection(ctx, "messageLibrary")
            ? renderTodoCard(ctx, "Message Library", "Scripts, prices, vault attachments", "TODO")
            : ""
        }
        ${
          canAccessSection(ctx, "vault")
            ? renderTodoCard(ctx, "Vault", "Lists, media, previews, infinite loading", "NEXT")
            : ""
        }
      </section>
    `;
  }

  function renderMetric(ctx, label, value, hint, mode) {
    return `
      <div class="hq-metric ${mode || ""}">
        <div class="hq-metric-label">${U.h(ctx, label)}</div>
        <div class="hq-metric-value">${U.h(ctx, U.formatCount(value))}</div>
        <div class="hq-metric-hint">${U.h(ctx, hint)}</div>
      </div>
    `;
  }

  function renderSparkline() {
    return `
      <svg class="hq-sparkline" viewBox="0 0 560 42" preserveAspectRatio="none">
        <defs>
          <linearGradient id="hqSparkFillClean" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stop-color="#fbbf24" stop-opacity="0.42"></stop>
            <stop offset="100%" stop-color="#fbbf24" stop-opacity="0"></stop>
          </linearGradient>
        </defs>
        <path d="M 0 30 L 70 22 L 140 26 L 210 10 L 280 18 L 350 13 L 420 22 L 490 8 L 560 15 L 560 42 L 0 42 Z" fill="url(#hqSparkFillClean)"></path>
        <path d="M 0 30 L 70 22 L 140 26 L 210 10 L 280 18 L 350 13 L 420 22 L 490 8 L 560 15" stroke="#fbbf24" stroke-width="1.4" fill="none" stroke-linejoin="round" stroke-linecap="round"></path>
        <circle cx="490" cy="8" r="3.5" fill="#0a0715" stroke="#fbbf24" stroke-width="1.8"></circle>
      </svg>
    `;
  }

  function renderCreatorRow(ctx, account) {
    const messages = Number(account.chatMessagesCount || 0);
    const username = account.username ? `@${account.username}` : account.id;

    return `
      <div class="hq-creator-row" data-admin-open="${U.a(ctx, account.id)}">
        ${U.accountAvatar(ctx, account, "hq-creator-avatar")}

        <div class="hq-creator-main">
          <div class="hq-creator-name">${U.h(ctx, U.accountName(ctx, account))}</div>
          <div class="hq-creator-meta">${U.h(ctx, username)} · ${U.h(ctx, String(messages))} unread</div>
        </div>

        <div class="hq-live-pill">live</div>
      </div>
    `;
  }

  function renderProblemRow(ctx, account) {
    return `
      <div class="hq-creator-row warning">
        ${U.accountAvatar(ctx, account, "hq-creator-avatar")}

        <div class="hq-creator-main">
          <div class="hq-creator-name">${U.h(ctx, U.accountName(ctx, account))}</div>
          <div class="hq-creator-meta">${U.h(ctx, U.statusLabel(ctx, account).toLowerCase())}</div>
        </div>

        ${
          canAccessSection(ctx, "creatorAnalytics")
            ? `<button class="hq-resolve-btn" data-route="creators">resolve</button>`
            : ""
        }
      </div>
    `;
  }

  function renderAuditRow(ctx, time, title, subtitle) {
    return `
      <div class="hq-audit-row">
        <span>${U.h(ctx, time)}</span>
        <div>
          <b>${U.h(ctx, title)}</b>
          <em>${U.h(ctx, subtitle)}</em>
        </div>
      </div>
    `;
  }

  function renderTodoCard(ctx, title, subtitle, badge) {
    return `
      <div class="hq-todo-card">
        <div class="hq-todo-top">
          <div>
            <div class="hq-todo-title">${U.h(ctx, title)}</div>
            <div class="hq-todo-subtitle">${U.h(ctx, subtitle)}</div>
          </div>
          <span>${U.h(ctx, badge)}</span>
        </div>
      </div>
    `;
  }

  window.OnlinodHomeRenderers = {
    renderHome,
  };
})();
