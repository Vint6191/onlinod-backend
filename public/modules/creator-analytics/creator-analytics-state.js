(function () {
  "use strict";

  function ensure(ctx) {
    if (!ctx.state.creatorAnalytics) ctx.state.creatorAnalytics = {};

    const state = ctx.state.creatorAnalytics;
    if (!state.range) state.range = "7d";
    if (!state.numbersByAccountId) state.numbersByAccountId = {};
    if (!state.campaignsByAccountId) state.campaignsByAccountId = {};
    if (state.rangeDropdownOpen !== true && state.rangeDropdownOpen !== false) {
      state.rangeDropdownOpen = false;
    }

    return state;
  }

  function getRange(ctx) {
    const state = ensure(ctx);
    return state.range || "7d";
  }

  function setRange(ctx, range) {
    const state = ensure(ctx);
    state.range = String(range || "7d");
  }

  function isRangeDropdownOpen(ctx) {
    const state = ensure(ctx);
    return state.rangeDropdownOpen === true;
  }

  function setRangeDropdownOpen(ctx, open) {
    const state = ensure(ctx);
    state.rangeDropdownOpen = !!open;
  }

  function getNumbersState(ctx, accountId, range = null) {
    const state = ensure(ctx);
    const id = accountId ? String(accountId) : null;
    const key = String(range || getRange(ctx) || "7d");
    if (!id) return null;

    if (!state.numbersByAccountId[id]) state.numbersByAccountId[id] = {};
    if (!state.numbersByAccountId[id][key]) {
      state.numbersByAccountId[id][key] = {
        loading: false,
        loaded: false,
        error: null,
        data: null,
      };
    }

    return state.numbersByAccountId[id][key];
  }

  function setNumbersLoading(ctx, accountId, range, loading) {
    const entry = getNumbersState(ctx, accountId, range);
    if (!entry) return null;
    entry.loading = !!loading;
    if (loading) entry.error = null;
    return entry;
  }

  function setNumbersData(ctx, accountId, range, data) {
    const entry = getNumbersState(ctx, accountId, range);
    if (!entry) return null;
    entry.loading = false;
    entry.loaded = true;
    entry.error = null;
    entry.data = data || null;
    return entry;
  }

  function setNumbersError(ctx, accountId, range, error) {
    const entry = getNumbersState(ctx, accountId, range);
    if (!entry) return null;
    entry.loading = false;
    entry.loaded = false;
    entry.error = String(error || "Failed to load creator numbers");
    return entry;
  }

  // ── Campaigns (per-account, range-independent) ──────────────────────────
  // Campaigns data is an account-level list (trials, promos, etc.). It is
  // not tied to the earnings time range — the range is only used for the
  // mini-trend inside each campaign row, and the backend slices history
  // itself based on account + range.

  function getCampaignsState(ctx, accountId) {
    const state = ensure(ctx);
    const id = accountId ? String(accountId) : null;
    if (!id) return null;

    if (!state.campaignsByAccountId[id]) {
      state.campaignsByAccountId[id] = {
        loading: false,
        loaded: false,
        error: null,
        data: null,
      };
    }

    return state.campaignsByAccountId[id];
  }

  function setCampaignsLoading(ctx, accountId, loading) {
    const entry = getCampaignsState(ctx, accountId);
    if (!entry) return null;
    entry.loading = !!loading;
    if (loading) entry.error = null;
    return entry;
  }

  function setCampaignsData(ctx, accountId, data) {
    const entry = getCampaignsState(ctx, accountId);
    if (!entry) return null;
    entry.loading = false;
    entry.loaded = true;
    entry.error = null;
    entry.data = data || null;
    return entry;
  }

  function setCampaignsError(ctx, accountId, error) {
    const entry = getCampaignsState(ctx, accountId);
    if (!entry) return null;
    entry.loading = false;
    entry.loaded = false;
    entry.error = String(error || "Failed to load creator campaigns");
    return entry;
  }

  function getSelectedCreatorId(ctx) {
    const state = ensure(ctx);
    return state.selectedCreatorId || ctx.state.hqSelectedCreatorId || null;
  }

  function setSelectedCreatorId(ctx, accountId) {
    const state = ensure(ctx);
    const id = accountId ? String(accountId) : null;
    state.selectedCreatorId = id;
    ctx.state.hqSelectedCreatorId = id;
  }

  function getTab(ctx) {
    const state = ensure(ctx);
    return state.tab || ctx.state.hqCreatorTab || "issues";
  }

  function setTab(ctx, tab) {
    const state = ensure(ctx);
    const next = String(tab || "issues");
    state.tab = next;
    ctx.state.hqCreatorTab = next;
  }

  function openCreator(ctx, accountId) {
    setSelectedCreatorId(ctx, accountId);
    setTab(ctx, "issues");
    setRangeDropdownOpen(ctx, false);
  }

  function backToList(ctx) {
    setSelectedCreatorId(ctx, null);
    setRangeDropdownOpen(ctx, false);
  }

  window.OnlinodCreatorAnalyticsState = {
    ensure,
    getRange,
    setRange,
    isRangeDropdownOpen,
    setRangeDropdownOpen,
    getNumbersState,
    setNumbersLoading,
    setNumbersData,
    setNumbersError,
    getCampaignsState,
    setCampaignsLoading,
    setCampaignsData,
    setCampaignsError,
    getSelectedCreatorId,
    setSelectedCreatorId,
    getTab,
    setTab,
    openCreator,
    backToList,
  };
})();