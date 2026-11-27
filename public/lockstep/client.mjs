import {CONTROLS, MAX_FRAME_LEAD, MAX_LOCKSTEP_PLAYERS, isCheckpoint, isFrameRate, isLockstepPlayerCount, isStateHash, isWinner} from './protocol.mjs';
import {mountGameLoader} from './loading.mjs';

const {gameId, bridgeUrl, lobbyWsUrl} = window.__LOCKSTEP_CONFIG__;
const params = new URLSearchParams(location.search);
const status = document.querySelector('#match-status');
const mount = document.querySelector('#match-stage');
const controls = document.querySelector('footer');
const returnButton = document.querySelector('#match-return');
const ticketKey = 'lockstep-seat:' + location.pathname + location.search;
const incomingTicket = new URLSearchParams(location.hash.slice(1)).get('token');
const token = incomingTicket ?? readStorage(() => window.sessionStorage.getItem(ticketKey));
const seat = Number(params.get('seat'));
const levelId = Number(params.get('level'));
const room = params.get('room');
document.querySelector('#match-room').textContent = room || '—';
const returnUrl = room ? '/?room=' + encodeURIComponent(room) : '/';
const loader = mountGameLoader(mount.parentElement, {backUrl: returnUrl, onBack: returnToRoom});
const loading = new AbortController();
const renderPreference = document.querySelector('#match-render-quality');
const renderInfo = document.querySelector('#match-render-size');
const qualityKey = 'bomb-it-render-quality';
const reconnectWindow = 20_000;
const receivedWindow = 8_000;
const recentAcks = new Map();
let socket, game, match, initialHash, result, votes, pendingVote;
let phase = 'connecting';
let frame = 0;
let input = 0;
let playerCount = 2;
let fpsStartedAt = 0;
let fpsStartedFrame = 0;
let reconnecting = false;
let welcomeReceived = false;
let reconnectStartedAt, reconnectTimer, lastPacketAt, watchdog, catchupTarget;

const reasons = {
  MATCH_ABORTED: '有玩家返回了房间，本局已结束。',
  MATCH_CLIENT_ERROR: '有玩家的游戏构建运行失败，本局已结束。',
  MATCH_DESYNC: '各端游戏状态不一致，本局已停止。请返回房间重新开局。',
  MATCH_DISCONNECTED: '有玩家已断线，本局已结束。',
  MATCH_RECONNECT_TIMEOUT: '有玩家未能及时重连，本局已结束。',
  MATCH_REPLAY_UNAVAILABLE: '本局已超出刷新恢复的帧数范围，请返回房间重开。',
  MATCH_PROTOCOL_ERROR: '收到无效的联机数据，本局已停止。',
  MATCH_SETUP_TIMEOUT: '有玩家未能及时加载游戏，请返回房间重试。',
  MATCH_TIMEOUT: '有玩家未能及时同步，本局已停止。',
  SESSION_ENDED: '联机会话已结束。',
};

function readStorage(action) {
  try { return action(); } catch { return null; }
}

if (renderPreference) {
  renderPreference.value = readStorage(() => localStorage.getItem(qualityKey)) === 'performance' ? 'performance' : 'auto';
  renderPreference.addEventListener('change', () => {
    readStorage(() => localStorage.setItem(qualityKey, renderPreference.value));
    renderInfo.textContent = '已保存，下次加载时生效。';
  });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function disposeGame() {
  try { game?.dispose?.(); }
  catch (error) { console.error(error); }
  game = undefined;
}

function closeMatch(message) {
  if (phase === 'ended') return;
  const duringSetup = ['connecting', 'loading', 'retry', 'ready'].includes(phase);
  phase = 'ended';
  document.querySelector('#match-fps').textContent = '—';
  showLoading({phase: 'ended', title: duringSetup ? '无法进入对战' : '对局已结束', detail: message});
  clearTimeout(reconnectTimer);
  clearInterval(watchdog);
  readStorage(() => window.sessionStorage.removeItem(ticketKey));
  socket?.close();
  loading.abort();
  disposeGame();
}

function fail(error) {
  console.error(error);
  send({type: 'error'});
  closeMatch('游戏加载或运行失败，请返回房间。');
}

function updateInput(mask) {
  if (phase !== 'playing' || reconnecting || input === mask) return;
  input = mask;
  send({type: 'input', mask});
}

function onKey(event) {
  if (phase !== 'playing' || reconnecting) return;
  const bit = (game?.bindings ?? CONTROLS)[event.code];
  if (!bit) return;
  if (event.metaKey || event.ctrlKey || event.target?.closest?.('button, select, input, a')) {
    if (event.type === 'keyup') updateInput(input & ~bit);
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  updateInput(event.type === 'keydown' ? input | bit : input & ~bit);
}

window.addEventListener('keydown', onKey, true);
window.addEventListener('keyup', onKey, true);
window.addEventListener('blur', () => updateInput(0));
document.addEventListener('visibilitychange', () => { if (document.hidden) updateInput(0); });
function returnToRoom() {
  send({type: 'leave'});
  closeMatch('正在返回房间…');
  location.assign(returnUrl);
}
returnButton.addEventListener('click', returnToRoom);

function showLoading(progress) {
  status.hidden = true;
  status.textContent = progress.detail || progress.title;
  loader.show(progress);
}

showLoading({phase: 'connect', title: '正在连接对战房间'});

function showRecovery(detail = '正在恢复同一场对局。') {
  document.querySelector('#match-fps').textContent = '—';
  showLoading({phase: 'recover', title: '正在重连', detail});
}

function sendReady() {
  if (!welcomeReceived || !initialHash) return;
  if (match.reconnecting) {
    send({type: 'resume', frame, ...(frame === 0 ? {hash: initialHash} : {})});
  } else {
    send({type: 'ready', hash: initialHash});
  }
}

async function loadGame(retry = false) {
  phase = 'loading';
  showLoading({phase: 'initialize', title: '正在加载游戏'});
  let retryDownload = false;
  try {
    const {createGame} = await import(bridgeUrl);
    if (loading.signal.aborted) return;
    const engine = await createGame({mount, levelId, seed: match.seed, tickRate: match.tickRate, playerCount,
      playerOutfits: match.playerOutfits, bombItSettings: match.bombItSettings, renderQuality: renderPreference?.value,
      signal: loading.signal, retry, onProgress: progress => {
        retryDownload = ['download', 'verify'].includes(progress.phase);
        if (phase === 'loading') showLoading(progress);
      }});
    if (loading.signal.aborted) {
      engine?.dispose?.();
      return;
    }
    game = engine;
    if (typeof game?.step !== 'function' || typeof game?.stateHash !== 'function')
      throw Error('The game bridge is missing step or stateHash');
    initialHash = game.stateHash();
    if (!isStateHash(initialHash)) throw Error('Invalid initial state hash');
    if (gameId === 'bomb-it-7') {
      controls.innerHTML = '<div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd>移动</div><div><kbd>空格</kbd>攻击</div>';
      if (game.rendering && renderInfo) renderInfo.textContent = `当前 ${game.rendering.width} × ${game.rendering.height}`;
    } else {
      controls.textContent = game.controlsHint ?? 'W A S D · J K L U I O';
    }
    phase = match.reconnecting && match.started ? 'playing' : 'ready';
    sendReady();
    if (reconnecting) showRecovery('游戏已加载，正在同步对局进度。');
    else showLoading({phase: 'waiting', title: '游戏已就绪', detail: '正在等待其他玩家完成加载。'});
  } catch (error) {
    if (loading.signal.aborted) return;
    disposeGame();
    console.error(error);
    phase = 'retry';
    const detail = error.name === 'TimeoutError' ? '下载原版资源超时。' : error.message;
    showLoading({phase: 'error', title: '游戏加载失败', detail, retry: () => {
      if (phase === 'retry') void loadGame(retryDownload);
    }});
  }
}

function onWelcome(message) {
  const count = message.playerCount ?? 2;
  if (message.seat !== seat || message.levelId !== levelId || !isFrameRate(message.tickRate) ||
      !Number.isInteger(message.seed) || !isLockstepPlayerCount(count) || seat >= count)
    throw Error('Invalid match configuration');
  if (message.nextRound) {
    if (phase !== 'completed') throw Error('Unexpected rematch');
    frame = 0;
    initialHash = result = votes = undefined;
    pendingVote = false;
    recentAcks.clear();
    phase = 'connecting';
  } else if (match && (match.seed !== message.seed || playerCount !== count || match.tickRate !== message.tickRate)) {
    throw Error('Reconnected to a different match');
  }
  match = message;
  welcomeReceived = true;
  reconnectStartedAt = undefined;
  reconnecting = Boolean(message.reconnecting);
  catchupTarget = reconnecting ? message.frame : undefined;
  playerCount = count;
  document.querySelector('#match-players').textContent = `${playerCount} 人 · P${seat + 1}`;
  if (reconnecting && game) {
    if (message.started && phase === 'ready') phase = 'playing';
    showRecovery('席位已恢复，正在同步对局进度。');
    sendReady();
  } else if (phase === 'connecting') {
    void loadGame();
  }
}

function showPlaying() {
  reconnecting = false;
  reconnectStartedAt = catchupTarget = undefined;
  phase = 'playing';
  loader.hide();
  status.hidden = false;
  controls.hidden = false;
  status.textContent = '对战中 · P' + (seat + 1);
  fpsStartedAt = performance.now();
  fpsStartedFrame = frame;
}

function showResult() {
  const winner = result.winner === null ? '平局' : 'P' + (result.winner + 1) + ' 获胜';
  const voteCount = votes?.votes ?? 0;
  const needed = votes?.needed ?? playerCount;
  const voted = votes?.votedSeats?.includes(seat) || pendingVote;
  let detail = `${winner} · 第 ${result.frame} 帧已结算`;
  if (result.canRematch) detail += ` · ${voted ? '已同意再开' : '再开投票'} ${voteCount}/${needed}`;
  showLoading({phase: 'result', title: '对局结算', detail,
    retryLabel: '再来一局', retry: result.canRematch && !voted ? () => {
      pendingVote = true;
      send({type: 'rematch'});
      showResult();
    } : undefined});
  // Keep the plain result in the sidebar for assistive navigation and existing readers.
  status.textContent = `${winner} · 第 ${result.frame} 帧已结算`;
}

function completeMatch(message) {
  phase = 'completed';
  reconnecting = false;
  reconnectStartedAt = undefined;
  pendingVote = false;
  result = message;
  document.querySelector('#match-fps').textContent = '—';
  disposeGame();
  showResult();
  if (!message.canRematch) {
    phase = 'ended';
    readStorage(() => window.sessionStorage.removeItem(ticketKey));
    clearInterval(watchdog);
    socket?.close();
    loading.abort();
  }
}

function step(message) {
  if (reconnecting && message.frame <= frame) {
    const cached = recentAcks.get(message.frame);
    if (!cached) throw Error('Missing recent frame acknowledgement');
    send(cached);
    return;
  }
  if (phase === 'finishing') return;
  if (phase !== 'playing' || message.frame !== frame + 1 ||
      message.masks?.length !== playerCount || message.pressed?.length !== playerCount) throw Error('Unexpected input frame');
  frame = message.frame;
  const result = game.step({frame, masks: message.masks, pressed: message.pressed});
  const final = result !== undefined;
  if (final && !isWinner(result?.winner, playerCount)) throw Error('Invalid round result');
  const report = {type: 'ack', frame};
  if (isCheckpoint(frame) || final) {
    report.hash = game.stateHash();
    if (!isStateHash(report.hash)) throw Error('Invalid state hash');
  }
  if (final) {
    report.winner = result.winner;
    phase = 'finishing';
    status.textContent = '正在核对各端对局结果…';
  }
  recentAcks.set(frame, report);
  recentAcks.delete(frame - MAX_FRAME_LEAD - 1);
  send(report);
  const now = performance.now();
  if (reconnecting && catchupTarget > frame && frame % 30 === 0) {
    showRecovery(`正在恢复第 ${frame} / ${catchupTarget} 帧。`);
  } else if (!reconnecting && now - fpsStartedAt >= 1000) {
    document.querySelector('#match-fps').textContent = `${Math.round((frame - fpsStartedFrame) * 1000 / (now - fpsStartedAt))} FPS`;
    fpsStartedAt = now;
    fpsStartedFrame = frame;
  }
}

function connect(url) {
  welcomeReceived = false;
  const candidate = new WebSocket(url);
  socket = candidate;
  const handshakeTimer = setTimeout(() => {
    if (candidate.readyState <= WebSocket.OPEN && !welcomeReceived && socket === candidate) candidate.close();
  }, 6_000);
  candidate.addEventListener('message', ({data}) => {
    if (socket !== candidate || phase === 'ended') return;
    clearTimeout(handshakeTimer);
    lastPacketAt = performance.now();
    try {
      const message = JSON.parse(data);
      switch (message.type) {
        case 'welcome': onWelcome(message); break;
        case 'start':
          if (phase !== 'ready') throw Error('Match started before the game was ready');
          showPlaying();
          break;
        case 'frame': step(message); break;
        case 'paused':
          reconnecting = true;
          input = 0;
          if (phase !== 'loading' && phase !== 'retry') showRecovery(`正在等待 P${message.seat + 1} 重新连接。`);
          break;
        case 'resumed':
          if (phase !== 'playing') throw Error('Match resumed before the game was ready');
          showPlaying();
          break;
        case 'rematch-votes':
          if (phase === 'completed') {
            votes = message;
            pendingVote = false;
            showResult();
          }
          break;
        case 'ended':
          if (message.reason === 'MATCH_COMPLETED') completeMatch(message);
          else closeMatch(reasons[message.reason] ?? '对战已结束。');
          break;
        default: throw Error('Unknown match message');
      }
    } catch (error) { if (phase !== 'ended') fail(error); }
  });
  candidate.addEventListener('close', () => {
    clearTimeout(handshakeTimer);
    if (socket !== candidate || phase === 'ended') return;
    reconnectStartedAt ??= performance.now();
    const remaining = reconnectWindow - (performance.now() - reconnectStartedAt);
    if (remaining <= 0) {
      closeMatch('对局连接未能恢复，请返回房间。');
      return;
    }
    reconnecting = true;
    input = 0;
    if (phase !== 'loading' && phase !== 'retry') showRecovery('网络连接中断，正在重新连接。');
    reconnectTimer = setTimeout(() => connect(url), Math.min(750, remaining));
  });
}

if (!/^[a-f0-9]{48}$/.test(token ?? '') || !params.has('seat') || !params.has('level') ||
    !Number.isInteger(seat) || seat < 0 || seat >= MAX_LOCKSTEP_PLAYERS || !Number.isSafeInteger(levelId) || levelId < 0) {
  closeMatch('请先在大厅创建或加入房间。');
} else {
  if (incomingTicket) {
    readStorage(() => window.sessionStorage.setItem(ticketKey, token));
    history.replaceState(null, '', location.pathname + location.search);
  }
  const url = new URL(lobbyWsUrl);
  url.pathname = '/lockstep';
  url.searchParams.set('token', token);
  connect(url);
  window.addEventListener('offline', () => socket?.close());
  watchdog = setInterval(() => {
    if (['playing', 'finishing'].includes(phase) && !reconnecting && socket?.readyState === WebSocket.OPEN &&
        performance.now() - lastPacketAt > receivedWindow) socket.close();
  }, 1_000);
}
