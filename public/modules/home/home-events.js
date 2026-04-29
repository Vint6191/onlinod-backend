(function () {
  "use strict";

  function bind(ctx) {
    if (!ctx.root) return;

    if (ctx.root.__onlinodHomeBound) return;
    ctx.root.__onlinodHomeBound = true;

    ctx.root.addEventListener("click", async (event) => {
      const target = event.target;
      if (!target || !target.closest) return;

      const section = target.closest("[data-admin-section]");
      if (section && ctx.root.contains(section)) {
        event.preventDefault();
        event.stopPropagation();

        ctx.actions?.setAdminSection?.(section.dataset.adminSection);
        return;
      }

      const openAccount = target.closest("[data-admin-open]");
      if (openAccount && ctx.root.contains(openAccount)) {
        event.preventDefault();
        event.stopPropagation();

        await ctx.actions?.openAccountFromAdmin?.(openAccount.dataset.adminOpen);
        return;
      }

      const addAccount = target.closest("[data-hq-add-account]");
      if (addAccount && ctx.root.contains(addAccount)) {
        event.preventDefault();
        event.stopPropagation();

        await ctx.actions?.addAccountFromHQ?.();
        return;
      }

      const todo = target.closest("[data-hq-todo]");
      if (todo && ctx.root.contains(todo)) {
        event.preventDefault();
        event.stopPropagation();

        ctx.actions?.onTodo?.(todo.dataset.hqTodo);
      }
    });
  }

  window.OnlinodHomeEvents = {
    bind,
  };
})();
