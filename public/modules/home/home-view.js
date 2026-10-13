(function () {
  "use strict";

  const S = window.NodHomeState;

  function render({ root, state, helpers = {}, actions = {} }) {
    if (!root) return;

    const ctx = {
      root,
      state,
      helpers,
      actions,
    };

    S.ensureHomeState(state);

    root.innerHTML = window.NodHomeRenderers.renderHome(ctx);
    window.NodHomeEvents.bind(ctx);
  }

  window.NodHomeView = {
    render,
  };
})();
