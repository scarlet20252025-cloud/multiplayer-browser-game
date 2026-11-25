export const BVN33_RUNTIME = 'bvn33-online';
export const BVN33_GAME = Object.freeze({
  id: 'bvn33', title: '死神 vs 火影 3.3', subtitle: '浏览器双人对战',
  runtime: BVN33_RUNTIME, adapter: 'bvn33-room-service', seats: 2,
  levels: Object.freeze([Object.freeze({id: 0, order: 0, type: '双人对战', time: 60})]),
});
const validWatchCredential = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);

export function createBvn33RoomService(serviceUrl, publicUrl = serviceUrl) {
  const local = new URL(serviceUrl).origin;
  const browser = new URL(publicUrl);
  if (![local, browser.origin].every(origin => /^https?:\/\//.test(origin)) ||
      browser.username || browser.password || browser.search || browser.hash)
    throw Error('BVN 3.3 service URLs must use HTTP or HTTPS');
  if (!browser.pathname.endsWith('/')) browser.pathname += '/';
  const socket = new URL('socket', browser);
  socket.protocol = browser.protocol === 'https:' ? 'wss:' : 'ws:';

  async function request(route, data) {
    const response = await fetch(local + route, {
      ...(data ? {method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify(data)} : {}),
      signal: AbortSignal.timeout(4000),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(Error(result.error ?? 'BVN 3.3 服务请求失败'),
      {status: response.status});
    return result;
  }

  return {
    async check() {
      const health = await request('/health');
      if (health.mode !== 'local-lockstep' || !['disabled','lobby-lockstep'].includes(health.spectatorMode) || !health.gameInstalled)
        throw Error('BVN 3.3 联机构建未就绪');
    },
    async start({roomName, playerNames, lobbyOrigin}) {
      const back = new URL('/', lobbyOrigin);
      back.searchParams.set('room', roomName);
      const nickname = seat => Array.from(playerNames[seat] || 'P' + (seat + 1)).slice(0, 12).join('');
      const host = await request('/api/create', {nickname: nickname(0),
        settings: {mode: 'single', hpPercent: 100, fightTime: 60}});
      const credential = {code: host.code, token: host.token};
      const close = () => request('/api/lobby-close', credential).catch(error => {
        if (error.status !== 404) throw error;
      });
      try {
        const guest = await request('/api/join', {code: host.code, nickname: nickname(1)});
        if (host.slot !== 1 || guest.slot !== 2 || guest.code !== host.code)
          throw Error('BVN 3.3 服务返回了不匹配的席位');
        const launchUrls = [host, guest].map(({code, token}) => {
          const launch = new URL(browser);
          launch.hash = new URLSearchParams({room:code,seat:token,back:back.href}).toString();
          return launch.href;
        });
        return Object.freeze({
          url: browser.origin, wsUrl:socket.href, launchUrls, close, connectTimeoutMs:120_000,
          async status() {
            const info = await request('/api/lobby-status', credential);
            if (!Array.isArray(info.players) || info.players.length !== 2 ||
                !info.players.every(connected => typeof connected === 'boolean'))
              throw Error('BVN 3.3 返回了无效的房间状态');
            return info;
          },
          ...(validWatchCredential(host.watchKey) ? {async watch({displayName, lobbyOrigin: viewerOrigin = lobbyOrigin} = {}) {
            const returnUrl = new URL('/', viewerOrigin);
            const nickname = typeof displayName === 'string' ? Array.from(displayName.trim()).slice(0, 12).join('') : '';
            const viewer = await request('/api/lobby-watch', {...credential, watchKey: host.watchKey,
              nickname: nickname || '观众', returnUrl: returnUrl.href});
            if (viewer.role !== 'watch' || viewer.code !== host.code || !validWatchCredential(viewer.token) ||
                viewer.token === host.token || viewer.token === guest.token || viewer.token === host.watchKey)
              throw Error('BVN 3.3 返回了无效的观战凭证');
            const launch = new URL('lobby-watch', browser);
            launch.hash = new URLSearchParams({watch: viewer.code, view: viewer.token}).toString();
            return {launchUrl: launch.href};
          }} : {}),
        });
      } catch (error) {
        await close().catch(() => {});
        throw error;
      }
    },
  };
}
