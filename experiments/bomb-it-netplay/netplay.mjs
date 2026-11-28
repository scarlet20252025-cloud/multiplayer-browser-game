import {downloadOriginalSwf, sha256Hex} from './original-file.mjs';
import {prepareOriginalSwfForRuffle} from './compatibility.mjs';
import {BOMB_IT_DEFAULT_SETTINGS, isBombItSettings} from '/__lockstep__/protocol.mjs';

const STAGE_WIDTH = 700;
const STAGE_HEIGHT = 510;
const OUTFIT_FIELDS = ['clothId', 'hatId', 'expId'];
const KEY_BINDINGS = Object.freeze({KeyA: 1, KeyD: 2, KeyW: 4, KeyS: 8, Space: 16});
const SEAT_CODES = [
  ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'Space'],
  ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Enter'],
  ['KeyJ', 'KeyL', 'KeyU', 'KeyK', 'KeyO'],
  ['KeyF', 'KeyH', 'KeyT', 'KeyG', 'KeyY'],
];
const encoder = new TextEncoder();
const delay = () => new Promise(resolve => setTimeout(resolve, 0));

async function waitUntil(check, description, signal) {
  const deadline = performance.now() + 10_000;
  do {
    signal?.throwIfAborted();
    const result = check();
    if (result) return result;
    await delay();
  } while (performance.now() < deadline);
  throw new Error(description);
}

function sendKey(window, code, held) {
  const key = code.startsWith('Key') ? code.slice(3).toLowerCase() : code === 'Space' ? ' ' : code;
  window.dispatchEvent(new window.KeyboardEvent(held ? 'keydown' : 'keyup', {
    code, key, cancelable: true, bubbles: true,
  }));
}

function isMatchReady(state, playerCount) {
  return state?.[2]?.length === playerCount && state?.[3]?.length === playerCount && state?.[5]?.length > 0;
}

function hasAcceleratedWebGL() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const gl = canvas.getContext('webgl2', {failIfMajorPerformanceCaveat: true});
  if (!gl) return false;
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
    return !/swiftshader|llvmpipe|software|basic render driver/i.test(renderer);
  } finally {
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function chooseRendering(renderQuality, displayedWidth) {
  const mode = renderQuality === 'performance' ? 'performance' : 'auto';
  const physicalWidth = displayedWidth * window.devicePixelRatio;
  let pixelRatio = 1;
  if (mode === 'performance') pixelRatio = 0.5;
  else if (physicalWidth >= 875 && hasAcceleratedWebGL()) pixelRatio = physicalWidth >= 1120 ? 2 : 1.5;
  const width = STAGE_WIDTH * pixelRatio;
  const height = STAGE_HEIGHT * pixelRatio;
  return {mode, pixelRatio, width, height};
}

function encodePlayerOutfits(playerOutfits, playerCount) {
  if (playerOutfits === undefined) return '';
  if (!Array.isArray(playerOutfits) || playerOutfits.length !== playerCount) throw new TypeError('对局装扮数据与玩家人数不一致');
  const outfits = Array.from(playerOutfits, (outfit, seat) => {
    const parts = OUTFIT_FIELDS.map(field => {
      const id = outfit?.[field];
      if (!Number.isInteger(id) || id < 0 || id > 3) throw new RangeError('对局装扮编号无效');
      return id;
    });
    const robotId = outfit.robotId ?? seat;
    if (!Number.isInteger(robotId) || robotId < 0 || robotId > 7) throw new RangeError('对局角色编号无效');
    return [...parts, robotId];
  });
  return JSON.stringify(outfits);
}

export async function createGame({mount, seed, tickRate, playerCount = 2, playerOutfits,
  bombItSettings = BOMB_IT_DEFAULT_SETTINGS, renderQuality, signal, retry, onProgress = () => {},
}) {
  if (tickRate !== 40) throw new Error('此运行器需要 40 Hz 联机时钟');
  if (![2, 3, 4].includes(playerCount)) throw new RangeError('对局需要 2 至 4 名玩家');
  if (!isBombItSettings(bombItSettings)) throw new RangeError('对局地图或模式无效');
  const {mapId, modeId} = bombItSettings;
  const outfits = encodePlayerOutfits(playerOutfits, playerCount);
  const bytes = await downloadOriginalSwf({signal, retry, onProgress});
  onProgress({phase: 'initialize', title: '正在初始化游戏'});
  const runtimeBytes = await prepareOriginalSwfForRuffle(bytes, {signal});
  const iframe = document.createElement('iframe');
  iframe.src = new URL('./movie.html', import.meta.url);
  iframe.title = 'Q版泡泡堂7 原版对战';
  // A fixed logical stage lets the viewer resize without changing game geometry.
  const frameBox = document.createElement('div');
  frameBox.style.cssText = `width:100%;aspect-ratio:${STAGE_WIDTH}/${STAGE_HEIGHT};position:relative;overflow:hidden`;
  iframe.style.cssText = `position:absolute;inset:0;width:${STAGE_WIDTH}px;height:${STAGE_HEIGHT}px;border:0;transform-origin:0 0;pointer-events:none`;
  const resizeObserver = new ResizeObserver(([entry]) => {
    iframe.style.transform = `scale(${entry.contentRect.width / STAGE_WIDTH})`;
  });
  frameBox.append(iframe);
  resizeObserver.observe(frameBox);
  let loaded = false;
  iframe.addEventListener('load', () => { loaded = true; }, {once: true});
  const dispose = () => {
    resizeObserver.disconnect();
    frameBox.remove();
  };
  const tasks = new MessageChannel();
  mount.replaceChildren(frameBox);
  try {
    await waitUntil(() => loaded, '游戏运行器载入超时', signal);
    const movie = iframe.contentWindow;
    const rendering = chooseRendering(renderQuality, frameBox.getBoundingClientRect().width);
    Object.defineProperty(movie, 'devicePixelRatio', {value: rendering.pixelRatio});
    // Ruffle falls back to an in-memory SharedObject store for this movie.
    // A peer replaying the match must start with the same empty Flash save state.
    Object.defineProperty(movie, 'localStorage', {value: null});
    // Keep the emulator on the match clock when its tab becomes hidden.
    movie.document.addEventListener('visibilitychange', event => event.stopImmediatePropagation(), true);
    // The function runs in the movie realm so its clock never affects lobby networking.
    movie.installMovieClock({epochMs: 1_700_000_000_000 + seed, tickMs: 25, constantDate: true});
    const originalUrl = movie.URL.createObjectURL(new movie.Blob([runtimeBytes], {type: 'application/x-shockwave-flash'}));
    let snapshot, fetched = false, initialized = false, duelRequested = false, resumed = false, humanPlayers, probeError;
    const player = movie.RufflePlayer.newest().createPlayer();
    movie.document.body.append(player);
    await player.ruffle().load({
      url: new URL('./snapshot-probe.swf', import.meta.url).href,
      base: new URL('.', import.meta.url).href,
      parameters: {originalUrl, seats: String(playerCount), outfits, mapId, modeId},
      autoplay: 'on', allowScriptAccess: false, allowNetworking: 'internal',
      unmuteOverlay: 'hidden', letterbox: 'on', backgroundExecutionMode: 'none',
    });
    player.ruffle().volume = 0.5;
    player.ruffle().traceObserver = message => {
      if (message === 'BOMB_IT_PROBE_FETCHED ' + runtimeBytes.byteLength) fetched = true;
      else if (message.startsWith('BOMB_IT_PROBE_READY ')) initialized = true;
      else if (message === 'BOMB_IT_PROBE_DUEL_REQUESTED') duelRequested = true;
      else if (message === 'BOMB_IT_PROBE_DUEL_RESUMED') resumed = true;
      else if (message.startsWith('BOMB_IT_PROBE_HUMAN_PLAYERS ')) humanPlayers = Number(message.split(' ').at(-1));
      else if (message.startsWith('BOMB_IT_PROBE_STATE ')) snapshot = message.slice('BOMB_IT_PROBE_STATE '.length);
      else if (message.startsWith('BOMB_IT_PROBE_ERROR ')) probeError = message;
    };
    await waitUntil(() => player.ruffle().metadata?.width === STAGE_WIDTH, '状态桥未能加载', signal);
    const advance = count => movie.__ruffleClock.advance(count);
    const tap = code => {
      sendKey(movie, code, true);
      sendKey(movie, code, false);
    };
    const yieldTask = () => new Promise(resolve => {
      tasks.port1.onmessage = resolve;
      tasks.port2.postMessage(null);
    });
    const pump = async (count, stride = 1) => {
      try {
        for (let remaining = count; remaining > 0;) {
          signal?.throwIfAborted();
          const deadline = performance.now() + 12;
          const limit = Math.max(0, remaining - 60);
          while (remaining > limit) {
            const ticks = Math.min(stride, remaining - limit);
            if (stride === 1) advance(ticks);
            else movie.__ruffleClock.advanceBoot(ticks);
            remaining -= ticks;
            if (performance.now() >= deadline) break;
          }
          await yieldTask();
        }
      } finally {
        tasks.port1.onmessage = null;
      }
    };
    const inspect = () => {
      snapshot = undefined;
      tap('F9');
      return snapshot && JSON.parse(snapshot);
    };
    advance(3);
    await waitUntil(() => {
      if (probeError) throw new Error(probeError);
      return fetched;
    }, '原版文件未能加载', signal);
    movie.URL.revokeObjectURL(originalUrl);
    player.dispatchEvent(new movie.FocusEvent('focusin', {bubbles: true}));
    tap('F8');
    for (let count = 0; count < 8 && !initialized; count++) await pump(4);
    if (!initialized) throw new Error(probeError ?? '原版运行器未启动');
    onProgress({phase: 'initialize', title: '正在初始化游戏', detail: '正在启动原版游戏。'});
    for (let count = 0; !duelRequested && count < 90; count++) {
      // Ruffle can run several SWF frames in one repaint during the intro.
      await pump(20, 5);
      tap('F7');
      if (probeError) throw new Error(probeError);
    }
    if (!duelRequested) throw new Error('原版主菜单未能就绪。');
    onProgress({phase: 'initialize', title: '正在初始化游戏', detail: '正在准备对战地图。'});
    let state;
    // The engine starts paused before the map exists, then the stock game pauses it
    // again when its loading timer completes. Wait for that second pause overlay.
    for (let count = 0; count < 100; count++) {
      await pump(5);
      state = inspect();
      if (isMatchReady(state, playerCount) && state[6] === true) break;
      if (probeError) throw new Error(probeError);
    }
    if (!isMatchReady(state, playerCount) || state[6] !== true) throw new Error('原版对战地图未能就绪。');
    movie.__ruffleClock.resumeWallClock();
    tap('F6');
    if (!resumed || humanPlayers !== playerCount) throw new Error(probeError ?? '原版对局未能启动。');
    await pump(4);
    state = inspect();
    if (!isMatchReady(state, playerCount) || state[1][6] !== false) throw new Error('原版对局状态异常。');
    if (state[7]?.[0] !== mapId || state[7]?.[1] !== modeId) throw new Error('原版运行器未应用选定地图或模式。');

    const held = Array(playerCount).fill(0);
    const seats = SEAT_CODES.slice(0, playerCount);
    return {
      bindings: KEY_BINDINGS,
      controlsHint: 'W A S D 移动 · 空格使用当前武器',
      rendering,
      scores() {
        return state[3].map(([life, score, boxScore, , kills, , objective]) => ({life, score, kills, boxScore, objective}));
      },
      step({frame, masks, pressed}) {
        for (const [seat, codes] of seats.entries()) {
          for (const [index, code] of codes.entries()) {
            const bit = 1 << index;
            const before = held[seat] & bit;
            const now = masks[seat] & bit;
            const edge = pressed[seat] & bit;
            if (before && edge) sendKey(movie, code, false);
            if (now && (!before || edge)) sendKey(movie, code, true);
            else if (before && !now && !edge) sendKey(movie, code, false);
            if (!now && edge) sendKey(movie, code, true);
          }
        }
        advance(1);
        for (const [seat, codes] of seats.entries()) {
          for (const [index, code] of codes.entries()) {
            const bit = 1 << index;
            if ((pressed[seat] & bit) && !(masks[seat] & bit)) sendKey(movie, code, false);
          }
          held[seat] = masks[seat];
        }
        if (frame !== 1 && frame % 30 !== 0) return;
        const current = inspect();
        if (!current?.[1]) throw new Error('原版对局状态读取中断');
        state = current;
        if (current[1][5]) {
          const scores = current[3].map(player => player[6]);
          const best = Math.max(...scores);
          const winners = scores.flatMap((score, seat) => score === best ? [seat] : []);
          return {winner: winners.length === 1 ? winners[0] : null};
        }
      },
      stateHash() {
        if (!snapshot) throw new Error('原版对局状态未准备好');
        return sha256Hex(encoder.encode(snapshot));
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    tasks.port1.close();
    tasks.port2.close();
  }
}
