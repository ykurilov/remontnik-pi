// Страницы живого экрана: вход по ключу владельца и сам экран с кнопками «Взять управление» / «Вернуть».
// Без внешних файлов и библиотек: одна страница, работает и с телефона.

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)

function layout(title: string, body: string, script = ''): string {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — Ремонтник</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: .75rem; max-width: 100vw; overflow-x: hidden; }
  header { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-bottom: .5rem; }
  header h1 { font-size: 1rem; margin: 0 auto 0 0; }
  button, input { font: inherit; min-height: 2.75rem; padding: .5rem .9rem; border-radius: .5rem; }
  button { border: 1px solid currentColor; background: transparent; cursor: pointer; }
  button.primary { background: #1f6feb; border-color: #1f6feb; color: #fff; }
  #state { font-size: .9rem; opacity: .8; }
  #screen { display: block; width: 100%; height: auto; max-width: 100%; border: 1px solid #8884; border-radius: .5rem; touch-action: none; outline: none; background: #8882; }
  #screen:focus-visible { outline: 2px solid #1f6feb; }
  #keys { position: fixed; left: 0; bottom: 0; width: 1px; height: 1px; opacity: 0; border: 0; padding: 0; resize: none; pointer-events: none; }
  form.text { display: flex; gap: .5rem; margin-top: .5rem; }
  form.text input { flex: 1; min-width: 0; }
  .error { color: #d1242f; }
  label { display: block; margin-bottom: .5rem; }
</style>
</head>
<body>
${body}
${script === '' ? '' : `<script>\n${script}\n</script>`}
</body>
</html>`
}

export function liveLoginPage(profile: string, error = ''): string {
  return layout(
    'Вход',
    `<h1>Живой экран Ремонтника</h1>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/live/login">
  <input type="hidden" name="profile" value="${escapeHtml(profile)}">
  <label for="token">Ключ владельца</label>
  <input id="token" name="token" type="password" autocomplete="current-password" required>
  <button class="primary" type="submit">Войти</button>
</form>`,
  )
}

export function liveScreenPage(profile: string): string {
  const script = `
const profile = ${JSON.stringify(profile)};
const screen = document.querySelector('#screen');
const context = screen.getContext('2d');
const state = document.querySelector('#state');
const take = document.querySelector('#take');
const release = document.querySelector('#release');
let socket = null;
let frameSize = { width: 1280, height: 800 };
let frames = 0;

function showHolder(holder) {
  const mine = holder === 'owner';
  take.hidden = mine;
  release.hidden = !mine;
  state.textContent = mine ? 'Управление у вас' : 'Смотрите; управляет врач';
}

function connect() {
  socket = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/live/stream?profile=' + encodeURIComponent(profile));
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'frame') {
      const image = new Image();
      image.onload = () => {
        if (screen.width !== image.naturalWidth || screen.height !== image.naturalHeight) {
          screen.width = image.naturalWidth;
          screen.height = image.naturalHeight;
        }
        context.drawImage(image, 0, 0);
        frameSize = { width: message.width, height: message.height };
        frames += 1;
        screen.dataset.frames = String(frames);
      };
      image.src = 'data:image/jpeg;base64,' + message.data;
    } else if (message.type === 'control') {
      showHolder(message.holder);
    } else if (message.type === 'refused') {
      state.textContent = message.message;
    }
  };
  socket.onclose = () => {
    state.textContent = 'Связь пропала, переподключаюсь…';
    setTimeout(connect, 2000);
  };
}

function send(input) {
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(input));
}

function pointOf(event) {
  const box = screen.getBoundingClientRect();
  return {
    x: Math.round(((event.clientX - box.left) / box.width) * frameSize.width),
    y: Math.round(((event.clientY - box.top) / box.height) * frameSize.height),
  };
}

// «Взять» и «Вернуть» идут тем же потоком, что и ввод: «Вернуть» не обгонит ещё не дошедшие буквы.
async function setControl(action) {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: 'control', action }));
  } else {
    const response = await fetch('/live/control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profile, action }),
    });
    const result = await response.json().catch(() => ({}));
    if (result.holder) showHolder(result.holder);
  }
  if (action === 'take') screen.focus();
}

take.addEventListener('click', () => setControl('take'));
release.addEventListener('click', () => setControl('release'));

const BUTTONS = ['left', 'middle', 'right'];
let touchStart = null;
let lastMove = 0;
screen.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  screen.focus();
  if (event.pointerType === 'touch') {
    touchStart = pointOf(event);
    return;
  }
  send({ type: 'mouse', action: 'down', ...pointOf(event), button: BUTTONS[event.button] || 'left' });
});
screen.addEventListener('pointerup', (event) => {
  event.preventDefault();
  if (event.pointerType === 'touch') {
    if (touchStart) send({ type: 'tap', ...touchStart });
    touchStart = null;
    return;
  }
  send({ type: 'mouse', action: 'up', ...pointOf(event), button: BUTTONS[event.button] || 'left' });
});
screen.addEventListener('pointermove', (event) => {
  if (event.pointerType === 'touch' || Date.now() - lastMove < 50) return;
  lastMove = Date.now();
  send({ type: 'mouse', action: 'move', ...pointOf(event) });
});
screen.addEventListener('contextmenu', (event) => event.preventDefault());
screen.addEventListener('wheel', (event) => {
  event.preventDefault();
  send({ type: 'wheel', ...pointOf(event), dx: Math.round(event.deltaX), dy: Math.round(event.deltaY) });
}, { passive: false });

// Клавиатура владельца идёт через скрытое поле: так доходят и русские буквы, и ввод с экранной клавиатуры,
// которые не дают keydown с самим символом.
const keys = document.querySelector('#keys');
screen.addEventListener('focus', () => keys.focus());
const NAMED_KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);
keys.addEventListener('keydown', (event) => {
  if (event.isComposing || !NAMED_KEYS.has(event.key)) return;
  event.preventDefault();
  send({ type: 'key', key: (event.shiftKey ? 'Shift+' : '') + event.key });
});
function sendTyped() {
  if (keys.value !== '') send({ type: 'text', text: keys.value });
  keys.value = '';
}
keys.addEventListener('input', (event) => {
  if (!event.isComposing) sendTyped();
});
keys.addEventListener('compositionend', sendTyped);

// С телефона текст удобнее набрать в обычном поле и отправить целиком.
document.querySelector('form.text').addEventListener('submit', (event) => {
  event.preventDefault();
  const field = document.querySelector('#text');
  if (field.value !== '') send({ type: 'text', text: field.value });
  field.value = '';
});

connect();
`
  return layout(
    'Живой экран',
    `<header>
  <h1>Профиль ${escapeHtml(profile)}</h1>
  <span id="state" role="status">Подключаюсь…</span>
  <button id="take" class="primary" type="button">Взять управление</button>
  <button id="release" type="button" hidden>Вернуть</button>
</header>
<canvas id="screen" tabindex="0" width="1280" height="800" data-frames="0" aria-label="Экран браузера Ремонтника"></canvas>
<textarea id="keys" aria-label="Клавиатура для экрана" autocomplete="off" autocapitalize="off" spellcheck="false"></textarea>
<form class="text">
  <input id="text" aria-label="Текст для ввода" autocomplete="off" placeholder="Текст в поле на экране">
  <button type="submit">Ввести</button>
</form>`,
    script,
  )
}
