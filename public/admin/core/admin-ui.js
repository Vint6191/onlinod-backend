(function () {
  "use strict";
  const paths = {
    dashboard:
      '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    agencies:
      '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h1m4 0h1M9 11h1m4 0h1M9 15h1m4 0h1M10 21v-3h4v3"/>',
    creators: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    users:
      '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M16 5a3 3 0 0 1 0 6m3 10v-3a5 5 0 0 0-2-4"/>',
    billing: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M3 10h18M7 15h3"/>',
    data: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
    devices: '<rect x="2" y="4" width="20" height="13" rx="2"/><path d="M12 17v4m-5 0h10"/>',
    system:
      '<circle cx="12" cy="12" r="3"/><path d="m9 3-1 3-3 1v3l-2 2 2 2v3l3 1 1 3h6l1-3 3-1v-3l2-2-2-2V7l-3-1-1-3Z"/>',
    audit: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6m-6 4h6m-6 4h4"/>',
    admins: '<path d="m12 2 8 4v6c0 5-8 10-8 10S4 17 4 12V6Z"/><path d="m8 12 3 3 5-6"/>',
    search: '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6"/>',
    logout: '<path d="M9 3H4v18h5m5-14 5 5-5 5m-6-5h12"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
  };
  function icon(name) {
    return `<svg class="adm-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.dashboard}</svg>`;
  }
  function drawer({ title, subtitle = "", body }) {
    document.querySelectorAll(".adm-modal-overlay").forEach((node) => node.remove());
    const previous = document.activeElement,
      esc = window.NodAdminRouter.escapeHtml;
    const overlay = document.createElement("div");
    overlay.className = "adm-modal-overlay adm-side-overlay";
    overlay.innerHTML = `<section class="adm-side-sheet" role="dialog" aria-modal="true" aria-labelledby="admSheetTitle" tabindex="-1"><header class="adm-modal-head"><div><p class="adm-eyebrow">Управление моделью</p><h2 id="admSheetTitle">${esc(title)}</h2></div><button type="button" class="adm-btn ghost adm-icon-btn" data-sheet-close aria-label="Закрыть">${icon("close")}</button></header><div class="adm-sheet-context">${subtitle}</div><div class="adm-sheet-body">${body}</div></section>`;
    document.body.append(overlay);
    const sheet = overlay.querySelector(".adm-side-sheet");
    const close = () => {
      overlay.remove();
      if (previous?.isConnected) previous.focus();
    };
    overlay.querySelector("[data-sheet-close]").addEventListener("click", close);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
      if (event.key !== "Tab") return;
      const elements = Array.from(
        sheet.querySelectorAll('button, input, select, textarea, a[href], [tabindex="0"]')
      ).filter((el) => !el.disabled && !el.hidden && el.getClientRects().length);
      const first = elements[0],
        last = elements.at(-1);
      if (!first) {
        event.preventDefault();
        sheet.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    });
    sheet.focus();
    return { overlay, sheet, close };
  }
  function subject(model) {
    const esc = window.NodAdminRouter.escapeHtml;
    return `<strong>${esc(model.displayName || model.username || model.creatorId)}</strong><span>${esc(model.agencyName || "Агентство")} · @${esc(model.username || "—")}</span><small>Модель ${esc(model.creatorId)}${model.remoteId ? ` · OnlyFans ${esc(model.remoteId)}` : ""}</small>`;
  }
  function commandForm({ form, build, send, path, close, reload }) {
    const W = window.NodAdminWorkspace,
      API = window.NodAdminApi,
      R = window.NodAdminRouter;
    const status = form.querySelector('[role="status"]'),
      draft = form.querySelector("[data-draft]"),
      check = form.querySelector("[data-check]");
    let pending = null,
      busy = false;
    const current = W.capture(form);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (busy) return;
      let body;
      try {
        body = pending || build();
      } catch (error) {
        status.textContent = error.message;
        return;
      }
      busy = true;
      pending = body;
      draft.disabled = true;
      form.querySelector('[type="submit"]').disabled = true;
      check.disabled = true;
      status.textContent = "Сохраняем…";
      try {
        const result = await send(body);
        if (!current()) return;
        if (result?.ok) {
          close();
          R.toast("Изменение сохранено", "ok");
          await reload();
          return;
        }
        const unknown =
          !result?.httpStatus ||
          result.httpStatus >= 500 ||
          ["NETWORK", "INVALID_JSON", "ADMIN_COMMAND_RESPONSE_UNKNOWN", "ADMIN_COMMAND_UNRESOLVED"].includes(
            result.code
          );
        if (!unknown) {
          pending = null;
          draft.disabled = false;
        }
        status.textContent =
          (result?.error || "Ответ не получен.") +
          (unknown
            ? " Проверьте результат или повторите то же изменение."
            : " Обновите данные, если версия изменилась.");
      } catch (_) {
        if (current())
          status.textContent = "Результат неизвестен. Повтор сохранит тот же запрос; также можно проверить результат.";
      } finally {
        busy = false;
        if (current()) {
          form.querySelector('[type="submit"]').disabled = false;
          check.disabled = false;
        }
      }
    });
    check.addEventListener("click", async () => {
      if (busy) return;
      busy = true;
      check.disabled = true;
      try {
        const result = await API.resolveCommand(path, "PATCH");
        if (!current()) return;
        if (result.pending) {
          status.textContent = "Результат ещё не подтверждён. Повторите сохранение с теми же данными.";
          return;
        }
        close();
        await reload();
        R.toast("Текущее состояние загружено", "ok");
      } catch (_) {
        if (current()) status.textContent = "Не удалось проверить результат. Попробуйте ещё раз.";
      } finally {
        busy = false;
        if (current()) check.disabled = false;
      }
    });
  }
  window.NodAdminUI = { icon, drawer, subject, commandForm };
})();
