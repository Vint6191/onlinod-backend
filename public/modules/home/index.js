(function () {
  "use strict";

  if (!window.NodHomeView) {
    console.error("[HOME] NodHomeView is missing");
    return;
  }

  window.NodHome = {
    render: window.NodHomeView.render,
  };

  console.log("[HOME] renderer module loaded ✓");
})();
