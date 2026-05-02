(function () {
  "use strict";

  window.OnlinodCreatorAnalyticsConstants = {
    DEFAULT_TAB: "issues",
    DEFAULT_RANGE: "7d",
    TABS: {
      ISSUES: "issues",
      WINS: "wins",
      NUMBERS: "numbers",
    },
    RANGES: [
      { key: "24h", label: "prev 24h" },
      { key: "7d", label: "prev 7d" },
      { key: "30d", label: "prev 30d" },
      { key: "90d", label: "prev 90d" },
      { key: "180d", label: "prev 180d" },
      { key: "365d", label: "prev 365d" },
      { key: "ytd", label: "this year" },
      { key: "prev_year", label: "prev year" },
      { key: "all", label: "all time" },
    ],
  };
})();