/* One agency policy control, shared by the agency card and the billing drill-down. */
(function () {
  'use strict';
  const modes = { MANUAL: 'Ручной', STRIPE: 'Stripe', CRYPTO: 'Криптовалюта' };
  const modeOf = a => a.billingMode || a.subscriptions?.[0]?.billingMode || 'MANUAL';
  function render(a) {
    if (!a || a.deletedAt) return '';
    const on = modeOf(a) === 'FREE_INTERNAL';
    return `<section class="adm-development" aria-label="Режим разработки агентства"><div><div class="adm-development-title"><strong>Режим разработки</strong><span class="adm-pill ${on ? 'ok' : 'muted'}">${on ? 'Включён' : 'Выключен'}</span></div><p>Бессрочный внутренний доступ к моделям этого агентства. Оплаченные периоды сохраняются.${a.billingSupportHold ? ' Сейчас действует блокировка администратора.' : ''}</p></div><button type="button" class="adm-btn ${on ? '' : 'primary'}" data-development-toggle ${Number.isInteger(a.billingPolicyRevision) ? '' : 'disabled'}>${on ? 'Выключить режим разработки' : 'Включить режим разработки'}</button></section>`;
  }
  function bind(root, agency, reload) {
    root.querySelector('[data-development-toggle]')?.addEventListener('click', () => {
      const turningOff = modeOf(agency) === 'FREE_INTERNAL', revision = agency.billingPolicyRevision, agencyId = agency.id;
      if (!Number.isInteger(revision) || agency.deletedAt) return;
      const ui = window.NodAdminUI, esc = window.NodAdminRouter.escapeHtml;
      const { sheet, close } = ui.drawer({ eyebrow: 'Агентство · доступ', title: turningOff ? 'Выключить режим разработки' : 'Включить режим разработки', subtitle: `<strong>${esc(agency.name)}</strong><small>Агентство ${esc(agencyId)}</small>`, body: `<form><fieldset data-draft><p>${turningOff ? 'После отключения у каждой модели останется доступ по её действующему периоду или по пробному периоду агентства.' : 'Все модели этого агентства получат внутренний доступ без окончания срока. Режим не создаёт оплат и не изменяет сроки подписок.'}</p>${agency.billingSupportHold ? '<p class="adm-notice">Блокировка агентства останется в силе.</p>' : ''}
        ${turningOff ? `<label class="adm-field">Режим после отключения<select name="returnMode" required><option value="">Выберите режим</option>${Object.entries(modes).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></label>` : ''}
        <label class="adm-field">Причина для журнала<input name="reason" required maxlength="500" value="${turningOff ? '' : 'Разработка и бета-тестирование NOD'}"></label></fieldset><div class="adm-sticky-actions"><button type="submit" class="adm-btn primary">${turningOff ? 'Выключить для агентства' : 'Включить для агентства'}</button><button type="button" class="adm-btn" data-check>Проверить результат</button></div><p role="status" aria-live="polite"></p></form>` });
      const form = sheet.querySelector('form');
      ui.commandForm({ form, close, path: `/api/admin/agencies/${encodeURIComponent(agencyId)}/subscription`,
        build() {
          const reason = form.elements.reason.value.trim(), billingMode = turningOff ? form.elements.returnMode.value : 'FREE_INTERNAL';
          if (!reason || (turningOff && !Object.hasOwn(modes,billingMode))) throw Error('Укажите режим и причину изменения.');
          return { expectedRevision: revision, billingMode, reason };
        },
        send: body => window.NodAdminApi.patchSubscription(agencyId,body),
        reload: () => { const s = window.NodAdminState; for (const item of [s.agencyDetail?.[agencyId],s.agencies,s.dashboard]) if (item) item.lastLoadedAt=0; return reload(); }
      });
    });
  }
  window.NodAdminDevelopmentAccess = { render, bind };
})();
