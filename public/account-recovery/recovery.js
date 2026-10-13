(() => {
  "use strict";
  const element = (id) => document.getElementById(id);
  const requestForm = element("request-form");
  const resetForm = element("reset-form");
  const status = element("status");
  const resetting = /^\/reset-password\/?$/.test(location.pathname);
  const tokens = new URL(location.href).searchParams.getAll("token");
  let token = tokens.length === 1 ? tokens[0] : "";
  // Keep the one-time token only in this document's closure. No localStorage,
  // console output or authenticated web-console state participates in reset.
  if (location.search || location.hash) history.replaceState(null, "", location.pathname);
  function message(text, error = false) {
    status.textContent = text;
    status.dataset.error = String(error);
    status.hidden = false;
  }
  function invalidLink(text) {
    token = "";
    resetForm.hidden = true;
    element("request-again").hidden = false;
    message(text, true);
  }
  async function post(endpoint, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    try {
      const response = await fetch(endpoint, {
        method: "POST", credentials: "omit", redirect: "error",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok !== true) {
        throw Object.assign(new Error("RECOVERY_REQUEST_FAILED"), { code: data.code, status: response.status });
      }
      return data;
    } finally { clearTimeout(timer); }
  }
  if (resetting) {
    element("title").textContent = "Новый пароль";
    element("intro").textContent = "Задайте новый пароль для входа в ONLINOD.";
    if (token.length < 20 || token.length > 256) invalidLink("Ссылка неполная или недействительна. Запросите новое письмо.");
    else resetForm.hidden = false;
  } else {
    token = "";
    requestForm.hidden = false;
  }
  requestForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fieldset = requestForm.querySelector("fieldset");
    if (fieldset.disabled || !requestForm.reportValidity()) return;
    fieldset.disabled = true;
    status.hidden = true;
    try {
      await post("/api/auth/forgot-password", { email: element("email").value.trim() });
      message("Запрос принят. Если аккаунт с таким email существует, на него придёт письмо со ссылкой на 30 минут. Проверьте папку «Спам». Если письма нет, повторите запрос позже или обратитесь к администратору.");
    } catch (error) {
      message(error.status === 429 ? "Слишком много запросов. Подождите и повторите попытку." : "Не удалось подтвердить запрос. Проверьте почту; если письма нет, попробуйте ещё раз.", true);
    } finally { fieldset.disabled = false; }
  });
  resetForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fieldset = resetForm.querySelector("fieldset");
    if (fieldset.disabled || !token || !resetForm.reportValidity()) return;
    const password = element("password").value;
    if (password !== element("confirmation").value) {
      message("Пароли не совпадают.", true);
      element("confirmation").focus();
      return;
    }
    fieldset.disabled = true;
    status.hidden = true;
    try {
      await post("/api/auth/reset-password", { token, password });
      token = "";
      resetForm.reset();
      resetForm.hidden = true;
      element("title").textContent = "Пароль изменён";
      element("intro").textContent = "Вернитесь в ONLINOD и войдите с новым паролем.";
      message("Старые сеансы входа завершены. Ваш аккаунт и данные сохранены.");
    } catch (error) {
      if (["TOKEN_INVALID", "TOKEN_EXPIRED", "TOKEN_USED"].includes(error.code)) {
        resetForm.reset();
        invalidLink(error.code === "TOKEN_USED"
          ? "Эта ссылка уже использована. Если вы только что меняли пароль, попробуйте войти с новым. Иначе запросите новое письмо."
          : "Ссылка недействительна или срок её действия истёк. Запросите новое письмо.");
      } else {
        message(error.status === 429 ? "Слишком много запросов. Подождите и повторите попытку."
          : error.code === "SETTINGS_ACCOUNT_INACTIVE" ? "Восстановление этого аккаунта недоступно. Обратитесь к администратору."
          : "Не удалось подтвердить смену пароля. Попробуйте войти с новым паролем. Если вход не получится, повторите сброс.", true);
      }
    } finally { fieldset.disabled = false; }
  });
})();
