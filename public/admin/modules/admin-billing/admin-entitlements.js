(function () {
  "use strict";
  const components = [
    ["coreValidUntil", "Core"],
    ["aiChatterValidUntil", "AI Chatter"],
    ["outreachValidUntil", "SFS + Comment Bot"],
  ];
  const value = (date) => (date ? new Date(date).toISOString().slice(0, 19) : "");
  function command(model, draft) {
    const ent = model.entitlement || {},
      reason = draft.reason.trim();
    if (!reason) throw Error("Enter a reason for the access change.");
    const body = { expectedRevision: ent.entitlementRevision || 0, reason };
    if (model.agencyId) body.expectedAgencyId = model.agencyId;
    for (const [key] of components) {
      if (draft[key] === value(ent[key])) continue;
      const date = draft[key] ? new Date(draft[key] + "Z") : null;
      if (date && !Number.isFinite(date.getTime())) throw Error("Enter valid UTC dates.");
      body[key] = date ? date.toISOString() : null;
    }
    if (draft.tier !== (ent.tier || model.tier || "STARTER")) {
      body.tier = draft.tier;
      if (!Object.hasOwn(body, "coreValidUntil")) body.coreValidUntil = ent.coreValidUntil || null;
    }
    if (!components.some(([key]) => Object.hasOwn(body, key))) throw Error("No access dates or tier were changed.");
    return body;
  }
  function open(model, reload) {
    const UI = window.NodAdminUI,
      esc = window.NodAdminRouter.escapeHtml,
      ent = model.entitlement || {};
    const { sheet, close } = UI.drawer({
      title: "Доступ к NOD",
      subtitle: UI.subject(model),
      body: `
      <form><fieldset data-draft><div class="adm-notice"><strong>Ручное изменение доступа</strong><br>Каждый компонент имеет собственный срок. Пустая дата отзывает только этот компонент. Неизменённые даты сохраняются точно.</div>
      ${model.access?.reason === "FREE_INTERNAL" || model.access?.reason === "TRIAL" ? `<p class="adm-muted">Сейчас действует политика агентства: ${esc(model.access.reason)}. Отзыв Core не отменяет эту политику.</p>` : ""}
      <label class="adm-field">Уровень текущего доступа<select name="tier">${["STARTER", "GROWTH", "PRO", "ELITE", "CUSTOM"].map((tier) => `<option ${tier === (ent.tier || model.tier || "STARTER") ? "selected" : ""}>${tier}</option>`).join("")}</select></label>
      ${components.map(([key, label]) => `<label class="adm-field">${label} — доступ до (UTC)<input type="datetime-local" step="1" name="${key}" value="${esc(value(ent[key]))}"></label>`).join("")}
      <p class="adm-muted">Ручное изменение Core отключает его автопродление. Оно не создаёт оплату. Настройки цен и следующие покупки редактируются в «Тариф и дополнения».</p>
      <label class="adm-field">Причина изменения<textarea name="reason" rows="2" required maxlength="500"></textarea></label></fieldset>
      <div class="adm-sticky-actions"><button class="adm-btn primary" type="submit">Сохранить доступ</button><button class="adm-btn" type="button" data-check>Проверить / обновить</button></div><p role="status" aria-live="polite"></p></form>`,
    });
    const form = sheet.querySelector("form");
    UI.commandForm({
      form,
      close,
      reload,
      build: () => command(model, Object.fromEntries(new FormData(form))),
      path: `/api/admin/creators/${encodeURIComponent(model.creatorId)}/entitlement`,
      send: (body) => window.NodAdminApi.patchCreatorEntitlement(model.creatorId, body),
    });
  }
  window.NodAdminEntitlements = { open, command, value };
})();
