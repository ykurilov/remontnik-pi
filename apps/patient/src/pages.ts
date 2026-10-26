import type { PatientBug } from './bugs.ts'

function layout(title: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — Пациент</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 2rem auto; padding: 0 1rem; }
  nav a { margin-right: 1rem; }
  #messages p { margin: .25rem 0; }
  .error { color: #b00020; }
</style>
</head>
<body>
<nav><a href="/">Главная</a><a href="/chat">Чат</a><a href="/cabinet">Кабинет</a></nav>
${body}
${script === '' ? '' : `<script>\n${script}\n</script>`}
</body>
</html>`
}

export function homePage(): string {
  return layout('Главная', '<h1>Пациент</h1><p>Учебное приложение Ремонтника: кабинет и чат с ботом.</p>')
}

export function loginPage(error = false): string {
  return layout(
    'Вход',
    `<h1>Вход</h1>
${error ? '<p class="error">Неверный логин или пароль.</p>' : ''}
<form method="post" action="/login">
  <label>Почта <input name="login" type="email" autocomplete="username" required></label><br>
  <label>Пароль <input id="password" name="password" type="password" autocomplete="current-password" required></label>
  <button id="toggle-password" type="button" aria-label="Показать пароль">👁</button><br>
  <button type="submit">Войти</button>
</form>`,
    `document.querySelector('#toggle-password').addEventListener('click', () => {
  const field = document.querySelector('#password');
  field.type = field.type === 'password' ? 'text' : 'password';
});`,
  )
}

export function cabinetPage(): string {
  return layout(
    'Кабинет',
    `<h1>Кабинет</h1>
<p>Ваш тариф: Старт.</p>
<button id="pay-pro" type="button">Оплатить тариф Про</button>
<p id="pay-result"></p>`,
    `document.querySelector('#pay-pro').addEventListener('click', async () => {
  const response = await fetch('/api/pay', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan: 'pro' }) });
  const result = await response.json().catch(() => ({}));
  document.querySelector('#pay-result').textContent = response.ok ? 'Оплачено, квитанция ' + result.receiptId : 'Оплата не прошла';
});`,
  )
}

export function chatPage(bug: PatientBug | null): string {
  // При PATIENT_BUG=page_error скрипт ищет форму по неверному селектору: ошибка видна только в браузере.
  const formSelector = bug === 'page_error' ? '#chat-form-missing' : '#chat-form'
  return layout(
    'Чат',
    `<h1>Чат с ботом</h1>
<div id="messages"></div>
<form id="chat-form">
  <input id="chat-input" name="message" autocomplete="off" required>
  <button type="submit">Отправить</button>
</form>`,
    `document.querySelector('${formSelector}').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.querySelector('#chat-input');
  const messages = document.querySelector('#messages');
  const mine = document.createElement('p');
  mine.textContent = 'Вы: ' + input.value;
  messages.append(mine);
  const response = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: input.value }) });
  const result = await response.json().catch(() => ({}));
  const answer = document.createElement('p');
  answer.textContent = 'Бот: ' + (result.reply ?? 'ошибка, попробуйте позже');
  messages.append(answer);
  input.value = '';
});`,
  )
}

// Страницы для проверки браузера Ремонтника: там, где нужен человек, браузер должен остановиться.
export function captchaPage(): string {
  return layout(
    'Проверка',
    `<h1>Подтвердите, что вы человек</h1>
<div class="g-recaptcha" data-sitekey="patient-demo-sitekey"></div>
<iframe title="captcha" src="/captcha-frame?kind=recaptcha"></iframe>`,
  )
}

export function captchaFramePage(): string {
  return '<!doctype html><html lang="ru"><body><label><input type="checkbox"> Я не робот</label></body></html>'
}

export function confirmCodePage(): string {
  return layout(
    'Код',
    `<h1>Подтверждение входа</h1>
<p>Мы отправили код подтверждения в SMS.</p>
<label>Код <input name="code" inputmode="numeric" autocomplete="one-time-code"></label>`,
  )
}

// Вход, где «глаз» пересоздаёт поле (как перерисовка в React): новое поле type=text с тем же значением.
export function loginRerenderPage(): string {
  return layout(
    'Вход',
    `<h1>Вход</h1>
<form method="post" action="/login">
  <label>Почта <input name="login" type="email" autocomplete="username" required></label><br>
  <label>Пароль <span id="password-slot"><input name="password" type="password" required></span></label>
  <button id="toggle-password" type="button" aria-label="Показать пароль">👁</button><br>
  <button type="submit">Войти</button>
</form>`,
    `document.querySelector('#toggle-password').addEventListener('click', () => {
  const old = document.querySelector('#password-slot input');
  const next = document.createElement('input');
  next.name = 'password';
  next.type = old.type === 'password' ? 'text' : 'password';
  next.value = old.value;
  old.replaceWith(next);
});`,
  )
}

export function settingsPage(): string {
  return layout(
    'Настройки',
    `<h1>Настройки</h1>
<button id="save-settings" type="button">Сохранить настройки</button>
<p id="save-result"></p>
<form method="post" action="/api/account/delete">
  <label>Почта для подтверждения <input name="email" type="email"></label>
  <button type="submit">Удалить аккаунт</button>
</form>`,
    `document.querySelector('#save-settings').addEventListener('click', async () => {
  const response = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  document.querySelector('#save-result').textContent = response.ok ? 'Сохранено' : 'Не сохранено';
});`,
  )
}

// Свой фрейм и фрейм чужого сайта: localhost вместо 127.0.0.1 — другой origin на том же порту.
export function framesPage(): string {
  return layout(
    'Фреймы',
    `<h1>Фреймы</h1>
<iframe title="Свой фрейм" src="/frame-text?who=own"></iframe>`,
    `const foreign = document.createElement('iframe');
foreign.title = 'Чужой фрейм';
foreign.src = location.protocol + '//localhost:' + location.port + '/frame-text?who=foreign';
document.body.append(foreign);`,
  )
}

export function frameTextPage(who: string): string {
  const text = who === 'foreign' ? 'Текст чужого фрейма' : 'Текст своего фрейма'
  return `<!doctype html><html lang="ru"><body><p>${text}</p><button type="button">Кнопка фрейма</button></body></html>`
}
