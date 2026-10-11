(function () {
  "use strict";
  const W = () => window.OnlinodAdminWorkspace;
  async function render() {
    const root = document.getElementById("admCommandRecovery");
    if (!root || !window.OnlinodAdminState.admin) return;
    const current = W().request(root);
    const pending = await window.OnlinodAdminCommands.pending(window.OnlinodAdminApi.getToken());
    if (!current()) return;
    root.replaceChildren();
    if (!pending.length) return;
    const label = document.createElement("strong");
    label.textContent = `Unconfirmed changes: ${pending.length}`;
    const hint = document.createElement("p");
    hint.textContent =
      "Check the saved result before submitting another change. A network failure does not confirm whether the change completed.";
    root.append(label, hint);
    for (const item of pending) {
      const row = document.createElement("div"),
        text = document.createElement("span"),
        button = document.createElement("button");
      row.className = "adm-command-row";
      text.textContent = `${item.method} ${item.path.replace(/^\/api\/admin\//, "")} · ${item.commandId}`;
      button.className = "adm-btn";
      button.textContent = "Check result";
      button.addEventListener("click", async () => {
        button.disabled = true;
        const stillHere = W().capture(root);
        try {
          const result = await window.OnlinodAdminApi.resolveCommand(item.path, item.method);
          if (!stillHere()) return;
          if (result.pending) {
            text.textContent =
              result.error || `${result.status || "Result unknown"}. Check again or retry the same change.`;
            button.disabled = false;
            return;
          }
          text.textContent = `${result.status || "Confirmed"}${result.result?.error ? ": " + result.result.error : ""}. Reload the current view to see current values.`;
          button.remove();
          const reload = document.createElement("button");
          reload.className = "adm-btn";
          reload.textContent = "Reload current view";
          reload.addEventListener("click", () => location.reload());
          row.append(reload);
        } catch (_) {
          if (stillHere()) {
            text.textContent = "Could not check the result. Try again.";
            button.disabled = false;
          }
        }
      });
      row.append(text, button);
      root.append(row);
    }
  }
  // Settlement while checking must leave its confirmation visible. New requests
  // repaint the panel; ordinary replies only remove it when the shell reopens.
  window.addEventListener("onlinod:admin-commands-changed", () => {
    const root = document.getElementById("admCommandRecovery");
    if (!root?.querySelector("button:disabled")) void render();
  });
  window.OnlinodAdminCommandRecovery = { render };
})();
