import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createBvn33RoomService} from '../server/bvn33-room-service.mjs';

const [privateSidecar, browserSidecar, lobbyOrigin, ...options] = process.argv.slice(2);
if (!privateSidecar || !browserSidecar || !lobbyOrigin)
  throw Error('Usage: node scripts/verify-bvn33-cache.mjs <private sidecar origin> <browser sidecar origin> <lobby origin> [--direct]');

const gameEndpoint = new URL(browserSidecar);
const gameOrigin = gameEndpoint.origin;
const gamePath = gameEndpoint.pathname.replace(/\/?$/, '/');
const service = createBvn33RoomService(privateSidecar, browserSidecar);
const began = performance.now();
const trace = [];
const pages = [];
let browser, room, phase = 'service-health', swfRequests = 0;
const deadline = setTimeout(() => {
  phase = 'overall-timeout';
  void Promise.allSettled([browser?.close(), room?.close()]);
}, 300_000);

function resource(raw) {
  const url = new URL(raw);
  if (url.host !== gameEndpoint.host || !url.pathname.startsWith(gamePath)) return null;
  const relative = url.pathname.slice(gamePath.length);
  if (relative === '' || /^(?:socket|api\/join|(?:net-[\w-]+|client|emotes|bot|lobby-capture)\.(?:html|js)|style\.css|game\/net\.swf|ruffle\/[\w./-]+\.(?:js|wasm))$/.test(relative))
    return url.pathname;
  return null;
}

function log(event, properties = {}) {
  const entry = {phase, ms:Math.round(performance.now() - began), event, ...properties};
  trace.push(entry);
  if (trace.length > 100) trace.shift();
  if (event === 'checkpoint' || event === 'navigation-retry' || event === 'navigation-peer' ||
      (event === 'http' && (properties.status >= 400 || properties.path === gamePath)))
    console.log(JSON.stringify(entry));
}

function errorKind(error) {
  const message = String(error?.message ?? '');
  return {kind: error?.name === 'TimeoutError' ? 'timeout' : error?.name === 'AssertionError' ? 'assertion' : 'error',
    network: message.match(/\bnet::[A-Z0-9_]+\b/)?.[0] ?? null,
    status: Number.isInteger(error?.status) ? error.status : null};
}

async function inspect(page) {
  const snapshot = page.evaluate(expectedPath => {
    const engine = document.querySelector('#engine');
    const loading = document.querySelector('#loading-text')?.textContent ?? '';
    const detail = document.querySelector('#download-detail')?.textContent ?? '';
    const launch = document.querySelector('#bvn-launch-status')?.textContent ?? '';
    const labels = ['正在连接', '正在重新加载', '正在启动', '正在下载', '正在使用本地缓存', '正在初始化',
      '下载完成', '游戏已加载', '连接中断', '暂时无法连接', '游戏加载或运行失败', '席位已失效'];
    const hint = value => labels.find(label => value.startsWith(label)) ?? (value ? 'other' : null);
    const progress = detail.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*MB/);
    let mode;
    try { mode = engine?.contentWindow?.netDebug?.().mode; } catch {}
    const stage = window.netState?.stage;
    const cache = window.bvnCacheVerification;
    return {pathname:location.pathname === expectedPath ? expectedPath : 'unexpected', iframe:Boolean(engine?.getAttribute('src')),
      mode:['loading','barrier','running','paused','error'].includes(mode) ? mode : null,
      launch:document.querySelector('#bvn-launch')?.hidden === false ? hint(launch) : null,
      loading:hint(loading), progressMb:progress ? [Number(progress[1]),Number(progress[2])] : null,
      cache:cache ? {downloaded:cache.downloaded === true,cached:cache.cached === true} : null,
      stage:typeof stage === 'string' ? ['SelectFighterStage','LoadingState','GameState'].find(name => stage.endsWith('::'+name)) ?? 'other' : null};
  }, gamePath).catch(() => null);
  let timer;
  try {
    return await Promise.race([snapshot, new Promise(resolve => { timer = setTimeout(() => resolve(null), 2500); })]);
  } finally { clearTimeout(timer); }
}

function engineReady(page, timeout) {
  return page.waitForFunction(() => {
    try { return document.querySelector('#engine')?.contentWindow?.netDebug?.().mode === 'barrier'; }
    catch { return false; }
  }, null, {timeout});
}

async function assertEntry(page, response) {
  assert.equal(new URL(page.url()).origin, gameOrigin);
  assert.equal(new URL(page.url()).pathname, gamePath);
  if (gamePath !== '/') assert.equal(response.headers()['x-bvn33-entry'], '1');
  assert.equal(await page.locator('#engine').count(), 1);
}

const transientNavigation = new Set(['net::ERR_ABORTED','net::ERR_EMPTY_RESPONSE','net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_RESET','net::ERR_CONNECTION_ABORTED','net::ERR_CONNECTION_REFUSED',
  'net::ERR_CONNECTION_TIMED_OUT','net::ERR_TIMED_OUT','net::ERR_PROXY_CONNECTION_FAILED']);

async function navigate(page, address, reload = false) {
  const delays = [0, 500, 1000, 2000];
  const options = {waitUntil:'domcontentloaded',timeout:12_000};
  for (const [index, delay] of delays.entries()) {
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    let response;
    try {
      response = reload && index === 0 ? await page.reload(options) : await page.goto(address, options);
      const status = response?.status();
      if (response) {
        const peer = await response.serverAddr().catch(() => null);
        if (peer && /^[\da-f.:]+$/i.test(peer.ipAddress) && Number.isInteger(peer.port))
          log('navigation-peer', {status,address:peer.ipAddress,port:peer.port});
      }
      if (status !== 200) throw Object.assign(Error('Entry response failed'), {status});
    } catch (error) {
      const failure = errorKind(error);
      if (index === delays.length - 1 || !(
        failure.status === 408 || failure.status === 429 || failure.status >= 500 ||
        failure.kind === 'timeout' || transientNavigation.has(failure.network))) throw error;
      log('navigation-retry', {attempt:index+1,error:failure});
      continue;
    }
    await assertEntry(page, response);
    return;
  }
}

function collectSocket(page) {
  pages.push(page);
  page.on('websocket', socket => {
    const pathname = resource(socket.url());
    if (pathname !== `${gamePath}socket`) return;
    log('ws-open', {path:pathname});
    socket.once('socketerror', () => log('ws-error', {path:pathname}));
    socket.once('close', () => log('ws-close', {path:pathname}));
    const seen = new Set();
    socket.on('framereceived', ({payload}) => {
      if (typeof payload !== 'string') return;
      try {
        const {type, state} = JSON.parse(payload);
        if (!['reset','status','resume','frame'].includes(type)) return;
        const kind = type === 'status' && ['loading','starting','running','error','disconnected'].includes(state) ? `${type}-${state}` : type;
        if (!seen.has(kind)) { seen.add(kind); log('ws-message', {kind}); }
      } catch {}
    });
  });
}

try {
  await service.check();
  phase = 'create-test-room';
  room = await service.start({roomName:'资源缓存验收', playerNames:['缓存验收 P1','缓存验收 P2'], lobbyOrigin});
  phase = 'launch-browser';
  const args = ['--enable-unsafe-swiftshader','--use-angle=swiftshader'];
  if (options.includes('--direct')) args.push('--proxy-server=direct://', `--proxy-bypass-list=${gameEndpoint.hostname}`);
  else args.push('--no-proxy-server');
  browser = await chromium.launch({args});
  const context = await browser.newContext();
  await context.addInitScript(() => {
    const observed = {downloaded:false,cached:false};
    window.bvnCacheVerification = observed;
    window.addEventListener('message', event => {
      if (event.origin !== location.origin || event.source !== document.querySelector('#engine')?.contentWindow) return;
      const message = event.data;
      if (message?.type !== 'download' || message.name !== '游戏资源' || message.complete !== true) return;
      if (message.cached === true) observed.cached = true;
      else observed.downloaded = true;
    });
  });
  context.on('request', request => {
    if (resource(request.url())?.endsWith('/game/net.swf')) swfRequests++;
  });
  context.on('response', response => {
    const pathname = resource(response.url());
    if (pathname) log('http', {path:pathname,status:response.status(),
      ...(pathname === gamePath ? {entry:response.headers()['x-bvn33-entry'] === '1'} : {})});
  });
  context.on('requestfailed', request => {
    const pathname = resource(request.url());
    if (pathname) log('request-failed', {path:pathname,network:errorKind({message:request.failure()?.errorText}).network});
  });

  const first = await context.newPage();
  collectSocket(first);
  const coldStart = performance.now();
  phase = 'cold-entry';
  await navigate(first, room.launchUrls[0]);
  phase = 'cold-initialize';
  await engineReady(first, 140_000);
  const coldMs = Math.round(performance.now() - coldStart);
  const coldRequests = swfRequests;
  const coldState = await inspect(first);
  assert(coldRequests > 0 && coldState?.cache?.downloaded && !coldState.cache.cached);
  log('checkpoint', {coldMs,coldRequests,state:coldState});

  const warmStart = performance.now();
  phase = 'warm-entry';
  await navigate(first, first.url(), true);
  phase = 'warm-initialize';
  await engineReady(first, 75_000);
  const warmMs = Math.round(performance.now() - warmStart);
  const warmState = await inspect(first);
  assert.equal(swfRequests, coldRequests);
  assert(warmState?.cache?.cached && !warmState.cache.downloaded);
  log('checkpoint', {warmMs,requests:0,state:warmState});

  phase = 'second-entry';
  const second = await context.newPage();
  collectSocket(second);
  await navigate(second, room.launchUrls[1]);
  phase = 'two-player-selection';
  await Promise.all([first, second].map(page => page.waitForFunction(
    () => window.netState?.stage?.endsWith('::SelectFighterStage'), null, {timeout:75_000})));
  assert.equal(swfRequests, coldRequests);
  const secondState = await inspect(second);
  assert(secondState?.cache?.cached && !secondState.cache.downloaded);
  console.log(JSON.stringify({gameOrigin,coldMs,warmMs,coldRequests,reloadRequests:0,reachedFighterSelect:true}));
} catch(error) {
  console.error(JSON.stringify({ok:false,phase,error:errorKind(error),swfRequests,pages:await Promise.all(pages.map(inspect)),trace}));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  const results = await Promise.allSettled([browser?.close(), room?.close()]);
  for (const [index, result] of results.entries()) if (result.status === 'rejected') {
    console.error(JSON.stringify({phase:index === 0 ? 'close-browser' : 'close-test-room',error:errorKind(result.reason)}));
    process.exitCode = 1;
  }
}
