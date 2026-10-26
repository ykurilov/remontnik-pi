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
