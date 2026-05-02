/* public/admin/modules/admin-agency-detail/admin-agency-detail-tabs.js
   ────────────────────────────────────────────────────────────
   The remaining 4 tabs of agency detail.
   
   - Members:      list with role select, kick button, last-OWNER guard
                   handled by backend (UI shows error toast on 409).
   - Creators:     list with status pill, billing tier, snapshot dot,
                   delete (soft) button. Click opens TODO note.
   - Subscription: form to edit plan/status/period/notes.
   - Audit:        last 30 admin action logs scoped to this agency.
   ──────────────────────────────────────────────────────────── */

(function () {
  "use strict";

  const R = () => window.OnlinodAdminRouter;
  const U = () => window.OnlinodAdminUtils;
  const Actions = () => window.OnlinodAdminAgencyDetailActions;

  // ════════════════════════════════════════════════════════════
  // Members
  // ════════════════════════════════════════════════════════════

  function renderMembers(slice) {
    const r = R();
    const u = U();
    const a = slice.data.agency;
    const members = a.members || [];

    if (!members.length) {
      return `<div class="adm-card"><div class="adm-empty">No members yet.</div></div>`;
    }

    return `
      <div class="adm-card">
        <div class="adm-card-head">
          <div class="adm-card-title">Members · ${r.escapeHtml(String(members.length))}</div>
        </div>

        <div class="adm-table-wrap" style="border:none;">
          <table class="adm-table">
            <thead>
              <tr>
                <th>email</th>
                <th>name</th>
                <th>role</th>
                <th>joined</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${members.map((m) => `
                <tr>
                  <td>
                    <div class="adm-cell-name">
                      ${u.letterAvatar(m.user?.email, 26)}
                      <div class="adm-cell-name-main">
                        <div class="adm-cell-name-strong">${r.escapeHtml(m.user?.email || "—")}</div>
                        <div class="adm-cell-name-sub">${r.escapeHtml(m.user?.id || "")}</div>
                      </div>
                    </div>
                  </td>
                  <td class="adm-cell-mono">${r.escapeHtml(m.user?.name || "—")}</td>
                  <td>
                    <select class="adm-select" data-member-role="${r.escapeAttr(m.id)}" style="width:140px;">
                      <option value="OWNER"    ${m.role === "OWNER"    ? "selected" : ""}>OWNER</option>
                      <option value="ADMIN"    ${m.role === "ADMIN"    ? "selected" : ""}>ADMIN</option>
                      <option value="MANAGER"  ${m.role === "MANAGER"  ? "selected" : ""}>MANAGER</option>
                      <option value="OPERATOR" ${m.role === "OPERATOR" ? "selected" : ""}>OPERATOR</option>
                    </select>
                  </td>
                  <td class="adm-cell-mono">${r.escapeHtml(u.timeAgo(m.createdAt))}</td>
                  <td>
                    <button class="adm-btn danger" data-member-kick="${r.escapeAttr(m.id)}" data-member-email="${r.escapeAttr(m.user?.email || "")}">kick</button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function bindMembers(main, slice) {
    main.querySelectorAll("[data-member-role]").forEach((sel) => {
      const original = sel.value;
      sel.addEventListener("change", async () => {
        const memberId = sel.dataset.memberRole;
        const newRole  = sel.value;
        await Actions().changeMemberRole(memberId, newRole, () => {
          // On error (e.g. last owner), revert select.
          sel.value = original;
        });
      });
    });

    main.querySelectorAll("[data-member-kick]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const memberId = btn.dataset.memberKick;
        const email    = btn.dataset.memberEmail || "this member";
        if (!confirm(`Remove ${email} from this agency?\n\nTheir refresh sessions will be revoked. They keep their user account.`)) return;
        await Actions().kickMember(memberId);
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // Creators
  // ════════════════════════════════════════════════════════════

  function renderCreators(slice) {
    const r = R();
    const u = U();
    const a = slice.data.agency;
    const creators = (a.creators || []).filter((c) => !c.deletedAt);
    const deleted  = (a.creators || []).filter((c) => c.deletedAt);

    if (!creators.length && !deleted.length) {
      return `<div class="adm-card"><div class="adm-empty">No creators yet.</div></div>`;
    }

    const renderRow = (c, muted) => {
      const snap = (c.accessSnapshots || []).find((s) => s.active && !s.revokedAt);
      const tier = c.billingProfile?.tier || "—";
      return `
        <tr ${muted ? `class="muted"` : ""}>
          <td>
            <div class="adm-cell-name">
              ${u.letterAvatar(c.displayName, 26)}
              <div class="adm-cell-name-main">
                <div class="adm-cell-name-strong">${r.escapeHtml(c.displayName || "—")}</div>
                <div class="adm-cell-name-sub">${c.username ? "@" + r.escapeHtml(c.username) : r.escapeHtml(c.id.slice(-10))}</div>
              </div>
            </div>
          </td>
          <td>${u.statusPill(c.status)}</td>
          <td class="adm-cell-mono">${r.escapeHtml(tier.toLowerCase())}</td>
          <td>
            ${
              snap
                ? `<span class="adm-pill ok no-dot">active</span>`
                : `<span class="adm-pill muted no-dot">none</span>`
            }
          </td>
          <td class="adm-cell-mono">${r.escapeHtml(u.formatDate(c.createdAt))}</td>
          <td>
            ${
              c.deletedAt
                ? `<span style="font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);">deleted ${r.escapeHtml(u.formatDate(c.deletedAt))}</span>`
                : `<button class="adm-btn danger" data-creator-delete="${r.escapeAttr(c.id)}" data-creator-name="${r.escapeAttr(c.displayName || "")}">delete</button>`
            }
          </td>
        </tr>
      `;
    };

    return `
      <div class="adm-card">
        <div class="adm-card-head">
          <div class="adm-card-title">Creators · ${r.escapeHtml(String(creators.length))} active${deleted.length ? ` + ${r.escapeHtml(String(deleted.length))} deleted` : ""}</div>
        </div>

        <div class="adm-table-wrap" style="border:none;">
          <table class="adm-table">
            <thead>
              <tr>
                <th>creator</th>
                <th>status</th>
                <th>tier</th>
                <th>snapshot</th>
                <th>created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${creators.map((c) => renderRow(c, false)).join("")}
              ${deleted.map((c) => renderRow(c, true)).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function bindCreators(main, slice) {
    main.querySelectorAll("[data-creator-delete]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id   = btn.dataset.creatorDelete;
        const name = btn.dataset.creatorName || "this creator";
        if (!confirm(`Soft-delete ${name}?\n\nActive snapshots will be revoked. Soft delete is reversible — admin can restore later.`)) return;
        await Actions().deleteCreator(id);
      });
    });
  }

  // ════════════════════════════════════════════════════════════
  // Subscription
  // ════════════════════════════════════════════════════════════

  function renderSubscription(slice) {
    const r = R();
    const u = U();
    const a = slice.data.agency;
    const sub = (a.subscriptions || [])[0] || null;

    return `
      <div class="adm-card">
        <div class="adm-card-head">
          <div class="adm-card-title">Subscription</div>
        </div>

        <div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:14px;">
          <div class="adm-field">
            <label>plan</label>
            <input class="adm-input" id="admSubPlan"   value="${r.escapeAttr(a.plan || "dev")}">
          </div>
          <div class="adm-field">
            <label>status</label>
            <select class="adm-select" id="admSubStatus" style="width:100%;">
              ${["TRIAL","ACTIVE","GRACE","PAST_DUE","LOCKED","CANCELLED"].map((s) => `
                <option value="${s}" ${(a.status || "TRIAL") === s ? "selected" : ""}>${s.toLowerCase()}</option>
              `).join("")}
            </select>
          </div>

          <div class="adm-field">
            <label>core price per creator (cents)</label>
            <input class="adm-input mono" id="admSubCore" type="number" min="0" value="${r.escapeAttr(String(sub?.corePricePerCreatorCents ?? 2000))}">
          </div>
          <div class="adm-field">
            <label>trial ends at (ISO)</label>
            <input class="adm-input mono" id="admSubTrial" placeholder="2026-06-01T00:00:00Z" value="${r.escapeAttr(a.trialEndsAt ? new Date(a.trialEndsAt).toISOString() : "")}">
          </div>

          <div class="adm-field" style="grid-column:1 / -1;">
            <label>current period end (ISO)</label>
            <input class="adm-input mono" id="admSubPeriod" placeholder="2026-12-31T23:59:59Z" value="${r.escapeAttr(a.currentPeriodEnd ? new Date(a.currentPeriodEnd).toISOString() : "")}">
          </div>

          <div class="adm-field" style="grid-column:1 / -1;">
            <label>reason for change (audit)</label>
            <input class="adm-input" id="admSubReason" placeholder="e.g. promo extended for 1 month">
          </div>
        </div>

        <div style="display:flex;gap:8px;margin-top:6px;">
          <button class="adm-btn primary" id="admSubSave">Save subscription</button>
          ${sub ? `<span style="font-family:var(--adm-mono);font-size:11px;color:var(--adm-muted);align-self:center;">last updated ${r.escapeHtml(u.timeAgo(sub.updatedAt))}</span>` : ""}
        </div>
      </div>
    `;
  }

  function bindSubscription(main, slice) {
    const save = main.querySelector("#admSubSave");
    if (!save) return;

    save.addEventListener("click", async () => {
      const plan      = main.querySelector("#admSubPlan").value.trim();
      const status    = main.querySelector("#admSubStatus").value;
      const coreRaw   = main.querySelector("#admSubCore").value.trim();
      const trialRaw  = main.querySelector("#admSubTrial").value.trim();
      const periodRaw = main.querySelector("#admSubPeriod").value.trim();
      const reason    = main.querySelector("#admSubReason").value.trim();

      const body = {
        plan: plan || undefined,
        status,
        corePricePerCreatorCents: coreRaw ? Number(coreRaw) : undefined,
        trialEndsAt: trialRaw || null,
        currentPeriodEnd: periodRaw || null,
        reason: reason || undefined,
      };

      await Actions().saveSubscription(slice.data.agency.id, body);
    });
  }

  // ════════════════════════════════════════════════════════════
  // Audit
  // ════════════════════════════════════════════════════════════

  function renderAudit(slice) {
    const r = R();
    const u = U();
    const logs = slice.data.agency.adminActionLogs || [];

    if (!logs.length) {
      return `<div class="adm-card"><div class="adm-empty">No admin actions on this agency yet.</div></div>`;
    }

    return `
      <div class="adm-card">
        <div class="adm-card-head">
          <div class="adm-card-title">Admin actions · ${r.escapeHtml(String(logs.length))}</div>
        </div>

        <div class="adm-table-wrap" style="border:none;">
          <table class="adm-table">
            <thead>
              <tr>
                <th>time</th>
                <th>action</th>
                <th>target</th>
                <th>reason</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              ${logs.map((l) => `
                <tr>
                  <td class="adm-cell-mono">${r.escapeHtml(u.formatDateTime(l.createdAt))}</td>
                  <td><span class="adm-pill muted no-dot">${r.escapeHtml(l.action)}</span></td>
                  <td class="adm-cell-mono">
                    ${l.targetType ? `${r.escapeHtml(l.targetType)} ${r.escapeHtml(String(l.targetId || "").slice(-8))}` : "—"}
                  </td>
                  <td class="adm-cell-mono">${r.escapeHtml(l.reason || "—")}</td>
                  <td>
                    <button class="adm-btn ghost" data-audit-show="${r.escapeAttr(l.id)}">view diff</button>
                  </td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function bindAudit(main, slice) {
    main.querySelectorAll("[data-audit-show]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.dataset.auditShow;
        const log = (slice.data.agency.adminActionLogs || []).find((l) => l.id === id);
        if (!log) return;

        const before = JSON.stringify(log.before || null, null, 2);
        const after  = JSON.stringify(log.after  || null, null, 2);
        // Simple modal-less view: show in alert. We can build a real
        // diff viewer in заход 5 (audit page).
        alert(`BEFORE:\n${before}\n\nAFTER:\n${after}`);
      });
    });
  }

  window.OnlinodAdminAgencyDetailTabs = {
    renderMembers,      bindMembers,
    renderCreators,     bindCreators,
    renderSubscription, bindSubscription,
    renderAudit,        bindAudit,
  };
})();
