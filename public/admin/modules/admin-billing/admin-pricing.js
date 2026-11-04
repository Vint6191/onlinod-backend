(function () {
  "use strict";
  const components = [
    ["core", "Core"],
    ["aiChatter", "AI Chatter"],
    ["outreach", "SFS + Comment Bot"],
  ];
  function command(model, draft) {
    const reason = String(draft.reason || "").trim();
    if (!reason) throw Error("Укажите причину изменения.");
    const body = {
      expectedRevision: model.pricingRevision || 0,
      expectedAgencyId: model.agencyId,
      reason,
      tierMode: draft.tierMode,
      aiChatterEnabled: !!draft.aiChatterEnabled,
      outreachEnabled: !!draft.outreachEnabled,
      billingExcluded: !!draft.billingExcluded,
    };
    if (body.tierMode === "MANUAL") body.tier = draft.tier;
    for (const [key] of components) {
      const source = key === "core" && body.tierMode === "AUTO" ? "CATALOG" : draft[key + "PriceSource"];
      body[key + "PriceSource"] = source;
      if (source === "OVERRIDE") {
        const raw = String(draft[key + "Price"] || "").trim();
        if (!/^\d+(?:\.\d{1,2})?$/.test(raw) || Number(raw) > 10000)
          throw Error("Цена: от $0 до $10 000, до двух знаков после точки.");
        body[key + "PriceCents"] = Math.round(Number(raw) * 100);
      }
    }
    if (body.tier === "CUSTOM" && body.corePriceSource !== "OVERRIDE")
      throw Error("Для Custom нужна индивидуальная цена Core.");
    return body;
  }
  function open(model, catalog, reload) {
    const UI = window.NodAdminUI,
      esc = window.NodAdminRouter.escapeHtml,
      tiers = catalog.tiers || {},
      addons = catalog.addons || {};
    const selectedTier = model.tier || "STARTER";
    const { sheet, close } = UI.drawer({
      title: "Тариф и дополнения",
      subtitle: UI.subject(model),
      body: `
      <form id="admPricingForm"><fieldset data-draft>
        <div class="adm-form-section"><h3>Уровень подписки</h3><p class="adm-muted">Настройки следующих покупок и продлений. Уже выданный доступ изменяется отдельно.</p>
          <label class="adm-field">Определение уровня<select name="tierMode"><option value="AUTO" ${model.tierMode !== "MANUAL" ? "selected" : ""}>Автоматически по доходу за 30 дней</option><option value="MANUAL" ${model.tierMode === "MANUAL" ? "selected" : ""}>Выбрать вручную</option></select></label>
          <label class="adm-field">Уровень<select name="tier">${Object.entries(tiers)
            .map(
              ([key, tier]) =>
                `<option value="${esc(key)}" ${key === selectedTier ? "selected" : ""}>${esc(tier.label)} · ${esc(tier.revenueLabel || "индивидуально")}</option>`
            )
            .join("")}</select></label>
          <p class="adm-muted" data-auto-note>При автоматическом режиме уровень обновляет расчёт дохода. Здесь показан текущий уровень модели.</p>
        </div>
        ${components
          .map(
            ([
              key,
              label,
            ]) => `<div class="adm-form-section"><h3>${label}</h3>${key !== "core" ? `<label class="adm-check"><input type="checkbox" name="${key}Enabled" ${model[key + "Enabled"] ? "checked" : ""}> Включить в следующие покупки и продления</label>` : ""}
          <div class="adm-form-grid"><label class="adm-field">Источник цены<select name="${key}PriceSource"><option value="CATALOG" ${model[key + "PriceSource"] !== "OVERRIDE" ? "selected" : ""}>Общий каталог</option><option value="OVERRIDE" ${model[key + "PriceSource"] === "OVERRIDE" ? "selected" : ""}>Индивидуальная цена</option></select></label>
          <label class="adm-field">USD / месяц<input name="${key}Price" type="number" min="0" max="10000" step="0.01" value="${(Number(model[key + "PriceCents"] || 0) / 100).toFixed(2)}"></label></div></div>`
          )
          .join("")}
        <div class="adm-form-section"><label class="adm-check"><input type="checkbox" name="billingExcluded" ${model.billingExcluded ? "checked" : ""}> Исключить модель из расчёта биллинга</label><p class="adm-muted">Исключение само по себе не выдаёт доступ и не отменяет оплаченный период.</p>
          <label class="adm-field">Причина изменения<textarea name="reason" rows="2" maxlength="500" required placeholder="Например: индивидуальные условия для модели"></textarea></label></div>
        </fieldset><div class="adm-price-preview"><span>Настроено в месяц</span><strong data-total></strong></div><div class="adm-sticky-actions"><button type="submit" class="adm-btn primary">Сохранить тариф</button><button type="button" class="adm-btn" data-check>Проверить / обновить</button></div><p role="status" aria-live="polite"></p></form>`,
    });
    const form = sheet.querySelector("form"),
      field = (name) => form.elements.namedItem(name);
    function sync(event) {
      const auto = field("tierMode").value === "AUTO";
      field("tier").disabled = auto;
      form.querySelector("[data-auto-note]").hidden = !auto;
      if (auto) {
        field("corePriceSource").value = "CATALOG";
        field("tier").value = selectedTier === "CUSTOM" ? "STARTER" : selectedTier;
      } else if (field("tier").value === "CUSTOM") {
        field("corePriceSource").value = "OVERRIDE";
        if (event?.target === field("tier") && selectedTier !== "CUSTOM") field("corePrice").value = "";
      }
      field("corePriceSource").disabled = auto || field("tier").value === "CUSTOM";
      let total = 0;
      for (const [key] of components) {
        const global = field(key + "PriceSource").value === "CATALOG";
        field(key + "Price").disabled = global;
        const price = key === "core" ? tiers[field("tier").value]?.priceCents : addons[key]?.priceCents;
        if (global && price != null) field(key + "Price").value = (price / 100).toFixed(2);
        if (key === "core" || field(key + "Enabled").checked)
          total += Math.round(Number(field(key + "Price").value || 0) * 100);
      }
      form.querySelector("[data-total]").textContent =
        "$" + ((field("billingExcluded").checked ? 0 : total) / 100).toFixed(2);
    }
    form.querySelectorAll("input, select").forEach((el) => el.addEventListener("input", sync));
    sync();
    UI.commandForm({
      form,
      close,
      reload,
      path: `/api/admin/billing/creator/${encodeURIComponent(model.creatorId)}`,
      build: () =>
        command(
          model,
          Object.fromEntries(
            Array.from(form.elements)
              .filter((el) => el.name)
              .map((el) => [el.name, el.type === "checkbox" ? el.checked : el.value])
          )
        ),
      send: (body) => window.NodAdminApi.billingSetCreator(model.creatorId, body),
    });
  }
  window.NodAdminPricing = { open, command };
})();
