(function () {
  "use strict";

  function ensureHomeState(state) {
    if (!state.home) {
      state.home = {};
    }

    return state.home;
  }

  window.OnlinodHomeState = {
    ensureHomeState,
  };
})();
