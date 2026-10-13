(function () {
  "use strict";

  function computeAccountsSignature(helpers, state) {
    const ready = (helpers && helpers.getVisibleAccounts)
      ? helpers.getVisibleAccounts()
      : (state.accounts || []);

    const ids = [];
    for (const account of ready) {
      const id = account && account.id;
      if (id === undefined || id === null) continue;
      ids.push(String(id));
    }
    ids.sort();
    return ids.join("|");
  }

  function render({ root, state, helpers = {}, actions = {} }) {
    if (!root) return;

    const ctx = {
      root,
      state,
      helpers,
      actions,
    };

    window.NodCreatorAnalyticsState.ensure(ctx);

    root.innerHTML = window.NodCreatorAnalyticsRenderers.render(ctx);
    window.NodCreatorAnalyticsEvents.bind(ctx);

    // Re-anchor any open dropdown to its trigger after each render.
    // Cheap: just getBoundingClientRect + inline top/left on the menu.
    window.NodCreatorAnalyticsEvents.positionDropdowns?.(ctx);

    // If the set of visible accounts changed since the last render
    // (new account added, existing one removed), make sure the overview
    // fetches numbers for any newcomers. Already-loaded accounts
    // early-return inside requestNumbersForAccount, so this is cheap —
    // it does NOT re-trigger the full cascade problem we fixed earlier,
    // because the guard only fires when the signature actually changes.
    const signature = computeAccountsSignature(helpers, state);
    if (state.__creatorAnalyticsAccountsSig !== signature) {
      state.__creatorAnalyticsAccountsSig = signature;
      window.NodCreatorAnalyticsEvents.ensureNumbers?.(ctx);
    }
  }

  window.NodCreatorAnalyticsView = {
    render,
  };
})();