(function () {
  "use strict";

  const S = window.OnlinodCreatorAnalyticsState;
  const C = window.OnlinodCreatorAnalyticsConstants || {};

  function getReadyAccounts(ctx) {
    return ctx.helpers?.getVisibleAccounts?.() || ctx.state.accounts || [];
  }

  async function requestNumbersForAccount(ctx, account, range, { force = false } = {}) {
    if (!account?.id) return null;

    const current = S.getNumbersState(ctx, account.id, range);
    if (!force && (current?.loading || current?.loaded)) {
      return current?.data || null;
    }

    S.setNumbersLoading(ctx, account.id, range, true);
    rerender(ctx);

    try {
      const result = await window.desktopAPI?.creatorAnalytics?.getNumbers?.(account, range);

      if (!result?.ok) {
        S.setNumbersError(ctx, account.id, range, result?.error || "Failed to load creator numbers");
        rerender(ctx);
        return null;
      }

      S.setNumbersData(ctx, account.id, range, result);
      rerender(ctx);
      return result;
    } catch (err) {
      S.setNumbersError(ctx, account.id, range, String(err?.message || err));
      rerender(ctx);
      return null;
    }
  }

  async function loadNumbers(ctx, { force = false } = {}) {
    const accountId = S.getSelectedCreatorId(ctx);
    const range = S.getRange(ctx);

    if (!accountId || S.getTab(ctx) !== "numbers") return;

    const account = getReadyAccounts(ctx).find(
      (item) => String(item?.id) === String(accountId)
    ) || null;

    if (!account) return;

    await requestNumbersForAccount(ctx, account, range, { force });
  }

  async function loadOverviewNumbers(ctx, { force = false } = {}) {
    if (S.getSelectedCreatorId(ctx)) return;

    const range = S.getRange(ctx);
    const ready = getReadyAccounts(ctx);

    const runId = Date.now() + Math.random();
    ctx.state.__creatorAnalyticsOverviewRunId = runId;

    for (const account of ready) {
      if (ctx.state.__creatorAnalyticsOverviewRunId !== runId) {
        return;
      }

      await requestNumbersForAccount(ctx, account, range, { force });
    }
  }

  // ── Campaigns loader ──────────────────────────────────────────────────
  // Pulls the per-account list of trials/promos/campaigns together with
  // their claim history. Range is forwarded so the backend can scope the
  // mini-trend points; the list itself is account-scoped.
  async function loadCampaignsForSelected(ctx, { force = false } = {}) {
    const accountId = S.getSelectedCreatorId(ctx);
    if (!accountId) return null;
    if (S.getTab(ctx) !== "numbers") return null;

    const account = getReadyAccounts(ctx).find(
      (item) => String(item?.id) === String(accountId)
    ) || null;
    if (!account) return null;

    const current = S.getCampaignsState(ctx, account.id);
    if (!force && (current?.loading || current?.loaded)) {
      return current?.data || null;
    }

    S.setCampaignsLoading(ctx, account.id, true);
    rerender(ctx);

    try {
      const range = S.getRange(ctx);
      const api = window.desktopAPI?.creatorCampaigns;

      if (!api || typeof api.list !== "function") {
        // Bridge not wired yet — mark as loaded with empty data, the
        // renderer will show a helpful "waiting for worker" empty state.
        S.setCampaignsData(ctx, account.id, { campaigns: [], notWired: true });
        rerender(ctx);
        return null;
      }

      const result = await api.list(account, range);

      if (!result?.ok) {
        S.setCampaignsError(ctx, account.id, result?.error || "Failed to load campaigns");
        rerender(ctx);
        return null;
      }

      S.setCampaignsData(ctx, account.id, result);
      rerender(ctx);
      return result;
    } catch (err) {
      S.setCampaignsError(ctx, account.id, String(err?.message || err));
      rerender(ctx);
      return null;
    }
  }

  function ensureNumbers(ctx) {
    if (S.getSelectedCreatorId(ctx) && S.getTab(ctx) === "numbers") {
      void loadNumbers(ctx, { force: false });
      void loadCampaignsForSelected(ctx, { force: false });
      return;
    }

    void loadOverviewNumbers(ctx, { force: false });
  }

  function bind(ctx) {
    if (!ctx.root) return;
    if (ctx.root.__onlinodCreatorAnalyticsBound) {
      // Already bound to this root. Only re-check pending loads; don't
      // kick off another full overview scan on every rerender.
      return;
    }

    ctx.root.__onlinodCreatorAnalyticsBound = true;

    ctx.root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!target || !target.closest) return;

      const openCreator = target.closest("[data-hq-open-creator]");
      if (openCreator && ctx.root.contains(openCreator)) {
        event.preventDefault();
        event.stopPropagation();

        S.openCreator(ctx, openCreator.dataset.hqOpenCreator);
        rerender(ctx);
        return;
      }

      const back = target.closest("[data-hq-back-creators]");
      if (back && ctx.root.contains(back)) {
        event.preventDefault();
        event.stopPropagation();

        S.backToList(ctx);
        rerender(ctx);
        ensureNumbers(ctx);
        return;
      }

      const tab = target.closest("[data-hq-creator-tab]");
      if (tab && ctx.root.contains(tab)) {
        event.preventDefault();
        event.stopPropagation();

        S.setTab(ctx, tab.dataset.hqCreatorTab || (C.DEFAULT_TAB || "issues"));
        S.setRangeDropdownOpen(ctx, false);
        rerender(ctx);
        ensureNumbers(ctx);
        return;
      }

      const rangeToggle = target.closest("[data-hq-range-toggle]");
      if (rangeToggle && ctx.root.contains(rangeToggle)) {
        event.preventDefault();
        event.stopPropagation();

        S.setRangeDropdownOpen(ctx, !S.isRangeDropdownOpen(ctx));
        rerender(ctx);
        return;
      }

      const rangeItem = target.closest("[data-hq-range-item]");
      if (rangeItem && ctx.root.contains(rangeItem)) {
        event.preventDefault();
        event.stopPropagation();

        S.setRange(ctx, rangeItem.dataset.hqRangeItem || (C.DEFAULT_RANGE || "7d"));
        S.setRangeDropdownOpen(ctx, false);
        rerender(ctx);

        if (S.getSelectedCreatorId(ctx) && S.getTab(ctx) === "numbers") {
          await loadNumbers(ctx, { force: true });
          await loadCampaignsForSelected(ctx, { force: true });
        } else {
          await loadOverviewNumbers(ctx, { force: true });
        }
        return;
      }

      const openAccount = target.closest("[data-admin-open]");
      if (openAccount && ctx.root.contains(openAccount)) {
        event.preventDefault();
        event.stopPropagation();

        await ctx.actions?.openAccountFromAdmin?.(openAccount.dataset.adminOpen);
        return;
      }

      const refreshMe = target.closest("[data-admin-refresh-me]");
      if (refreshMe && ctx.root.contains(refreshMe)) {
        event.preventDefault();
        event.stopPropagation();

        await ctx.actions?.refreshAccountMe?.(refreshMe.dataset.adminRefreshMe);
        return;
      }

      const snapshotCreate = target.closest("[data-snapshot-create]");
      if (snapshotCreate && ctx.root.contains(snapshotCreate)) {
        event.preventDefault();
        event.stopPropagation();

        await ctx.actions?.createAccessSnapshotForAccount?.(snapshotCreate.dataset.snapshotCreate);
        return;
      }

      const snapshotRevoke = target.closest("[data-snapshot-revoke]");
      if (snapshotRevoke && ctx.root.contains(snapshotRevoke)) {
        event.preventDefault();
        event.stopPropagation();

        await ctx.actions?.revokeLatestAccessSnapshotForAccount?.(snapshotRevoke.dataset.snapshotRevoke);
        return;
      }

      // Resolve a problem account: open it (loads its OF partition),
      // wait for OF to do its initial users/me, then ask main to
      // refresh the captured profile. If still not creator, show a
      // human-readable hint instead of failing silently.
      const resolveAccount = target.closest("[data-hq-resolve-account]");
      if (resolveAccount && ctx.root.contains(resolveAccount)) {
        event.preventDefault();
        event.stopPropagation();

        const accountId = resolveAccount.dataset.hqResolveAccount;
        if (!accountId) return;

        // Visual feedback — disable button + show progress.
        resolveAccount.disabled = true;
        const originalText = resolveAccount.textContent;
        resolveAccount.textContent = "checking…";

        try {
          // Step 1: open this account's tab. This loads its partition
          // and triggers OF's own users/me request inside the page.
          await ctx.actions?.openAccountFromAdmin?.(accountId);

          // Step 2: give OF ~3 seconds to fire users/me. Our preload
          // capture will save the freshest profile via saveMeProfile.
          await new Promise((r) => setTimeout(r, 3000));

          // Step 3: ask main to do an explicit users/me refresh
          // through browserApiRunner. This is the authoritative call —
          // even if the page didn't fire users/me on its own, this
          // forces it.
          const result = await ctx.actions?.refreshAccountMe?.(accountId);

          // After refresh, accounts:me-updated has fired and state.accounts
          // has the new status. Just rerender from current state.
          rerender(ctx);

          // Step 4: explicit feedback if still not creator.
          if (result && result.ok === false) {
            const reason = result.creatorReason || result.code || "unknown";
            alert(
              "still not recognized as creator (" + reason + ").\n\n" +
              "open the account tab and make sure you're logged in " +
              "as the creator (not as a fan)."
            );
          }
        } catch (err) {
          console.error("[CREATOR_ANALYTICS] resolve failed:", err);
          alert("resolve failed: " + (err?.message || err));
        } finally {
          resolveAccount.disabled = false;
          resolveAccount.textContent = originalText;
        }
        return;
      }

      const addAccount = target.closest("[data-hq-add-account]");
      if (addAccount && ctx.root.contains(addAccount)) {
        event.preventDefault();
        event.stopPropagation();

        await ctx.actions?.addAccountFromHQ?.();
        return;
      }

      const section = target.closest("[data-admin-section]");
      if (section && ctx.root.contains(section)) {
        event.preventDefault();
        event.stopPropagation();

        ctx.actions?.setAdminSection?.(section.dataset.adminSection);
        return;
      }

      const todo = target.closest("[data-hq-todo]");
      if (todo && ctx.root.contains(todo)) {
        event.preventDefault();
        event.stopPropagation();

        console.log("[CREATOR_ANALYTICS][TODO]", todo.dataset.hqTodo);
      }
    });

    document.addEventListener("click", (event) => {
      if (!ctx.root || !ctx.root.isConnected) return;
      if (!S.isRangeDropdownOpen(ctx)) return;

      const target = event.target;
      if (!target) return;

      // Clicks on a range toggle or a range item are handled by the root
      // listener (with stopPropagation). Document listener should never
      // interfere with them — guard anyway in case of phase weirdness.
      if (target.closest && (
        target.closest("[data-hq-range-toggle]") ||
        target.closest("[data-hq-range-item]")
      )) {
        return;
      }

      // Clicks inside ANY open dropdown menu should not close it.
      const dropdowns = ctx.root.querySelectorAll(".hq-ca-inline-dropdown");
      for (const dd of dropdowns) {
        if (dd.contains(target)) return;
      }

      // Anywhere else → close.
      S.setRangeDropdownOpen(ctx, false);
      rerender(ctx);
    });

    // Kick off the initial data load exactly once per mount.
    // Subsequent loads happen on explicit user events (tab/range change).
    ensureNumbers(ctx);

    // Keep the fixed-position dropdown glued to its trigger when the page
    // scrolls or the window resizes while it's open.
    const anchorHandler = () => {
      if (!ctx.root || !ctx.root.isConnected) return;
      if (!S.isRangeDropdownOpen(ctx)) return;
      positionDropdowns(ctx);
    };
    window.addEventListener("scroll", anchorHandler, { passive: true, capture: true });
    window.addEventListener("resize", anchorHandler);
  }

  function rerender(ctx) {
    window.OnlinodCreatorAnalyticsView.render({
      root: ctx.root,
      state: ctx.state,
      helpers: ctx.helpers,
      actions: ctx.actions,
    });
  }

  // Dropdown menus are position:fixed to escape backdrop-filter clipping on
  // the filter card. After each render, anchor any open menu to its trigger.
  function positionDropdowns(ctx) {
    if (!ctx || !ctx.root) return;

    const menus = ctx.root.querySelectorAll(".hq-ca-inline-dropdown-menu");
    if (!menus.length) return;

    for (const menu of menus) {
      const container = menu.closest(".hq-ca-inline-dropdown");
      if (!container) continue;

      const trigger = container.querySelector("[data-hq-range-toggle]");
      if (!trigger) continue;

      const rect = trigger.getBoundingClientRect();
      const gap = 8;
      const margin = 12;
      const viewportH = window.innerHeight;
      const viewportW = window.innerWidth;

      const menuHeight = Math.min(menu.offsetHeight || menu.scrollHeight || 260, 300);
      const menuWidth = Math.max(menu.offsetWidth || 0, 180);

      const spaceBelow = viewportH - rect.bottom;
      const openUp = spaceBelow < menuHeight + margin && rect.top > menuHeight + margin;

      let top = openUp ? rect.top - menuHeight - gap : rect.bottom + gap;
      let left = rect.left;

      if (left + menuWidth + margin > viewportW) {
        left = Math.max(margin, viewportW - menuWidth - margin);
      }
      if (left < margin) left = margin;

      if (top + menuHeight + margin > viewportH) {
        top = Math.max(margin, viewportH - menuHeight - margin);
      }
      if (top < margin) top = margin;

      menu.style.top = `${Math.round(top)}px`;
      menu.style.left = `${Math.round(left)}px`;
    }
  }

  window.OnlinodCreatorAnalyticsEvents = {
    bind,
    ensureNumbers,
    loadNumbers,
    loadOverviewNumbers,
    loadCampaignsForSelected,
    positionDropdowns,
  };
})();