(function () {
  "use strict";

  const S = window.OnlinodHomeState;

  function render({ root, state, helpers = {}, actions = {} }) {
    if (!root) return;

    const ctx = {
      root,
      state,
      helpers,
      actions,
    };

    S.ensureHomeState(state);

    root.innerHTML = window.OnlinodHomeRenderers.renderHome(ctx);
    window.OnlinodHomeEvents.bind(ctx);
  }

  window.OnlinodHomeView = {
    render,
  };
})();
