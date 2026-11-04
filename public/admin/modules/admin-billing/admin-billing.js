/* Model subscriptions: agency-scoped reads, separate pricing and access commands. */
(function () {
  "use strict";
  const A = () => window.NodAdminApi,
    R = () => window.NodAdminRouter,
    W = () => window.NodAdminWorkspace;
  const esc = (v) => R().escapeHtml(v);
  const money = (c) => "$" + (Number(c || 0) / 100).toFixed(2);
  const date = (value) => (value ? esc(String(value).slice(0, 10)) : "—");
  const local = W().local(() => ({ agencyId: null, overviewAfter: null, modelsAfter: null }));
  function pageControls(page, after) {
    return `<div class="adm-pagination"><span>До ${Number(page?.limit || 100)} записей на странице</span><button class="adm-btn bl-page-first" ${after ? "" : "disabled"}>В начало</button><button class="adm-btn bl-page-next" ${page?.nextCursor ? "" : "disabled"}>Далее →</button></div>`;
  }
  function bindPage(root, page, go) {
    root.querySelector(".bl-page-first")?.addEventListener("click", () => go(null));
    root.querySelector(".bl-page-next")?.addEventListener("click", () => go(page.nextCursor));
  }
  async function render(main) {
    const agencyId = window.NodAdminState.sectionParam;
    if (agencyId !== local.agencyId) local.modelsAfter = null;
    local.agencyId = agencyId;
    return agencyId ? renderAgency(main, agencyId) : renderOverview(main);
  }
  function catalogMarkup(catalog) {
    if (!catalog?.ok) return '<div class="adm-muted">Каталог недоступен. Обновите страницу.</div>';
    return `<div class="adm-tier-grid">${Object.entries(catalog.tiers || {})
      .map(
        ([key, tier]) =>
          `<article class="adm-tier-card"><span class="adm-tier" data-tier="${esc(key)}">${esc(tier.label)}</span><strong>${key === "CUSTOM" ? "Индивидуально" : money(tier.priceCents)}<small>${key === "CUSTOM" ? "" : " / месяц"}</small></strong><span>${esc(tier.revenueLabel || "Индивидуальные условия")}</span></article>`
      )
      .join(
        ""
      )}</div><p class="adm-muted">Дополнения: AI Chatter ${money(catalog.addons?.aiChatterPriceCents)} / мес · SFS + Comment Bot ${money(catalog.addons?.outreachPriceCents)} / мес. У каждого дополнения отдельный срок доступа.</p>`;
  }
  async function renderOverview(main) {
    const current = W().request(main);
    main.innerHTML = '<div class="adm-loading">Загружаем подписки…</div>';
    const [result, tiers] = await Promise.allSettled([A().billingOverview(local.overviewAfter), A().billingTiers()]);
    if (!current()) return;
    const r = result.value,
      catalog = tiers.value;
    if (!r?.ok) return W().failure(main, r?.error || "Не удалось загрузить подписки", () => renderOverview(main));
    const m = r.mrr || {};
    const rows = (r.agencies || [])
      .map(
        (a) =>
          `<tr><td><button class="adm-link" data-agency="${esc(a.agencyId)}">${esc(a.name)}</button><div class="adm-muted">${esc(a.agencyId)}</div></td><td><span class="adm-pill ${a.billable ? "ok" : "muted"}">${esc(a.status)}</span></td><td>${esc(a.modelsBilled)} / ${esc(a.modelsTotal)}</td><td class="adm-money">${money(a.monthlyCents)}</td><td class="adm-muted">AI ${money(a.addons?.aiChatter)}<br>SFS ${money(a.addons?.outreach)}</td><td><button class="adm-btn adm-btn-sm" data-agency="${esc(a.agencyId)}">Подписки моделей →</button></td></tr>`
      )
      .join("");
    main.innerHTML = `<div class="adm-page-head"><div><p class="adm-eyebrow">Платформа / Биллинг</p><h1>Подписки моделей</h1><p class="adm-page-subtitle">Свой уровень, цена и период доступа у каждой модели внутри агентства.</p></div></div>
      <div class="adm-kpi-row">${[
        ["Активные периоды, $/мес", money(m.billedCents)],
        ["Модели с платным доступом", m.billedModels || 0],
        ["Агентства с платными моделями", `${m.billableAgencies || 0} / ${m.totalAgencies || 0}`],
        ["Настроенная стоимость trial", money(m.trialPotentialCents)],
      ]
        .map(
          ([label, value]) =>
            `<div class="adm-kpi"><div class="adm-kpi-label">${label}</div><div class="adm-kpi-val">${esc(value)}</div></div>`
        )
        .join("")}</div>
      <details class="adm-card"><summary>Уровни подписки и общий каталог цен</summary>${catalogMarkup(catalog)}<div id="blCommercialPolicy"></div></details>
      <div class="adm-card"><div class="adm-card-head"><div class="adm-card-title">Агентства и их модели</div><span class="adm-muted">Итоги по действующим периодам</span></div><div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>Агентство</th><th>Сводный статус</th><th>Активные / всего</th><th>Стоимость в месяц</th><th>Дополнения</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="adm-empty">Агентств пока нет</td></tr>'}</tbody></table></div>${pageControls(r.page, local.overviewAfter)}</div><p class="adm-muted">Сумма рассчитана по действующим периодам доступа, а не по поступлениям денег. Общего оплаченного срока на всё агентство нет.</p>`;
    const policy = main.querySelector("#blCommercialPolicy"),
      details = policy.closest("details");
    let loaded = false;
    details.addEventListener("toggle", () => {
      if (details.open && !loaded) {
        loaded = true;
        window.NodAdminCommercialPolicy.render(policy);
      }
    });
    main
      .querySelectorAll("[data-agency]")
      .forEach((el) => el.addEventListener("click", () => R().pushDetail("billing", el.dataset.agency)));
    bindPage(main, r.page, (after) => {
      local.overviewAfter = after;
      return renderOverview(main);
    });
  }
  function accessMarkup(m) {
    const ent = m.entitlement || {},
      access = m.access;
    const label =
      {
        FREE_INTERNAL: "Внутренний доступ",
        TRIAL: "Пробный доступ",
        PAID: "Действует",
        BILLING_ACCESS_HELD: "Блокировка агентства",
        CREATOR_SUBSCRIPTION_REQUIRED: "Нет доступа",
      }[access?.reason] || "Статус не получен";
    return `<span class="adm-pill ${access?.allowed ? "ok" : access?.reason === "BILLING_ACCESS_HELD" ? "crit" : "warn"}">${label}</span><div class="adm-cell-sub">${ent.coreValidUntil ? `Core до ${date(ent.coreValidUntil)}` : "Core не выдан"}</div>${access?.reason === "TRIAL" ? `<div class="adm-cell-sub">Trial до ${date(access.validUntil)}</div>` : ""}`;
  }
  function addonsMarkup(m) {
    const ent = m.entitlement || {};
    return [
      ["aiChatter", "AI"],
      ["outreach", "SFS"],
    ]
      .map(
        ([key, label]) =>
          `<div class="adm-addon-status"><span class="adm-pill ${ent[key + "Active"] ? "ok" : "muted"}">${label}</span><span class="adm-muted">${ent[key + "ValidUntil"] ? date(ent[key + "ValidUntil"]) : "не выдан"}</span></div>`
      )
      .join("");
  }
  async function renderAgency(main, agencyId, options = {}) {
    const current = W().request(main);
    main.innerHTML = '<div class="adm-loading">Загружаем модели агентства…</div>';
    const r = await A().billingAgency(agencyId, local.modelsAfter);
    if (!current()) return;
    if (!r?.ok)
      return W().failure(main, r?.error || "Не удалось загрузить модели", () => renderAgency(main, agencyId, options));
    const tierOpts = Object.entries(r.tiers || {})
      .map(
        ([key, t]) =>
          `<option value="${esc(key)}">${esc(t.label)} · ${key === "CUSTOM" ? "своя цена" : money(t.priceCents)}</option>`
      )
      .join("");
    const rows = (r.models || [])
      .map((m) => {
        const tier = m.entitlement?.tier || m.tier || "STARTER";
        const session =
          { ACTIVE: "Сессия сохранена", REVOKED: "Вход отозван", REINITIALIZING: "Переподключение" }[m.sessionStatus] ||
          "Нет сессии";
        return `<tr data-creator="${esc(m.creatorId)}" data-pricing-revision="${Number(m.pricingRevision || 0)}" class="${m.billingExcluded ? "adm-row-excluded" : ""}"><td><div class="adm-model-name"><input class="bl-select" type="checkbox" aria-label="Выбрать ${esc(m.displayName || m.creatorId)}" ${m.billingExcluded ? "disabled" : ""}><div><button class="adm-link bl-model">${esc(m.displayName || m.username || m.creatorId)}</button><div class="adm-cell-sub">@${esc(m.username || "—")} · ${esc(m.creatorStatus || "")}</div></div></div></td>
        <td><span class="adm-tier" data-tier="${esc(tier)}">${esc(r.tiers?.[tier]?.label || tier)}</span><div class="adm-cell-sub">${m.tierMode === "MANUAL" ? "Ручной выбор" : "По доходу"}${m.tier && tier !== m.tier ? ` · далее ${esc(m.tier)}` : ""}</div></td>
        <td>${accessMarkup(m)}</td><td>${addonsMarkup(m)}</td><td><span class="adm-pill ${m.sessionStatus === "ACTIVE" ? "info" : "muted"}">${session}</span></td><td class="adm-money">${money(m.configuredLineCents)}<div class="adm-cell-sub">${m.billingExcluded ? "исключена" : "настроено / мес"}</div></td>
        <td><div class="adm-row-actions"><button class="adm-btn adm-btn-sm bl-pricing">Тариф</button><button class="adm-btn adm-btn-sm bl-access">Доступ</button></div></td></tr>`;
      })
      .join("");
    const banner = r.agency.billingSupportHold
      ? `<strong>Агентство заблокировано.</strong> Сроки моделей сохранены. ${esc(r.agency.billingSupportHoldReason || "")}`
      : r.agency.billingMode === "FREE_INTERNAL"
        ? "<strong>Внутренний доступ агентства.</strong> Это отдельное исключение для разработки; оно не означает оплату подписок моделей."
        : r.agency.trialEndsAt
          ? `Пробный период агентства до ${date(r.agency.trialEndsAt)}. Платные периоды моделей независимы.`
          : "Подписка, дополнения и срок доступа принадлежат конкретной модели. Состояние входа в OnlyFans отображается отдельно.";
    main.innerHTML = `<div class="adm-page">
      ${options.embedded ? "" : `<div class="adm-detail-head"><button class="adm-link" id="blBack">← Подписки моделей</button><h1>${esc(r.agency.name)}</h1><p class="adm-detail-sub">Подписки моделей агентства</p></div>`}
      ${options.embedded ? "" : window.NodAdminDevelopmentAccess.render(r.agency)}
      <div class="adm-notice">${banner}</div>
      <div class="adm-kpi-row adm-model-metrics"><div class="adm-kpi"><div class="adm-kpi-label">Моделей в агентстве</div><div class="adm-kpi-val">${Number(r.modelsTotal ?? r.models.length)}</div></div><div class="adm-kpi"><div class="adm-kpi-label">Настроенная стоимость / мес</div><div class="adm-kpi-val">${money(r.configuredMonthlyCents)}</div></div><div class="adm-kpi"><div class="adm-kpi-label">Действующие периоды / мес</div><div class="adm-kpi-val">${money(r.monthlyCents)}</div></div></div>
      <div class="adm-card"><div class="adm-card-head"><div class="adm-card-title">${options.models ? "Модели агентства" : "Подписки и доступ"}</div><span class="adm-muted">Сроки указаны в UTC</span></div><div class="adm-table-wrap"><table class="adm-table adm-billing-table"><thead><tr><th>Модель</th><th>Уровень</th><th>Доступ NOD / Core</th><th>Дополнения до</th><th>OnlyFans</th><th>Стоимость</th><th></th></tr></thead><tbody>${rows || '<tr><td colspan="7" class="adm-empty">В агентстве пока нет моделей</td></tr>'}</tbody></table></div>${pageControls(r.page, local.modelsAfter)}</div>
      <details class="adm-card"><summary>Массовое изменение тарифа выбранных моделей</summary><p class="adm-muted">Только отмеченные модели на этой странице, максимум 100. Оплаченные периоды не изменятся. Исключённые модели недоступны для массовой смены.</p>
        <div class="adm-bulk-bar"><label>Уровень <select id="blBulkTier">${tierOpts}</select></label><label>Цена Custom, USD <input id="blBulkCustomPrice" type="number" min="0" max="10000" step="0.01" placeholder="Индивидуальная цена"></label><input id="blBulkReason" maxlength="500" aria-label="Причина массового изменения" placeholder="Причина изменения"><button class="adm-btn primary" id="blBulkApply">Применить к выбранным</button><button class="adm-btn" id="blBulkCheck">Проверить выполнение</button><button class="adm-btn" id="blBulkCancel">Отменить оставшиеся</button><button class="adm-btn" id="blBulkResume" disabled>Продолжить оставшиеся</button><span id="blBulkProgress" role="status"></span><details><summary>Результат по каждой модели</summary><pre id="blBulkOutcomes"></pre></details></div></details></div>`;
    if (!options.embedded) window.NodAdminDevelopmentAccess.bind(main, r.agency, () => renderAgency(main,agencyId,options));
    bindPage(main, r.page, (after) => {
      local.modelsAfter = after;
      return renderAgency(main, agencyId, options);
    });
    main.querySelector("#blBack")?.addEventListener("click", () => R().pushSection("billing"));
    main.querySelectorAll("tr[data-creator]").forEach((tr) => {
      const model = {
        ...r.models.find((m) => m.creatorId === tr.dataset.creator),
        agencyId,
        agencyName: r.agency.name,
      };
      const reload = () => {
        if (current()) return renderAgency(main, agencyId, options);
      };
      tr.querySelector(".bl-model")?.addEventListener("click", () => R().pushDetail("creators", model.creatorId));
      tr.querySelector(".bl-pricing")?.addEventListener("click", () => window.NodAdminPricing.open(model, r, reload));
      tr.querySelector(".bl-access")?.addEventListener("click", () => window.NodAdminEntitlements.open(model, reload));
    });
    const bulkStorageKey = `onlinod_admin_bulk:${window.NodAdminState.admin.id}:${agencyId}`;
    let bulkCommandId = null;
    try {
      bulkCommandId = sessionStorage.getItem(bulkStorageKey);
    } catch (_) {}
    let submitting = false;
    let resumePayload = null;
    const progressEl = main.querySelector("#blBulkProgress");
    async function checkBulk() {
      if (!bulkCommandId) {
        progressEl.textContent = "No submitted command in this tab.";
        return;
      }
      const status = await A().commandStatus(bulkCommandId);
      if (!current()) return;
      if (!status?.ok) {
        progressEl.textContent = status?.error || "Result unknown; retry the same selection.";
        return;
      }
      const p = status.execution?.progress;
      resumePayload = status.execution?.resume || null;
      main.querySelector("#blBulkResume").disabled = !resumePayload;
      main.querySelector("#blBulkOutcomes").textContent = (p?.outcomes || [])
        .map((item) => `${item.creatorId}: ${item.status}${item.code ? " / " + item.code : ""}`)
        .join("\n");
      progressEl.textContent = `${status.status}${status.execution?.workState === "RECONCILE_REQUIRED" ? " / RECONCILE_REQUIRED" : ""}: ${p?.nextIndex || 0}/${p?.total || 0}, changed ${p?.succeeded || 0}, rejected ${p?.rejected || 0}, skipped ${p?.skipped || 0}. ${p?.stoppedCode || ""}`;
    }
    main.querySelector("#blBulkCheck").addEventListener("click", () =>
      checkBulk().catch(() => {
        progressEl.textContent = "Status unavailable; check again.";
      })
    );
    main.querySelector("#blBulkApply").addEventListener("click", async () => {
      if (submitting) return;
      const items = Array.from(main.querySelectorAll("tr[data-creator]"))
        .filter((tr) => tr.querySelector(".bl-select").checked)
        .map((tr) => ({ creatorId: tr.dataset.creator, expectedRevision: Number(tr.dataset.pricingRevision) }));
      const tier = main.querySelector("#blBulkTier").value;
      const reason = main.querySelector("#blBulkReason").value.trim();
      if (!items.length || items.length > 100 || !reason) {
        R().toast("Select 1–100 models and enter a reason.", "error");
        return;
      }
      const body = { items, tier, reason };
      if (tier === "CUSTOM") {
        const raw = main.querySelector("#blBulkCustomPrice").value;
        if (!raw.trim() || !Number.isFinite(Number(raw)) || Number(raw) < 0 || Number(raw) > 10000) {
          R().toast("Enter a valid CUSTOM price.", "error");
          return;
        }
        body.corePriceCents = Math.round(Number(raw) * 100);
      }
      if (
        !confirm(
          `Queue tier "${tier}" for these ${items.length} selected models? Changed prices will be rejected individually.`
        )
      )
        return;
      submitting = true;
      const button = main.querySelector("#blBulkApply");
      button.disabled = true;
      try {
        const res = await A().billingApplyTier(agencyId, body);
        if (!current()) return;
        if (res?.commandId) {
          bulkCommandId = res.commandId;
          try {
            sessionStorage.setItem(bulkStorageKey, bulkCommandId);
          } catch (_) {}
        }
        R().toast(
          res?.accepted ? "Selection accepted; check progress for completion." : res?.error || "Submission failed",
          res?.accepted ? "ok" : "error"
        );
        if (res?.accepted) await checkBulk();
      } catch (_) {
        progressEl.textContent = "Result unknown; retry the same selection.";
      } finally {
        submitting = false;
        button.disabled = false;
      }
    });
    main.querySelector("#blBulkResume").addEventListener("click", async () => {
      if (!resumePayload || submitting) return;
      const reason = main.querySelector("#blBulkReason").value.trim();
      if (!reason) {
        R().toast("Enter a reason for resuming.", "error");
        return;
      }
      if (!confirm(`Resume ${resumePayload.items.length} remaining models with the original prices and versions?`))
        return;
      submitting = true;
      try {
        const res = await A().billingApplyTier(agencyId, { ...resumePayload, reason });
        if (!current()) return;
        if (res?.commandId) {
          bulkCommandId = res.commandId;
          try {
            sessionStorage.setItem(bulkStorageKey, bulkCommandId);
          } catch (_) {}
        }
        R().toast(
          res?.accepted ? "Remaining selection accepted." : res?.error || "Resume failed",
          res?.accepted ? "ok" : "error"
        );
        if (res?.accepted) await checkBulk();
      } catch (_) {
        progressEl.textContent = "Result unknown; check progress or retry the same resume.";
      } finally {
        submitting = false;
      }
    });
    main.querySelector("#blBulkCancel").addEventListener("click", async () => {
      if (!bulkCommandId || submitting) return;
      const reason = main.querySelector("#blBulkReason").value.trim();
      if (!reason) {
        R().toast("Enter a cancellation reason.", "error");
        return;
      }
      if (!confirm("Cancel remaining changes? Completed changes stay in place.")) return;
      submitting = true;
      try {
        const res = await A().billingCancelTier(agencyId, { targetCommandId: bulkCommandId, reason });
        if (!current()) return;
        R().toast(
          res?.ok ? "Cancellation confirmed." : res?.error || "Cancellation result unknown; retry.",
          res?.ok ? "ok" : "error"
        );
        await checkBulk();
      } catch (_) {
        progressEl.textContent = "Cancellation result unknown; check or retry.";
      } finally {
        submitting = false;
      }
    });
    if (bulkCommandId)
      checkBulk().catch(() => {
        progressEl.textContent = "Status unavailable; check again.";
      });
  }

  window.NodAdminBilling = { render };
  window.NodAdminBilling.mountAgency = (main, agencyId, options = {}) => {
    local.modelsAfter = null;
    local.agencyId = agencyId;
    return renderAgency(main, agencyId, { ...options, embedded: true });
  };
})();
