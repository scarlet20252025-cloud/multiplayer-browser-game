const status = document.getElementById('status');
const back = document.getElementById('return');
const canvas = document.getElementById('field');
const context = canvas.getContext('2d', {alpha: false});
const fragment = new URLSearchParams(location.hash.slice(1));
const room = fragment.get('watch') ?? '';
const token = fragment.get('view') ?? '';
const reasons = new Set(['player-left', 'room-closed', 'disconnected', 'unavailable']);
const AUTH_TIMEOUT = 8_000;
const FIRST_FRAME_TIMEOUT = 20_000;
let done = false;
let returnUrl;
let socket;
let busy = false;
let deadline;
let viewEmote;
const emoteTimers = new Map();

function awaitWatchStep(delay, reason) {
  clearTimeout(deadline);
  deadline = setTimeout(() => leave(reason), delay);
}

function leave(reason) {
  if (done) return;
  done = true;
  clearTimeout(deadline);
  for (const timer of emoteTimers.values()) clearTimeout(timer);
  emoteTimers.clear();
  socket?.close();
  if (returnUrl) {
    if (reasons.has(reason)) returnUrl.searchParams.set('watchEnded', reason);
    location.replace(returnUrl.href);
    return;
  }
  status.textContent = '观战已结束，可返回大厅';
  status.hidden = false;
}

async function loadWatchEmotes() {
  try {
    const {loadEmoteCatalog, showFightEmote} = await import('./emotes.js').catch(() => import('./emotes.js?retry=1'));
    const catalog = new Map((await loadEmoteCatalog()).map(emote => [emote.id, emote]));
    viewEmote = message => {
      const emote = catalog.get(message.emote), role = message.member?.role;
      if (!emote) return;
      const image = showFightEmote(emote, role);
      if (!image) return;
      clearTimeout(emoteTimers.get(role));
      emoteTimers.set(role, setTimeout(() => { image.remove(); emoteTimers.delete(role); }, 3200));
    };
  } catch {
    // The optional emote display must not interrupt the live spectator stream.
  }
}

back.addEventListener('click', () => {
  if (returnUrl) { leave(); return; }
  if (history.length > 1) history.back();
  else location.assign('/');
});

async function showFrame(bytes) {
  if (!returnUrl || !context || busy || bytes.byteLength > 32 * 1024) return;
  busy = true;
  try {
    const frame = await createImageBitmap(new Blob([bytes], {type: 'image/webp'}));
    try {
      if (done) return;
      context.drawImage(frame, 0, 0, canvas.width, canvas.height);
      clearTimeout(deadline);
      status.hidden = true;
    } finally { frame.close(); }
  } catch {
    // Keep the last valid picture until the next frame.
  } finally { busy = false; }
}

history.replaceState(null, '', location.pathname);
if (!/^[0-9a-f]{10}$/i.test(room) || !/^[a-z0-9_-]{32}$/i.test(token)) {
  leave('unavailable');
} else {
  const endpoint = new URL('./socket', location.href);
  endpoint.protocol = endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
  endpoint.search = new URLSearchParams({room, token, role: 'watch'});
  socket = new WebSocket(endpoint);
  socket.binaryType = 'arraybuffer';
  awaitWatchStep(AUTH_TIMEOUT, 'disconnected');
  socket.onmessage = event => {
    if (done) return;
    if (event.data instanceof ArrayBuffer) { void showFrame(event.data); return; }
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'watch-session') {
      let target;
      try { target = new URL(message.returnUrl); } catch { leave('unavailable'); return; }
      if (!['http:', 'https:'].includes(target.protocol) || target.pathname !== '/' ||
          target.username || target.password || target.hash) { leave('unavailable'); return; }
      returnUrl = target;
      void loadWatchEmotes();
      status.textContent = '正在接收对局画面…';
      awaitWatchStep(FIRST_FRAME_TIMEOUT, 'unavailable');
    }
    if (message.type === 'emote' && returnUrl) viewEmote?.(message);
    if (message.type === 'ended') leave(message.reason);
  };
  socket.onclose = () => leave('disconnected');
  window.addEventListener('pagehide', () => { done = true; clearTimeout(deadline); socket.close(); }, {once: true});
}
