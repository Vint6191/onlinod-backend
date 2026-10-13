(function () {
  "use strict";

  if (!window.NodCreatorAnalyticsView) {
    console.error("[CREATOR_ANALYTICS] NodCreatorAnalyticsView is missing");
    return;
  }

  window.NodCreatorAnalytics = {
    render: window.NodCreatorAnalyticsView.render,
  };

  console.log("[CREATOR_ANALYTICS] renderer module loaded ✓");
})();
