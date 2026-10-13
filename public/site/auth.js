(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)], api = window.NODWeb;
  const original = {};
  $$('[data-i18n]').forEach(el => { original[el.dataset.i18n] ??= el.innerHTML; });
  const copy = {
    loadingSession: ['Loading your account…', 'Загружаем аккаунт…'],
    verifyTitle: ['Confirm your email.', 'Подтверди почту.'], codeLabel: ['6-digit code', 'Код из 6 цифр'], verifyCta: ['Confirm email', 'Подтвердить почту'],
    resend: ['Send another email', 'Отправить письмо ещё раз'], resetTitle: ['Choose a new password.', 'Новый пароль.'],
    resetDesc: ['Use 8–200 characters. Previous sessions will be signed out.', 'От 8 до 200 символов. Предыдущие сессии будут завершены.'],
    resetCta: ['Save new password', 'Сохранить новый пароль'], confirmPassword: ['Repeat password', 'Повтори пароль'],
    newReset: ['Request a new link', 'Запросить новую ссылку'], accountTitle: ["You're in.", 'Ты в NOD.'],
    desktopNext: ['Install NOD and sign in with this email and password. Connect models and manage billing in the desktop app.', 'Установи NOD и войди с этой почтой и паролем. Подключение моделей и оплата доступны в приложении.'],
    downloadCta: ['Download NOD', 'Скачать NOD'], pricingCta: ['Plans and pricing', 'Тарифы и условия'], signOut: ['Sign out', 'Выйти'],
    prototypeNote: ['Your NOD account. Your agency workspace.', 'Твой аккаунт NOD. Рабочее пространство агентства.'], localPreview: ['NOD / ACCOUNT', 'NOD / АККАУНТ'],
    inviteHint: ['The invitation sets your agency, role and access.', 'Приглашение определяет агентство, роль и доступ.'],
  };
  const errors = {
    INVALID_CREDENTIALS: ['Email or password is incorrect.', 'Неверная почта или пароль.'],
    EMAIL_TAKEN: ['This email is already registered. Log in or recover your password.', 'Эта почта уже зарегистрирована. Войди или восстанови пароль.'],
    EMAIL_NOT_VERIFIED: ['Confirm your email first, then reopen this invitation.', 'Сначала подтверди почту, затем снова открой приглашение.'],
    AUTH_EMAIL_UNAVAILABLE: ['Email delivery is temporarily unavailable. Contact support.', 'Отправка писем сейчас недоступна. Обратись в поддержку.'],
    USER_DISABLED: ['Account access has been disabled. Contact support.', 'Доступ к аккаунту отключён. Обратись в поддержку.'],
    NO_AGENCY: ['No active agency membership. Contact the owner or support.', 'Нет доступа к действующему агентству. Обратись к владельцу или в поддержку.'],
    TOKEN_INVALID: ['This link is invalid, expired or already used. Request a new one.', 'Ссылка недействительна, истекла или уже использована. Запроси новую.'],
    TOKEN_USED: ['This link has already been used. Try signing in.', 'Ссылка уже использована. Попробуй войти.'],
    CODE_INVALID: ['The code is invalid or expired. Request another email.', 'Код неверный или истёк. Запроси новое письмо.'],
    INVITE_EXPIRED: ['The invitation has expired. Ask the owner for a new link.', 'Приглашение истекло. Попроси у владельца новую ссылку.'],
    INVITE_CLAIMED: ['This invitation was already accepted. Try signing in.', 'Приглашение уже принято. Попробуй войти.'],
    INVITE_REVOKED: ['The invitation was revoked by the owner.', 'Владелец отозвал приглашение.'],
    INVITE_NOT_FOUND: ['Invitation not found. Check the link or code.', 'Приглашение не найдено. Проверь ссылку или код.'],
    EMAIL_MISMATCH: ['Use the email named in the invitation.', 'Используй почту, на которую выдано приглашение.'],
    NETWORK_UNAVAILABLE: ['Connection unavailable. Please try again.', 'Нет соединения с сервером. Попробуй ещё раз.'],
    REQUEST_OUTCOME_UNKNOWN: ['The connection was interrupted. The operation may have completed. After registration or a password change, try signing in first.', 'Соединение прервалось. Операция могла завершиться. После регистрации или смены пароля сначала попробуй войти.'],
    LOGOUT_RETRY_REQUIRED: ['Sign out could not be confirmed. Please try again.', 'Выход не подтверждён. Попробуй ещё раз.'],
  };
  const routes = { login: '/login', register: '/register', recovery: '/forgot-password', verify: '/verify-email', reset: '/reset-password', invite: '/invite', account: '/account' };
  const initial = new URL(location.href);
  let lang = initial.searchParams.get('lang') === 'ru' ? 'ru' : 'en';
  const pair = values => values[lang === 'ru' ? 1 : 0];
  const text = key => copy[key] ? pair(copy[key]) : lang === 'ru' ? (window.NOD_AUTH_RU[key] ?? original[key] ?? key) : (original[key] ?? key);
  let view = Object.keys(routes).find(key => routes[key] === initial.pathname) || 'login';
  if (Object.hasOwn(routes, initial.hash.slice(1))) view = initial.hash.slice(1);
  let token = initial.searchParams.getAll('token').length === 1 ? initial.searchParams.get('token') : '';
  if (!/^[a-zA-Z0-9_-]{20,256}$/.test(token || '')) token = '';
  let inviteToken = '';
  const invitePath = initial.pathname.match(/^\/invite\/([^/]+)$/);
  if (invitePath) { view = 'invite'; try { inviteToken = decodeURIComponent(invitePath[1]); } catch (_) {} }
  if (view === 'invite') inviteToken = inviteToken || token;
  // Bearer links remain in memory; no token goes to storage or a referrer.
  history.replaceState({}, '', (routes[view] || '/login') + '?lang=' + lang);
  let sequence = 0, account = null, inviteExisting = false, config = null, resultCopy = null, busy = false;
  function errorMessage(error) {
    if (error.status === 429) return pair(['Too many requests. Please wait.', 'Слишком много запросов. Подожди и повтори.']);
    if (error.code === 'TOKEN_EXPIRED' || /^RESET_TOKEN_/.test(error.code || '')) return pair(errors.TOKEN_INVALID);
    return errors[error.code] ? pair(errors[error.code]) : pair(['Could not complete the request. Try again or contact support.', 'Не удалось завершить запрос. Попробуй ещё раз или обратись в поддержку.']);
  }
  function clearPasswords() { $$('input[data-password-mode]').forEach(input => { input.value = ''; input.type = 'password'; }); }
  function renderLanguage() {
    document.documentElement.lang = lang;
    $$('[data-i18n]').forEach(el => { el.innerHTML = text(el.dataset.i18n); });
    $$('[data-lang]').forEach(b => { b.classList.toggle('active', b.dataset.lang === lang); b.setAttribute('aria-pressed', String(b.dataset.lang === lang)); });
    $$('[data-password]').forEach(b => b.setAttribute('aria-label', pair(['Show password', 'Показать пароль'])));
    $$('#view-account a[href]').forEach(a => { const url = new URL(a.href); url.searchParams.set('lang', lang); a.href = url.href; });
    $('#invite-existing').textContent = inviteExisting ? pair(['Create an account for this invitation', 'Создать аккаунт по приглашению']) : pair(['I already have an account', 'У меня уже есть аккаунт']);
    if (resultCopy) { $('#result-title').textContent = pair(resultCopy.title); $('#result-description').textContent = pair(resultCopy.description); }
    if (account) renderAccount();
    document.title = 'NOD — ' + (view === 'account' ? pair(['Account', 'Аккаунт']) : view === 'register' ? pair(['Create account', 'Регистрация']) : pair(['Account access', 'Вход в аккаунт']));
  }
  function navigate(next, { replace = false } = {}) {
    if (!Object.hasOwn(routes, next) && next !== 'result') next = 'login';
    sequence++; view = next; clearPasswords();
    $$('.form-status').forEach(el => { el.textContent = ''; });
    $$('.view').forEach(el => { el.hidden = el.id !== 'view-' + (next === 'account' && !account ? 'loading' : next); });
    $('.auth-tabs').hidden = ['verify', 'reset', 'account', 'result'].includes(next);
    $$('.auth-tabs [data-route]').forEach(el => el.classList.toggle('active', el.dataset.route === next));
    document.body.dataset.view = next;
    history[replace ? 'replaceState' : 'pushState']({}, '', (routes[next] || '/login') + '?lang=' + lang);
    renderLanguage(); $('#view-' + (next === 'account' && !account ? 'loading' : next) + ' h1')?.focus({ preventScroll: true });
  }
  function result(title, description) { resultCopy = { title, description }; navigate('result'); }
  function showVerification(email, sent) {
    token = ''; $('#verify-email').value = email; $('#verify-code').value = '';
    $('#field-verify-email').hidden = false; $('#field-verify-code').hidden = false;
    $('#verification-note').textContent = sent ? pair(['Open the email link or enter the 6-digit code.', 'Открой ссылку из письма или введи код из 6 цифр.']) : pair(['Your account awaits confirmation. Sending is not confirmed yet. You can request another email below.', 'Аккаунт ожидает подтверждения. Отправка письма пока не подтверждена. Ниже можно запросить его повторно.']);
    navigate('verify');
  }
  function renderAccount() {
    $('#account-name').textContent = account.user?.name || '';
    $('#account-email').textContent = account.user?.email || '';
    $('#account-agency').textContent = pair(['Agency: ', 'Агентство: ']) + (account.agency?.name || '—');
    $('#account-role').textContent = pair(['Role: ', 'Роль: ']) + (account.role || '—');
    const date = account.agency?.trialEndsAt;
    $('#account-trial').textContent = date ? (new Date(date) > new Date() ? pair(['Trial ends: ', 'Пробный период до: ']) : pair(['Trial ended: ', 'Пробный период завершён: '])) + new Date(date).toLocaleString(lang === 'ru' ? 'ru-RU' : 'en-US') : '';
  }
  async function openAccount() { account = await api.session(); navigate('account'); }
  function invitationValue() {
    const value = $('#invite-code').value.trim();
    if (!value) return inviteToken;
    if (/^https?:\/\//i.test(value)) {
      try { const url = new URL(value); if (url.origin !== location.origin) return ''; return url.pathname.match(/^\/invite\/([^/]+)$/)?.[1] || url.searchParams.get('token') || ''; } catch (_) { return ''; }
    }
    return /^[a-zA-Z0-9_-]{10,512}$/.test(value) ? value : '';
  }
  async function previewInvitation() {
    const value = invitationValue(); if (!value) return;
    try {
      const data = await api.request('/api/web/invitations/preview/' + encodeURIComponent(value));
      if (value !== invitationValue()) return;
      inviteToken = value;
      $('#invite-preview').textContent = data.invitation.agency.name + ' · ' + data.invitation.roleKey;
      if (data.invitation.email) $('#invite-email').value = data.invitation.email;
    } catch (error) { $('#invite-preview').textContent = errorMessage(error); }
  }
  function validate(form) {
    let valid = true;
    $$('input[required]', form).filter(input => !input.disabled && !input.closest('[hidden]')).forEach(input => {
      if (input.type === 'email') input.value = input.value.trim();
      let message = !input.value.trim() ? pair(['Fill in this field.', 'Заполни это поле.']) : !input.checkValidity() ? pair(['Check this value.', 'Проверь значение.']) : '';
      if (input.dataset.passwordMode === 'new' && input.value.length < 8) message = pair(['Use at least 8 characters.', 'Нужно не менее 8 символов.']);
      if (input.id === 'reset-confirm' && input.value !== $('#reset-password').value) message = pair(['Passwords do not match.', 'Пароли не совпадают.']);
      const error = $('#' + input.id + '-error'); if (error) { error.textContent = message; error.hidden = !message; }
      input.setAttribute('aria-invalid', String(!!message)); if (message && valid) input.focus(); valid = valid && !message;
    });
    return valid;
  }
  function setBusy(value) { busy = value; $$('form .submit-button').forEach(b => { b.disabled = value; }); }
  $$('[data-form]').forEach(form => form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || !validate(form)) return;
    const ownSequence = sequence, mode = form.dataset.form, status = $('.form-status', form);
    setBusy(true); status.textContent = pair(['Please wait…', 'Подожди…']);
    const post = (route, body) => api.request('/api/web/auth/' + route, { method: 'POST', body });
    try {
      if (mode === 'login') {
        const email = $('#login-email').value;
        const credentials = { email, password: $('#login-password').value, rememberDevice: $('#remember-device').checked };
        try { account = await api.sessionLock(() => post('login', credentials)); }
        catch (error) { if (error.code === 'EMAIL_NOT_VERIFIED' && sequence === ownSequence) { showVerification(email, false); return; } throw error; }
        if (sequence === ownSequence) navigate('account');
      } else if (mode === 'register') {
        const email = $('#signup-email').value;
        const data = await post('register', { email, password: $('#signup-password').value, name: $('#signup-name').value.trim(), agencyName: $('#signup-agency').value.trim() });
        if (sequence === ownSequence) showVerification(email, data.emailSent);
      } else if (mode === 'verify') {
        const data = await post('verify-email', token ? { token } : { email: $('#verify-email').value, code: $('#verify-code').value.trim() });
        if (sequence === ownSequence) { token = ''; $('#login-email').value = data.user.email; result(['Email confirmed.', 'Почта подтверждена.'], ['Sign in with your email and password. The same account works in NOD desktop.', 'Войди с почтой и паролем. Этот же аккаунт используется в приложении NOD.']); }
      } else if (mode === 'recovery') {
        await post('forgot-password', { email: $('#recovery-email').value });
        if (sequence === ownSequence) result(['Request received.', 'Запрос принят.'], ['If this account exists, a reset email will be sent. The link is valid for 30 minutes. Check Spam. Contact support if no email arrives.', 'Если аккаунт существует, на почту будет отправлена ссылка на 30 минут. Проверь «Спам». Если письма нет, обратись в поддержку.']);
      } else if (mode === 'reset') {
        if (!token) throw Object.assign(new Error(), { code: 'TOKEN_INVALID' });
        await post('reset-password', { token, password: $('#reset-password').value });
        if (sequence === ownSequence) { token = ''; result(['Password changed.', 'Пароль изменён.'], ['Sign in with the new password. Previous sessions have been signed out.', 'Войди с новым паролем. Предыдущие сессии завершены.']); }
      } else if (mode === 'invite') {
        const value = invitationValue(); if (!value) throw Object.assign(new Error(), { code: 'INVITE_NOT_FOUND' });
        const email = $('#invite-email').value;
        if (inviteExisting) {
          const credentials = { email, password: $('#invite-password').value };
          await api.sessionLock(async () => {
            account = await post('login', credentials);
            await api.request('/api/web/invitations/claim', { method: 'POST', body: { token: value } });
          });
          if (sequence === ownSequence) { inviteToken = ''; result(['Invitation accepted.', 'Приглашение принято.'], ['Your agency membership is ready. Sign in to the desktop app to continue.', 'Доступ к агентству выдан. Войди в приложение, чтобы продолжить работу.']); }
        } else {
          const data = await post('register', { email, password: $('#invite-password').value, name: $('#invite-name').value.trim(), inviteToken: value });
          if (sequence === ownSequence) { inviteToken = ''; showVerification(email, data.emailSent); }
        }
      }
    } catch (error) { if (sequence === ownSequence) status.textContent = errorMessage(mode === 'verify' && !token && ['TOKEN_INVALID','TOKEN_USED'].includes(error.code) ? {code:'CODE_INVALID'} : error); }
    finally { setBusy(false); clearPasswords(); }
  }));
  $('#resend-verification').addEventListener('click', async () => {
    if (busy) return;
    const email = $('#verify-email').value.trim();
    if (!email || !$('#verify-email').checkValidity()) { $('#field-verify-email').hidden = false; $('#verify-email').focus(); $('#resend-status').textContent = pair(['Enter your email first.', 'Сначала укажи почту.']); return; }
    setBusy(true); $('#resend-verification').disabled = true;
    try {
      const data = await api.request('/api/web/auth/resend-verification', { method: 'POST', body: { email } });
      $('#resend-status').textContent = data.alreadyVerified ? pair(['Email is confirmed. Sign in.', 'Почта уже подтверждена. Войди в аккаунт.']) : data.emailSent ? pair(['Email sent. Check your inbox and Spam.', 'Письмо отправлено. Проверь почту и «Спам».']) : pair(['Request received; sending is not confirmed yet.', 'Запрос принят; отправка пока не подтверждена.']);
    } catch (error) { $('#resend-status').textContent = errorMessage(error); }
    finally { setBusy(false); $('#resend-verification').disabled = false; }
  });
  $('#sign-out').addEventListener('click', async () => {
    if (busy) return; setBusy(true);
    try { await api.sessionLock(() => api.request('/api/web/auth/logout', { method: 'POST', body: {} })); account = null; navigate('login'); }
    catch (error) { $('#account-status').textContent = errorMessage(error); } finally { setBusy(false); }
  });
  $('#invite-existing').addEventListener('click', () => {
    inviteExisting = !inviteExisting; $('#field-invite-name').hidden = inviteExisting; $('#invite-name').required = !inviteExisting;
    $('#invite-password').dataset.passwordMode = inviteExisting ? 'login' : 'new'; $('#invite-password').autocomplete = inviteExisting ? 'current-password' : 'new-password'; renderLanguage();
  });
  $('#invite-code').addEventListener('blur', previewInvitation);
  $$('[data-route]').forEach(link => link.addEventListener('click', event => { event.preventDefault(); navigate(link.dataset.route); }));
  $$('[data-lang]').forEach(b => b.addEventListener('click', () => { lang = b.dataset.lang === 'ru' ? 'ru' : 'en'; renderLanguage(); history.replaceState({}, '', (routes[view] || '/login') + '?lang=' + lang); }));
  $$('[data-password]').forEach(b => b.addEventListener('click', () => { const input = $('#' + b.dataset.password); input.type = input.type === 'password' ? 'text' : 'password'; b.setAttribute('aria-pressed', String(input.type === 'text')); }));
  $$('[data-dialog]').forEach(b => b.addEventListener('click', () => {
    const key = b.dataset.dialog;
    if (key === 'help') { location.href = '/help?lang=' + lang; return; }
    const url = config?.legal?.[key]; if (url) { location.href = url; return; }
    $('#info-title').textContent = text(key); $('#info-description').textContent = pair(['This document has not been published yet. Contact NOD for details.', 'Этот документ ещё не опубликован. За подробностями обратись в NOD.']); $('#info-note').textContent = ''; $('#info-dialog').showModal();
  }));
  $$('[data-close]').forEach(b => b.addEventListener('click', () => $('#info-dialog').close()));
  window.addEventListener('popstate', () => navigate(Object.keys(routes).find(k => routes[k] === location.pathname) || 'login', { replace: true }));
  window.addEventListener('pagehide', clearPasswords);
  navigate(view, { replace: true });
  if (view === 'verify' && token) { $('#field-verify-email').hidden = true; $('#field-verify-code').hidden = true; $('#verification-note').textContent = pair(['Confirm this email address to activate your account.', 'Подтверди почту, чтобы активировать аккаунт.']); }
  if (view === 'reset' && !token) { $('#reset-form .form-status').textContent = pair(errors.TOKEN_INVALID); $('#reset-form .submit-button').disabled = true; }
  if (view === 'invite' && inviteToken) { $('#invite-code').value = inviteToken; previewInvitation(); }
  api.request('/api/site/config').then(data => { config = data; }).catch(() => {});
  if (view === 'account') openAccount().catch(error => { navigate('login'); $('#login-form .form-status').textContent = error.status === 401 || error.code === 'VALIDATION_ERROR' ? pair(['Please sign in.', 'Войди в аккаунт.']) : errorMessage(error); });
})();
