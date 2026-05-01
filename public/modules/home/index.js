(function () {
  "use strict";

  if (!window.OnlinodHomeView) {
    console.error("[HOME] OnlinodHomeView is missing");
    return;
  }

  window.OnlinodHome = {
    render: window.OnlinodHomeView.render,
  };

  console.log("[HOME] renderer module loaded ✓");
})();
