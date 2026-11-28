/**
 * 闪翼双星原生权威房：服务端跑固定步长模拟，两个席位只收状态、发输入。
 * 不依赖 SWF / Ruffle / Chromium；关卡来自 public/shanyi-native/level-1.json。
 */
import http from 'node:http';
import {readFileSync} from 'node:fs';
import {WebSocketServer, WebSocket} from 'ws';
import {createHero, stepHero, DT} from '../adapters/shanyi-native/sim.mjs';

const TICK_MS = 1000 / 60;

export async function startShanyiNativeRoom({port = 0, levelPath, bindHost = '127.0.0.1', seats = 2} = {}) {
  if (!levelPath) throw new Error('levelPath is required');
  const level = JSON.parse(readFileSync(levelPath, 'utf8'));
  const solids = level.solids.filter(s => s.layer === 'ground');
  const boxes = level.solids.filter(s => s.layer === 'box').map(s => ({...s}));
  const originX = level.origin?.[0] ?? 0;

  const players = Array.from({length: seats}, (_, i) => ({
    seat: i,
    hero: createHero(originX + 120 + i * 40, -120),
    input: {left: false, right: false, jump: false},
    ws: null,
  }));
  let tick = 0, timer = null, closed = false;

  const server = http.createServer((req, res) => {
    const body = JSON.stringify({native: true, gameId: 'shanyi-native', tick,
      players: players.map(p => ({seat: p.seat, x: p.hero.x, y: p.hero.y, connected: !!p.ws}))});
    res.writeHead(req.url === '/health' ? 200 : 404,
      {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
    res.end(body);
  });

  const wss = new WebSocketServer({noServer: true});
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== '/ws') return socket.end('HTTP/1.1 404\r\n\r\n');
    const raw = url.searchParams.get('seat');
    const seat = raw !== null && /^\d$/.test(raw) ? Number(raw) : -1;
    if (seat < 0 || seat >= seats) return socket.end('HTTP/1.1 403\r\n\r\n');
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, seat));
  });

  const send = (ws, msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); };

  wss.on('connection', (ws, seat) => {
    const player = players[seat];
    if (player.ws) { try { player.ws.close(4001, 'replaced'); } catch {} }
    player.ws = ws;
    send(ws, {type: 'welcome', seat, level: {width: level.width, height: level.height, origin: level.origin}, seats});
    ws.on('message', buffer => {
      let msg; try { msg = JSON.parse(buffer.toString()); } catch { return send(ws, {type: 'error', code: 'BAD_JSON'}); }
      if (msg.type === 'input') {
        player.input = {left: msg.left === true, right: msg.right === true, jump: msg.jump === true};
      } else if (msg.type === 'ping') send(ws, {type: 'pong', id: msg.id});
    });
    ws.on('close', () => { if (player.ws === ws) { player.ws = null; player.input = {left: false, right: false, jump: false}; } });
    ws.on('error', () => {});
  });

  timer = setInterval(() => {
    if (closed) return;
    for (const p of players) stepHero(p.hero, solids, p.input, DT, boxes);
    tick++;
    const state = {type: 'state', tick, players: players.map(p => ({
      seat: p.seat, x: +p.hero.x.toFixed(2), y: +p.hero.y.toFixed(2),
      vx: +p.hero.vx.toFixed(2), vy: +p.hero.vy.toFixed(2),
      onGround: p.hero.onGround, jumps: p.hero.jumps}))};
    for (const p of players) send(p.ws, state);
  }, TICK_MS);
  timer.unref?.();

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, bindHost, () => { server.off('error', reject); resolve(); });
  });
  const actual = server.address().port;
  return {
    url: `http://${bindHost}:${actual}`,
    localUrl: `http://127.0.0.1:${actual}`,
    level, players, seats,
    get tick() { return tick; },
    close() {
      closed = true; clearInterval(timer);
      for (const p of players) { try { p.ws?.terminate(); } catch {} }
      return Promise.all([
        new Promise(r => wss.close(r)),
        new Promise(r => server.close(r)),
      ]);
    },
  };
}
