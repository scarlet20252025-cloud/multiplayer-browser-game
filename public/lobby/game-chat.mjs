/** Room chat for game pages. It reuses the lobby WebSocket with the token
 * already saved by the lobby tab; no second game protocol is introduced. */
const config = window.__GAME_CHAT__ ?? {};
const params = new URLSearchParams(location.search);
const roomName = params.get('room') ?? '';
const profileKey = 'fb-guest-profile';
const tokenKey = roomName ? 'fb-lobby-token:' + roomName : '';
const log = document.getElementById('game-chat-log');
const form = document.getElementById('game-chat-form');
const input = document.getElementById('game-chat-input');
const status = document.getElementById('game-chat-status');
const reactionAnchor = document.getElementById('match-reactions');
const hasChat = Boolean(log && form && input);
const socketUrl = new URL('/lobby', location.href);
socketUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const legacyPort = {'8787':'8788','10011':'10012'}[socketUrl.port];
const legacyUrl = new URL(socketUrl);
if (legacyPort) legacyUrl.port = legacyPort;
const endpoints = config.wsUrl ? [config.wsUrl] : [socketUrl.href, ...(legacyPort ? [legacyUrl.href] : [])];
let ws = null, seat = null, closed = false, welcomed = false, reconnectTimer = null, handshakeTimer = null, preferred = 0;
const reactionLabels = new Map([['👏','打得好'], ['😂','笑哭'], ['🔥','精彩'], ['💪','加油']]);
let reactionButtons = [], reactionMessage, reactionTimer, seenMessages = new Set();
// 席位配色按序号取，支持 P1..P4，不再假设只有两个玩家。
const SEAT_COLORS = ['#e67e22', '#3498db', '#9b59b6', '#16a085'];
const seatColor = value => Number.isInteger(value) && value >= 0 ? SEAT_COLORS[value % SEAT_COLORS.length] : '#7c8c85';
let profile = readProfile();
function readProfile() {
  try {
    const value = JSON.parse(localStorage.getItem(profileKey) || 'null');
    if (value && typeof value.name === 'string' && value.name.trim()) return value;
  } catch {}
  return {name: '游客', avatar: '🐟', bg: '#2ecc71'};
}
function readToken() {
  if (!tokenKey) return null;
  // The lobby tab and game page share an origin, so the seat credential stays
  // in sessionStorage. Never put the long-lived lobby token in the game URL:
  // it would be copied into history, referrers and shared links.
  try {
    const stored = JSON.parse(sessionStorage.getItem(tokenKey) || 'null');
    if (stored?.token) {
      if (Number.isInteger(stored.seat)) seat = stored.seat;
      return stored;
    }
  } catch {}
  return null;
}
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}
function timeText(value) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' :
    date.toLocaleTimeString('zh-CN', {hour:'2-digit',minute:'2-digit'});
}
function updateStatus() {
  const playable = welcomed && ws?.readyState === WebSocket.OPEN;
  for (const button of reactionButtons) button.disabled = !playable;
  if (!status) return;
  if (!roomName || !readToken()?.token) {
    status.textContent = '聊天不可用（请从大厅进入）';
    status.style.color = '#e6b36a';
    return;
  }
  status.textContent = playable ? '已连接 · 房间聊天' : '正在连接…';
  status.style.color = '';
}
function renderMessages(messages) {
  if (!hasChat) return;
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) {
    log.innerHTML = '<div class="game-chat-empty">还没有消息，打个招呼吧 👋</div>';
    return;
  }
  log.innerHTML = list.map(message => {
    const mine = message.seat === seat;
    const avatarBg = seatColor(message.seat);
    return `<div class="game-chat-msg ${mine ? 'mine' : ''}">
      <span class="game-chat-avatar" style="--bubble-avatar:${avatarBg}">${esc(message.avatar || '🐟')}</span>
      <div><div class="game-chat-meta"><b>${esc(message.name || ('玩家' + (message.seat + 1)))}</b><span>${timeText(message.at)}</span></div>
      <div class="game-chat-bubble">${esc(message.text)}</div></div></div>`;
  }).join('');
  log.scrollTop = log.scrollHeight;
}
function updateRoom(room, initial = false) {
  if (!room) return;
  if (Number.isInteger(room.viewerSeat)) seat = room.viewerSeat;
  renderMessages(room.chat);
  const messages = Array.isArray(room.chat) ? room.chat : [];
  if (reactionMessage && !initial) {
    const latest = messages.findLast(message => message.id && !seenMessages.has(message.id) && reactionLabels.has(message.text));
    if (latest) {
      reactionMessage.textContent = 'P' + (latest.seat + 1) + ' ' + latest.text;
      reactionMessage.hidden = false;
      clearTimeout(reactionTimer);
      reactionTimer = setTimeout(() => { reactionMessage.hidden = true; }, 2800);
    }
  }
  seenMessages = new Set(messages.map(message => message.id));
  if (status) {
    const online = Array.isArray(room.connected) ? room.connected.filter(Boolean).length : 0;
    status.textContent = '在线 ' + online + '/' + (room.capacity || room.connected?.length || 2) + ' · 房间聊天';
    status.style.color = '';
  }
}
function connect(index = preferred) {
  if (closed || !roomName || (!reactionAnchor && !hasChat)) { updateStatus(); return; }
  const stored = readToken();
  if (!stored?.token) { updateStatus(); return; }
  try { ws?.close(); } catch {}
  const url = new URL(endpoints[index]);
  url.searchParams.set('token', stored.token);
  url.searchParams.set('presence', 'chat');
  const socket = new WebSocket(url);
  ws = socket;
  welcomed = false;
  updateStatus();
  clearTimeout(handshakeTimer);
  handshakeTimer = setTimeout(() => {
    if (ws === socket && !welcomed) socket.close();
  }, 4500);
  socket.onmessage = event => {
    if (ws !== socket) return;
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'welcome') {
      seat = message.seat;
      welcomed = true;
      preferred = index;
      clearTimeout(handshakeTimer);
      updateStatus();
      updateRoom(message.room, true);
      return;
    }
    if (message.type === 'state') {
      updateRoom(message.room);
      return;
    }
    if (message.type === 'session-ended') {
      if (status) status.textContent = '游戏会话已结束';
      return;
    }
    if (message.type === 'lobby-error') {
      if (['LOBBY_TOKEN_INVALID','LOBBY_TOKEN_EXPIRED'].includes(message.code)) {
        closed = true;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        try { ws?.close(); } catch {}
        if (status) {
          status.textContent = '聊天凭证已失效，请从大厅重新进入';
          status.style.color = '#e6b36a';
        }
        return;
      }
      if (status) status.textContent = message.message || message.code;
    }
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    const next = welcomed ? index : (index + 1) % endpoints.length;
    welcomed = false;
    clearTimeout(handshakeTimer);
    updateStatus();
    if (!closed && !reconnectTimer) reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect(next);
    }, 1600);
  };
}
function sendChat(text) {
  if (!welcomed || ws?.readyState !== WebSocket.OPEN) {
    if (status) status.textContent = '聊天未连接';
    return false;
  }
  ws.send(JSON.stringify({type: 'chat', text, name: profile.name, avatar: profile.avatar}));
  return true;
}

function mountKeyboardHelp() {
  const hint = document.querySelector('#game-left .game-side-hint');
  if (!hint || hint.querySelector('kbd')) return;
  if (document.getElementById('shanyi-status')) {
    hint.innerHTML = 'P1 <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd><br>P2 <kbd>↑</kbd> <kbd>←</kbd> <kbd>↓</kbd> <kbd>→</kbd>';
  } else if (document.getElementById('research-player-status')) {
    hint.innerHTML = '<kbd>A</kbd> <kbd>D</kbd> 或 <kbd>←</kbd> <kbd>→</kbd> 移动<br><kbd>W</kbd> <kbd>↑</kbd> <kbd>空格</kbd> 跳跃<br><kbd>P</kbd> 暂停 · <kbd>R</kbd> 重开 · <kbd>N</kbd> 下一关';
  } else return;

  const style = document.createElement('style');
  style.textContent = '#game-left .game-side-hint kbd{display:inline-block;margin:1px 0;padding:0 3px;border:1px solid var(--game-line,#dcd8f3);border-radius:4px;background:#fff;color:var(--game-ink,#20215c);font:700 11px/1.4 system-ui,sans-serif}';
  document.head.append(style);
}

function mountReactions() {
  if ((!reactionAnchor && !hasChat) || !readToken()?.token) return;
  const shell = document.createElement('div');
  shell.dataset.gameReactionShell = '';
  const panel = document.createElement('details');
  panel.dataset.gameReactions = '';
  const summary = document.createElement('summary');
  summary.textContent = '快捷表情';
  const options = document.createElement('div');
  for (const [emoji, label] of reactionLabels) {
    const button = document.createElement('button');
    button.type = 'button';
    button.title = label;
    button.setAttribute('aria-label', label);
    button.textContent = emoji;
    button.disabled = true;
    button.onclick = () => { if (sendChat(emoji)) button.blur(); };
    options.append(button);
    reactionButtons.push(button);
  }
  reactionMessage = document.createElement('span');
  reactionMessage.hidden = true;
  reactionMessage.setAttribute('role', 'status');
  panel.append(summary, options);
  shell.append(panel, reactionMessage);
  (reactionAnchor ?? form.parentElement).insertBefore(shell, reactionAnchor ? null : form);
  const style = document.createElement('style');
  style.textContent = `
    [data-game-reaction-shell]{position:relative}
    [data-game-reactions]{background:#f7f2ff;border:1px solid #dfd2fc;color:#34206d;border-radius:12px;padding:8px 10px;font:700 12px system-ui,sans-serif}
    [data-game-reactions] summary{cursor:pointer}
    [data-game-reactions] div{display:flex;gap:5px;flex-wrap:wrap;margin-top:8px}
    [data-game-reactions] button{min-height:34px;min-width:34px;padding:4px;background:white;border:1px solid #ddd0fb;border-radius:7px;font-size:18px;cursor:pointer}
    [data-game-reactions] button:disabled{opacity:.55;cursor:default}
    [data-game-reaction-shell]>span{position:absolute;right:7px;bottom:calc(100% + 4px);z-index:5;background:white;box-shadow:0 3px 12px #36205933;border-radius:10px;padding:3px 8px;font-size:18px;pointer-events:none}
  `;
  document.head.append(style);
}

form?.addEventListener('submit', event => {
  event.preventDefault();
  const text = String(input.value || '').trim();
  if (!text) return;
  if (sendChat(text)) input.value = '';
});
window.addEventListener('pagehide', () => {
  closed = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  clearTimeout(handshakeTimer);
  clearTimeout(reactionTimer);
  try { ws?.close(); } catch {}
}, {once: true});
mountKeyboardHelp();
mountReactions();
connect();
