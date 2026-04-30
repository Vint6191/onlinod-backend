(function () {
  "use strict";

  const h = () => window.OnlinodRouter.escapeHtml;
  const a = () => window.OnlinodRouter.escapeAttr;
  const api = () => window.OnlinodAdminAuth;

  const TIERS = {
    STARTER: { label: "Starter", price: 2000, revenue: "$0–$1k" },
    GROWTH: { label: "Growth", price: 3000, revenue: "$1k–$5k" },
    PRO: { label: "Pro", price: 5000, revenue: "$5k–$15k" },
    ELITE: { label: "Elite", price: 15000, revenue: "$15k+" },
    CUSTOM: { label: "Custom", price: 0, revenue: "manual" },
  };

  const state = {
    agencies: [],
    selectedAgencyId: null,
    selectedAgency: null,
    liveFeed: [],
    error: null,
    expandedCreatorId: null,
  };

  function money(cents) {
    return `$${(Number(cents || 0) / 100).toFixed(0)}`;
  }

  function dateShort(value) {
    if (!value) return "—";
    try {
      return new Date(value).toLocaleString();
    } catch (_) {
      return String(value);
    }
  }

  function healthBadge(health) {
    const level = health?.level || "unknown";
    const score = health?.score ?? 0;
    return `<span class="admin-health ${a()(level)}">${h()(level)} · ${h()(score)}</span>`;
  }

  function creatorKind(creator) {
    if (creator.billingProfile?.billingExcluded) return "EXCLUDED";
    if (creator.partition === "persist:acct_demo") return "TEST";
    if (creator.status === "NOT_CREATOR") return "NOT_CREATOR";
    if (creator.status === "READY" && creator.remoteId) return "REAL";
    if (creator.status === "READY" && creator.username && !creator.remoteId) return "DUPLICATE?";
    return creator.status || "UNKNOWN";
  }

  function kindClass(value) {
    return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-");
  }

  function getCreatorCorePrice(creator) {
    if (creator.billingProfile?.billingExcluded) return 0;
    if (creator.billingProfile?.corePriceCents !== undefined && creator.billingProfile?.corePriceCents !== null) {
      return Number(creator.billingProfile.corePriceCents || 0);
    }

    const tier = creator.billingProfile?.tier || "STARTER";
    return TIERS[tier]?.price || 2000;
  }

  function getCreatorAddonTotal(creator) {
    const billing = creator.billingProfile || {};
    if (billing.billingExcluded) return 0;

    let total = 0;
    if (billing.aiChatterEnabled) total += Number(billing.aiChatterPriceCents || 10000);
    if (billing.outreachEnabled) total += Number(billing.outreachPriceCents || 2900);
    return total;
  }

  function getAgencyMonthlyTotal(agency) {
    return (agency?.creators || []).reduce((sum, creator) => {
      return sum + getCreatorCorePrice(creator) + getCreatorAddonTotal(creator);
    }, 0);
  }

  function localHealth(agency) {
    const creators = agency?.creators || [];
    const snaps = agency?.accessSnapshots || [];
    const active = new Set(snaps.filter((x) => x.active && !x.revokedAt).map((x) => x.creatorId));
    let score = 100;
    const issues = [];

    for (const creator of creators) {
      if (creator.billingProfile?.billingExcluded) continue;

      if (creator.status === "READY" && !active.has(creator.id)) {
        score -= 18;
        issues.push({ severity: "ERROR", message: `${creator.displayName} is READY but has no active snapshot` });
      }

      if (creator.status === "NOT_CREATOR") {
        score -= 6;
        issues.push({ severity: "WARNING", message: `${creator.displayName} is NOT_CREATOR` });
      }

      if (creator.status === "READY" && creator.username && !creator.remoteId) {
        score -= 8;
        issues.push({ severity: "WARNING", message: `${creator.displayName} has username but no remoteId — possible duplicate` });
      }

      if (creator.partition === "persist:acct_demo") {
        score -= 10;
        issues.push({ severity: "WARNING", message: `${creator.displayName} uses persist:acct_demo — likely test duplicate` });
      }
    }

    score = Math.max(0, Math.min(100, score));
    return {
      score,
      level: score >= 80 ? "healthy" : score >= 55 ? "warning" : "critical",
      issues,
    };
  }

  async function loadAgencies() {
    const data = await api().request("/api/admin/agencies");
    if (!data.ok) throw new Error(data.error || "Failed to load agencies");

    state.agencies = data.agencies || [];
    if (!state.selectedAgencyId && state.agencies[0]) {
      state.selectedAgencyId = state.agencies[0].id;
    }
  }

  async function loadAgency(id) {
    if (!id) return;

    const data = await api().request(`/api/admin/agencies/${encodeURIComponent(id)}`);
    if (!data.ok) throw new Error(data.error || "Failed to load agency");

    state.selectedAgency = data.agency;
  }

  async function loadLiveFeed() {
    const q = state.selectedAgencyId ? `?agencyId=${encodeURIComponent(state.selectedAgencyId)}` : "";
    const data = await api().request(`/api/admin/live-feed${q}`);
    if (data.ok) state.liveFeed = data.events || [];
  }

  async function bootstrap() {
    state.error = null;

    try {
      await loadAgencies();
      await loadAgency(state.selectedAgencyId);
      await loadLiveFeed();
    } catch (error) {
      state.error = error.message || String(error);
    }
  }

  function renderWorkspaceBilling(agency) {
    const total = getAgencyMonthlyTotal(agency);
    const paidCreators = (agency.creators || []).filter((creator) => !creator.billingProfile?.billingExcluded);
    const excludedCreators = (agency.creators || []).filter((creator) => creator.billingProfile?.billingExcluded);
    const subscription = agency.subscriptions?.[0] || {};

    return `
      <section class="admin-card admin-billing-card">
        <div class="admin-card-head">
          <strong>Workspace billing</strong>
          <span class="admin-muted">Agency controls subscription. Creator rows control price.</span>
        </div>

        <div class="admin-billing-summary">
          <div>
            <span>Status</span>
            <strong>${h()(agency.status || "TRIAL")}</strong>
          </div>
          <div>
            <span>Billable creators</span>
            <strong>${h()(paidCreators.length)}</strong>
          </div>
          <div>
            <span>Excluded</span>
            <strong>${h()(excludedCreators.length)}</strong>
          </div>
          <div>
            <span>Estimated monthly</span>
            <strong>${h()(money(total))}</strong>
          </div>
        </div>

        <div class="admin-grid-2">
          <label class="on-field">
            <span>Workspace plan label</span>
            <input class="on-input" id="adminPlan" value="${a()(agency.plan || "core")}">
          </label>

          <label class="on-field">
            <span>Subscription status</span>
            <select class="on-input" id="adminStatus">
              ${["TRIAL", "ACTIVE", "PAST_DUE", "GRACE", "CANCELLED", "LOCKED"]
                .map((x) => `<option value="${x}" ${String(agency.status) === x ? "selected" : ""}>${x}</option>`)
                .join("")}
            </select>
          </label>

          <label class="on-field">
            <span>Fallback core cents</span>
            <input class="on-input" type="number" id="adminCorePrice" value="${a()(subscription.corePricePerCreatorCents || 2000)}">
          </label>

          <label class="on-field">
            <span>Current period end ISO</span>
            <input class="on-input" id="adminPeriodEnd" value="${a()(agency.currentPeriodEnd || subscription.currentPeriodEnd || "")}">
          </label>
        </div>

        <label class="on-field">
          <span>Reason</span>
          <input class="on-input" id="adminBillingReason" placeholder="manual support change">
        </label>

        <button class="on-btn primary" id="adminSaveBilling">Save workspace billing</button>
      </section>
    `;
  }

  function renderHealth(health) {
    return `
      <section class="admin-card">
        <div class="admin-card-head">
          <strong>Health</strong>
          ${healthBadge(health)}
        </div>

        <div class="admin-healthbar">
          <i style="width:${health.score}%"></i>
        </div>

        <div class="admin-issues">
          ${health.issues
            .map(
              (issue) => `
                <div class="admin-issue ${a()(issue.severity)}">
                  <b>${h()(issue.severity)}</b>
                  <span>${h()(issue.message)}</span>
                </div>
              `
            )
            .join("") || `<div class="admin-empty">No issues</div>`}
        </div>
      </section>
    `;
  }

  function renderCreatorDebug(creator) {
    return `
      <div class="admin-creator-debug">
        <div><b>ID</b><code>${h()(creator.id)}</code></div>
        <div><b>remoteId</b><code>${h()(creator.remoteId || "null")}</code></div>
        <div><b>username</b><code>${h()(creator.username || "null")}</code></div>
        <div><b>partition</b><code>${h()(creator.partition || "null")}</code></div>
        <div><b>created</b><code>${h()(dateShort(creator.createdAt))}</code></div>
        <div><b>updated</b><code>${h()(dateShort(creator.updatedAt))}</code></div>
      </div>
    `;
  }

  function renderCreatorBillingControls(creator) {
    const billing = creator.billingProfile || {};
    const currentTier = billing.tier || "STARTER";
    const currentPrice = billing.corePriceCents ?? TIERS[currentTier]?.price ?? 2000;

    return `
      <div class="admin-creator-billing">
        <label>
          <span>Creator tier</span>
          <select class="on-input admin-creator-tier" data-creator-tier="${a()(creator.id)}">
            ${Object.entries(TIERS)
              .map(([key, tier]) => `<option value="${key}" ${currentTier === key ? "selected" : ""}>${key} · ${money(tier.price)} · ${tier.revenue}</option>`)
              .join("")}
          </select>
        </label>

        <label>
          <span>Core cents</span>
          <input class="on-input" type="number" data-creator-price="${a()(creator.id)}" value="${a()(currentPrice)}">
        </label>

        <label>
          <span>AI cents</span>
          <input class="on-input" type="number" data-creator-ai-price="${a()(creator.id)}" value="${a()(billing.aiChatterPriceCents || 10000)}">
        </label>

        <label>
          <span>SFS cents</span>
          <input class="on-input" type="number" data-creator-outreach-price="${a()(creator.id)}" value="${a()(billing.outreachPriceCents || 2900)}">
        </label>

        <label class="admin-check">
          <input type="checkbox" data-creator-ai="${a()(creator.id)}" ${billing.aiChatterEnabled ? "checked" : ""}>
          <span>AI</span>
        </label>

        <label class="admin-check">
          <input type="checkbox" data-creator-outreach="${a()(creator.id)}" ${billing.outreachEnabled ? "checked" : ""}>
          <span>SFS</span>
        </label>

        <label class="admin-check">
          <input type="checkbox" data-creator-excluded="${a()(creator.id)}" ${billing.billingExcluded ? "checked" : ""}>
          <span>excluded</span>
        </label>

        <button class="on-btn primary" data-save-creator-billing="${a()(creator.id)}">Save creator billing</button>
      </div>
    `;
  }

  function renderCreators(agency) {
    const creators = agency.creators || [];

    return `
      <section class="admin-card">
        <div class="admin-card-head">
          <strong>Creator billing</strong>
          <span class="admin-muted">Plans live here, per creator account.</span>
        </div>

        <div class="admin-creator-header">
          <span>Creator</span>
          <span>Kind</span>
          <span>Status</span>
          <span>Identity</span>
          <span>Snapshots</span>
          <span>Billing</span>
          <span>Actions</span>
        </div>

        <div class="admin-creator-list">
          ${creators
            .map((creator) => {
              const kind = creatorKind(creator);
              const billing = creator.billingProfile || {};
              const expanded = state.expandedCreatorId === creator.id;
              const core = getCreatorCorePrice(creator);
              const addon = getCreatorAddonTotal(creator);
              const total = core + addon;

              return `
                <div class="admin-creator-row ${a()(kindClass(kind))}">
                  <div class="admin-creator-main">
                    <div>
                      <b>${h()(creator.displayName)}</b>
                      <em>${h()(creator.username ? "@" + creator.username : creator.remoteId || creator.partition || "")}</em>
                    </div>

                    <span class="admin-pill ${a()(kindClass(kind))}">${h()(kind)}</span>
                    <span>${h()(creator.status)}</span>

                    <span>
                      <b>${h()(creator.remoteId || "no remoteId")}</b>
                      <em>${h()(creator.partition || "no partition")}</em>
                    </span>

                    <span>${h()(creator.accessSnapshots?.filter((x) => x.active && !x.revokedAt).length || 0)} active</span>

                    <span>
                      <b>${h()(billing.tier || "STARTER")} · ${h()(money(core))}</b>
                      <em>${addon ? `addons ${money(addon)} · total ${money(total)}` : `total ${money(total)}`}</em>
                    </span>

                    <span class="admin-actions">
                      <button class="on-btn" data-toggle-creator="${a()(creator.id)}">${expanded ? "hide" : "inspect"}</button>
                      <button class="on-btn" data-admin-creator-status="${a()(creator.id)}" data-status="READY">ready</button>
                      <button class="on-btn" data-admin-creator-status="${a()(creator.id)}" data-status="DISABLED">disable</button>
                      <button class="on-btn danger" data-admin-delete-creator="${a()(creator.id)}">delete</button>
                    </span>
                  </div>

                  ${expanded ? `${renderCreatorDebug(creator)}${renderCreatorBillingControls(creator)}` : ""}
                </div>
              `;
            })
            .join("")}
        </div>
      </section>
    `;
  }

  function renderLiveFeed() {
    return `
      <section class="admin-card">
        <div class="admin-card-head">
          <strong>Live log</strong>
        </div>

        <div class="admin-feed">
          ${state.liveFeed
            .map(
              (event) => `
                <div class="admin-feed-row">
                  <time>${h()(dateShort(event.createdAt))}</time>
                  <b>${h()(event.action)}</b>
                  <span>${h()(event.actorUserId || "admin")}</span>
                  <small>${h()(event.targetType || "")} ${h()(event.targetId || "")}</small>
                </div>
              `
            )
            .join("") || `<div class="admin-empty">No events yet</div>`}
        </div>
      </section>
    `;
  }

  function render(root) {
    const agency = state.selectedAgency;
    const health = localHealth(agency);

    root.innerHTML = `
      <main class="admin-shell">
        <header class="admin-top">
          <div>
            <strong>Onlinod Internal Admin</strong>
            <span>workspace billing · creator billing · health · cleanup · live log</span>
          </div>
          <div class="admin-top-actions">
            <button class="on-btn" id="adminLogout">logout</button>
            <button class="on-btn" id="adminRefresh">refresh</button>
          </div>
        </header>

        ${state.error ? `<div class="admin-error">${h()(state.error)}</div>` : ""}

        <div class="admin-layout">
          <section class="admin-card">
            <div class="admin-card-head">
              <strong>Agencies</strong>
            </div>

            <div class="admin-agency-list">
              ${state.agencies
                .map(
                  (agencyRow) => `
                    <button class="admin-agency-row ${agencyRow.id === state.selectedAgencyId ? "active" : ""}" data-admin-agency="${a()(agencyRow.id)}">
                      <span>
                        <b>${h()(agencyRow.name)}</b>
                        <em>${h()(agencyRow.owner?.email || "no owner")}</em>
                      </span>
                      ${healthBadge(agencyRow.health)}
                      <small>${h()(agencyRow.status || "—")} · ${h()(agencyRow.counts?.creators || 0)} creators</small>
                    </button>
                  `
                )
                .join("")}
            </div>
          </section>

          <div class="admin-main">
            ${
              agency
                ? `
                  <section class="admin-card admin-hero">
                    <div>
                      <strong>${h()(agency.name)}</strong>
                      <span>${h()(agency.id)}</span>
                    </div>
                    ${healthBadge(health)}
                  </section>

                  ${renderWorkspaceBilling(agency)}
                  ${renderCreators(agency)}
                  ${renderHealth(health)}
                  ${renderLiveFeed()}
                `
                : `<section class="admin-card"><div class="admin-empty">Select agency</div></section>`
            }
          </div>
        </div>
      </main>
    `;

    bind(root);
  }

  async function reload(root) {
    await bootstrap();
    render(root);
  }

  function bind(root) {
    root.querySelector("#adminLogout")?.addEventListener("click", () => window.OnlinodAdminAuth.logout());
    root.querySelector("#adminRefresh")?.addEventListener("click", () => reload(root));

    root.querySelectorAll("[data-admin-agency]").forEach((el) => {
      el.addEventListener("click", async () => {
        state.selectedAgencyId = el.dataset.adminAgency;
        state.expandedCreatorId = null;
        await loadAgency(state.selectedAgencyId);
        await loadLiveFeed();
        render(root);
      });
    });

    root.querySelector("#adminSaveBilling")?.addEventListener("click", async () => {
      const result = await api().request(`/api/admin/agencies/${encodeURIComponent(state.selectedAgencyId)}/subscription`, {
        method: "PATCH",
        body: {
          plan: root.querySelector("#adminPlan").value,
          status: root.querySelector("#adminStatus").value,
          corePricePerCreatorCents: Number(root.querySelector("#adminCorePrice").value || 2000),
          currentPeriodEnd: root.querySelector("#adminPeriodEnd").value || null,
          reason: root.querySelector("#adminBillingReason").value || "manual workspace billing change",
        },
      });

      if (!result.ok) return window.OnlinodRouter.toast(result.error || "Save failed");
      await reload(root);
    });

    root.querySelectorAll("[data-toggle-creator]").forEach((el) => {
      el.addEventListener("click", () => {
        const id = el.dataset.toggleCreator;
        state.expandedCreatorId = state.expandedCreatorId === id ? null : id;
        render(root);
      });
    });

    root.querySelectorAll(".admin-creator-tier").forEach((el) => {
      el.addEventListener("change", () => {
        const id = el.dataset.creatorTier;
        const price = root.querySelector(`[data-creator-price="${CSS.escape(id)}"]`);
        const next = TIERS[el.value];

        if (price && next && el.value !== "CUSTOM") {
          price.value = String(next.price);
        }
      });
    });

    root.querySelectorAll("[data-save-creator-billing]").forEach((el) => {
      el.addEventListener("click", async () => {
        const id = el.dataset.saveCreatorBilling;

        const result = await api().request(`/api/admin/creators/${encodeURIComponent(id)}/billing`, {
          method: "PATCH",
          body: {
            tier: root.querySelector(`[data-creator-tier="${CSS.escape(id)}"]`)?.value || "STARTER",
            tierMode: "MANUAL",
            corePriceCents: Number(root.querySelector(`[data-creator-price="${CSS.escape(id)}"]`)?.value || 2000),
            aiChatterEnabled: root.querySelector(`[data-creator-ai="${CSS.escape(id)}"]`)?.checked === true,
            aiChatterPriceCents: Number(root.querySelector(`[data-creator-ai-price="${CSS.escape(id)}"]`)?.value || 10000),
            outreachEnabled: root.querySelector(`[data-creator-outreach="${CSS.escape(id)}"]`)?.checked === true,
            outreachPriceCents: Number(root.querySelector(`[data-creator-outreach-price="${CSS.escape(id)}"]`)?.value || 2900),
            billingExcluded: root.querySelector(`[data-creator-excluded="${CSS.escape(id)}"]`)?.checked === true,
            reason: "manual creator billing update",
          },
        });

        if (!result.ok) return window.OnlinodRouter.toast(result.error || "Creator billing save failed");
        await reload(root);
      });
    });

    root.querySelectorAll("[data-admin-creator-status]").forEach((el) => {
      el.addEventListener("click", async () => {
        const result = await api().request(`/api/admin/creators/${encodeURIComponent(el.dataset.adminCreatorStatus)}/status`, {
          method: "PATCH",
          body: { status: el.dataset.status, reason: "manual admin status change" },
        });

        if (!result.ok) return window.OnlinodRouter.toast(result.error || "Status failed");
        await reload(root);
      });
    });

    root.querySelectorAll("[data-admin-delete-creator]").forEach((el) => {
      el.addEventListener("click", async () => {
        const id = el.dataset.adminDeleteCreator;
        const creator = (state.selectedAgency?.creators || []).find((x) => x.id === id);
        const summary = creator
          ? `${creator.displayName}\nremoteId: ${creator.remoteId || "null"}\npartition: ${creator.partition || "null"}\nid: ${creator.id}`
          : id;

        if (!confirm(`Delete creator?\n\n${summary}`)) return;

        const result = await api().request(`/api/admin/creators/${encodeURIComponent(id)}`, { method: "DELETE" });
        if (!result.ok) return window.OnlinodRouter.toast(result.error || "Delete failed");

        await reload(root);
      });
    });
  }

  async function start(root) {
    root.innerHTML = `<main class="admin-shell"><div class="admin-card">Loading admin…</div></main>`;
    await bootstrap();
    render(root);
  }

  async function guardedStart(root) {
    const ok = await window.OnlinodAdminAuth.ensureAdminSession(root);
    if (!ok) return;
    await start(root);
  }

  window.OnlinodAdminPage = { render: guardedStart };
})();
