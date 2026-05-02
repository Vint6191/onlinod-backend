(function () {
  "use strict";

  if (!window.OnlinodCreatorAnalyticsView) {
    console.error("[CREATOR_ANALYTICS] OnlinodCreatorAnalyticsView is missing");
    return;
  }

  window.OnlinodCreatorAnalytics = {
    render: window.OnlinodCreatorAnalyticsView.render,
  };

  console.log("[CREATOR_ANALYTICS] renderer module loaded ✓");
})();
