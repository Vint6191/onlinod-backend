/* public/admin/modules/admin-agency-detail/admin-agency-detail-overview.js
   ────────────────────────────────────────────────────────────
   The Overview tab. Shows a quick-glance summary of one agency:
     - 4 metric cards (creators ready/total, members, snapshots,
       MRR sum)
     - Recent members preview (3 newest)
     - Recent creators preview (3 newest)
     - Recent admin actions on this agency
   
   For full lists / actions the user clicks tabs.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const R = () => window.OnlinodAdminRouter;
  const U = () => window.OnlinodAdminUtils;

  function render(slice) {
    const r = R();
    const u = U();
    const a = slice.data.agency;

    const creators       = (a.creators || []).filter((c) => !c.deletedAt);
    const readyCreators  = creators.filter((c) => c.status === "READY");
    const activeSnaps    = (a.accessSnapshots || []).filter((s) => s.active && !s.revokedAt);

    // MRR estimate from billing profiles in this agency.
    let mrrCents = 0;
    for (const c of creators) {
      const b = c.billingProfile;
      if (!b || b.billingExcluded) continue;
      mrrCents += Number(b.corePriceCents || 0);
      if (b.aiChatterEnabled) mrrCents += Number(b.aiChatterPriceCents || 0);
      if (b.outreachEnabled)  mrrCents += Number(b.outreachPriceCents || 0);
    }

    return `
      <section class="adm-metric-grid">
        ${metric("creators",   `${readyCreators.length}/${creators.length}`, "ready / total")}
        ${metric("members",    String((a.members || []).length), "team")}
        ${metric("snapshots",  String(activeSnaps.length), "active OF access")}
        ${metric("mrr (est)",  u.formatMoneyFromCents(mrrCents), "core + addons")}
      </section>

      <section style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:6px;">
        <div class="adm-card">
          <div class="adm-card-head">
            <div class="adm-card-title">Members preview</div>
            <button class="adm-card-action" data-agtab-jump="members">view all →</button>
          </div>
          ${
            (a.members || []).length
              ? renderMembersPreview(a.members.slice(0, 5))
              : `<div class="adm-empty">No members.</div>`
          }
        </div>

        <div class="adm-card">
          <div class="adm-card-head">
            <div class="adm-card-title">Creators preview</div>
            <button class="adm-card-action" data-agtab-jump="creators">view all →</button>
          </div>
          ${
            creators.length
              ? renderCreatorsPreview(creators.slice(0, 5))
              : `<div class="adm-empty">No creators.</div>`
          }
        </div>
      </section>

      <section class="adm-card" style="margin-top:12px;">
        <div class="adm-card-head">
          <div class="adm-card-title">Recent actions on this agency</div>
          <button class="adm-card-action" data-agtab-jump="audit">view all →</button>
        </div>
        ${
          (a.adminActionLogs || []).length
            ? renderActionsPreview(a.adminActionLogs.slice(0, 8))
            : `<div class="adm-empty">No admin actions yet.</div>`
        }
      </section>
    `;
  }

  function metric(label, value, hint) {
    const r = R();
    return `
      <div class="adm-metric">
        <div class="adm-metric-label">${r.escapeHtml(label)}</div>
        <div class="adm-metric-value">${r.escapeHtml(value)}</div>
        <div class="adm-metric-hint">${r.escapeHtml(hint)}</div>
      </div>
    `;
  }

  function renderMembersPreview(members) {
    const r = R();
    const u = U();
    return `
      <div style="display:flex;flex-direction:column;">
        ${members.map((m) => `
          <div style="
            display:flex;align-items:center;gap:10px;
            padding:10px 0;border-top:1px solid var(--adm-line);
          ">
            ${u.letterAvatar(m.user?.email, 28)}
            <div style="flex:1;min-width:0;">
              <div style="font-size:12.5px;color:var(--adm-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                ${r.escapeHtml(m.user?.email || "—")}
              </div>
              <div style="font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);">
                joined ${r.escapeHtml(u.timeAgo(m.createdAt))}
              </div>
            </div>
            <span class="adm-pill ${m.role === "OWNER" ? "warn" : "muted"} no-dot">
              ${r.escapeHtml(String(m.role).toLowerCase())}
            </span>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderCreatorsPreview(creators) {
    const r = R();
    const u = U();
    return `
      <div style="display:flex;flex-direction:column;">
        ${creators.map((c) => `
          <div style="
            display:flex;align-items:center;gap:10px;
            padding:10px 0;border-top:1px solid var(--adm-line);
          ">
            ${u.letterAvatar(c.displayName, 28)}
            <div style="flex:1;min-width:0;">
              <div style="font-size:12.5px;color:var(--adm-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                ${r.escapeHtml(c.displayName || "—")}
              </div>
              <div style="font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);">
                ${c.username ? "@" + r.escapeHtml(c.username) : r.escapeHtml(c.id.slice(-8))}
              </div>
            </div>
            <span class="adm-pill ${creatorStatusClass(c.status)} no-dot">
              ${r.escapeHtml(String(c.status || "—").toLowerCase())}
            </span>
          </div>
        `).join("")}
      </div>
    `;
  }

  function renderActionsPreview(actions) {
    const r = R();
    const u = U();
    return `
      <div style="display:flex;flex-direction:column;">
        ${actions.map((act) => `
          <div style="
            display:flex;align-items:center;gap:10px;
            padding:9px 0;border-top:1px solid var(--adm-line);
          ">
            <div style="font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);min-width:90px;">
              ${r.escapeHtml(u.timeAgo(act.createdAt))}
            </div>
            <div style="flex:1;font-size:12.5px;">${r.escapeHtml(act.action)}</div>
            ${act.reason ? `<div style="font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);">${r.escapeHtml(act.reason)}</div>` : ""}
          </div>
        `).join("")}
      </div>
    `;
  }

  function creatorStatusClass(status) {
    const s = String(status || "").toUpperCase();
    if (s === "READY")        return "ok";
    if (s === "DRAFT")        return "info";
    if (s === "NOT_CREATOR")  return "warn";
    if (s === "AUTH_FAILED")  return "crit";
    if (s === "DISABLED")     return "muted";
    return "muted";
  }

  function bind(main, slice) {
    main.querySelectorAll("[data-agtab-jump]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        slice.tab = btn.dataset.agtabJump;
        window.OnlinodAdminAgencyDetail.rerender();
      });
    });
  }

  window.OnlinodAdminAgencyDetailOverview = { render, bind };
})();
