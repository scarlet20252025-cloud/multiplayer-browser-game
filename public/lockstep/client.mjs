import {CONTROLS, FRAME_RATE, isCheckpoint, isStateHash, isWinner} from './protocol.mjs';

const {bridgeUrl, lobbyWsUrl} = window.__LOCKSTEP_CONFIG__;
const params = new URLSearchParams(location.search);
const status = document.querySelector('#match-status');
const mount = document.querySelector('#match-stage');
const returnButton = document.querySelector('#match-return');
const token = new URLSearchParams(location.hash.slice(1)).get('token');
const seat = Number(params.get('seat'));
const levelId = Number(params.get('level'));
const room = params.get('room');
const returnUrl = room ? '/?room=' + encodeURIComponent(room) : '/';
let socket, game;
let phase = 'connecting';
let frame = 0;
let input = 0;

const reasons = {
  MATCH_ABORTED: '有玩家返回了房间，本局已结束。',
  MATCH_CLIENT_ERROR: '有玩家的游戏构建运行失败，本局已结束。',
  MATCH_DESYNC: '双方游戏状态不一致，本局已停止。请返回房间重新开局。',
  MATCH_DISCONNECTED: '有玩家已断线，本局已结束。',
  MATCH_PROTOCOL_ERROR: '收到无效的联机数据，本局已停止。',
  MATCH_SETUP_TIMEOUT: '双方未能及时加载游戏，请返回房间重试。',
  MATCH_TIMEOUT: '有玩家未能及时同步，本局已停止。',
  SESSION_ENDED: '联机会话已结束。',
};

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function closeMatch(message) {
  if (phase === 'ended') return;
  phase = 'ended';
  status.textContent = message;
  socket?.close();
  try { game?.dispose?.(); }
  catch (error) { console.error(error); }
}

function fail(error) {
  console.error(error);
  send({type: 'error'});
  closeMatch('游戏加载或运行失败，请返回房间。');
}

function updateInput(mask) {
  if (phase !== 'playing' || input === mask) return;
  input = mask;
  send({type: 'input', mask});
}

function onKey(event) {
  const bit = CONTROLS[event.code];
  if (!bit) return;
  if (event.metaKey || event.ctrlKey || event.target === returnButton) {
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
returnButton.addEventListener('click', () => {
  send({type: 'leave'});
  closeMatch('正在返回房间…');
  location.assign(returnUrl);
});

async function loadGame(message) {
  if (phase !== 'connecting' || message.seat !== seat || message.levelId !== levelId ||
      message.tickRate !== FRAME_RATE || !Number.isInteger(message.seed))
    throw Error('Invalid match configuration');
  phase = 'loading';
  status.textContent = '正在加载对战…';
  const {createGame} = await import(bridgeUrl);
  if (phase === 'ended') return;
  const engine = await createGame({mount, levelId, seed: message.seed, tickRate: FRAME_RATE});
  if (phase === 'ended') {
    engine?.dispose?.();
    return;
  }
  game = engine;
  if (typeof game?.step !== 'function' || typeof game?.stateHash !== 'function')
    throw Error('The game bridge is missing step or stateHash');
  const hash = game.stateHash();
  if (!isStateHash(hash)) throw Error('Invalid initial state hash');
  phase = 'ready';
  send({type: 'ready', hash});
  status.textContent = '已就绪，等待另一位玩家。';
}

function step(message) {
  if (phase === 'finishing') return;
  if (phase !== 'playing' || message.frame !== frame + 1) throw Error('Unexpected input frame');
  frame = message.frame;
  const result = game.step({frame, masks: message.masks, pressed: message.pressed});
  const final = result !== undefined;
  if (final && !isWinner(result?.winner)) throw Error('Invalid round result');
  const report = {type: 'ack', frame};
  if (isCheckpoint(frame) || final) {
    report.hash = game.stateHash();
    if (!isStateHash(report.hash)) throw Error('Invalid state hash');
  }
  if (final) {
    report.winner = result.winner;
    phase = 'finishing';
    status.textContent = '正在核对双方对局结果…';
  }
  send(report);
}

if (!/^[a-f0-9]{48}$/.test(token ?? '') || !params.has('seat') || !params.has('level') ||
    ![0, 1].includes(seat) || !Number.isSafeInteger(levelId) || levelId < 0) {
  closeMatch('请先在大厅创建或加入房间。');
} else {
  history.replaceState(null, '', location.pathname + location.search);
  const url = new URL(lobbyWsUrl);
  url.pathname = '/lockstep';
  url.searchParams.set('token', token);
  socket = new WebSocket(url);
  socket.addEventListener('message', async ({data}) => {
    if (phase === 'ended') return;
    try {
      const message = JSON.parse(data);
      switch (message.type) {
        case 'welcome': await loadGame(message); break;
        case 'start':
          if (phase !== 'ready') throw Error('Match started before the game was ready');
          phase = 'playing';
          status.textContent = '对战中 · P' + (seat + 1);
          break;
        case 'frame': step(message); break;
        case 'ended':
          closeMatch(message.reason === 'MATCH_COMPLETED'
            ? `${message.winner === null ? '平局' : 'P' + (message.winner + 1) + ' 获胜'} · 第 ${message.frame} 帧已结算`
            : (reasons[message.reason] ?? '对战已结束。'));
          break;
        default: throw Error('Unknown match message');
      }
    } catch (error) { if (phase !== 'ended') fail(error); }
  });
  socket.addEventListener('close', () => closeMatch('对战连接已关闭，请返回房间。'));
  socket.addEventListener('error', () => closeMatch('无法连接对战房间，请返回大厅重试。'));
}
