import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {fileURLToPath} from 'node:url';
import {startShanyiNativeRoom} from '../server/shanyi-native-room.mjs';

const levelPath = fileURLToPath(new URL('../public/shanyi-native/level-1.json', import.meta.url));

function open(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.messages = [];
    ws.on('message', d => { try { ws.messages.push(JSON.parse(d.toString())); } catch {} });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
const waitFor = (ws, type, ms = 4000) => new Promise((resolve, reject) => {
  const end = Date.now() + ms;
  const tick = () => {
    const index = ws.messages.findIndex(m => m.type === type);
    if (index >= 0) return resolve(ws.messages.splice(index, 1)[0]);
    if (Date.now() > end) return reject(Error('timeout ' + type));
    setTimeout(tick, 20);
  };
  tick();
});

test('原生房：两席位入场、模拟推进、输入生效', async t => {
  const room = await startShanyiNativeRoom({levelPath, port: 0});
  t.after(() => room.close());
  const a = await open(room.url.replace(/^http/, 'ws') + '/ws?seat=0');
  const b = await open(room.url.replace(/^http/, 'ws') + '/ws?seat=1');
  t.after(() => { a.close(); b.close(); });

  const welcome = await waitFor(a, 'welcome');
  assert.equal(welcome.seat, 0);
  assert.equal(welcome.seats, 2);

  const first = await waitFor(a, 'state');
  const tick0 = first.tick;
  await new Promise(r => setTimeout(r, 800));
  const latest = ws => ws.messages.filter(m => m.type === 'state').at(-1);
  const later = latest(a);
  assert.ok(later.tick > tick0 + 5, '服务端应持续推进 tick');
  assert.ok(later.players[0].onGround, '入场后应落在地面上');

  const startX = later.players[0].x;
  a.send(JSON.stringify({type: 'input', left: false, right: true, jump: false}));
  await new Promise(r => setTimeout(r, 600));
  const moved = latest(a);
  assert.ok(moved.players[0].x > startX + 40, `P1 应右移，实际 ${moved.players[0].x} vs ${startX}`);
});

test('原生房：/health 报告席位与 tick', async t => {
  const room = await startShanyiNativeRoom({levelPath, port: 0});
  t.after(() => room.close());
  const health = await fetch(room.url + '/health').then(r => r.json());
  assert.equal(health.native, true);
  assert.equal(health.gameId, 'shanyi-native');
  assert.equal(health.players.length, 2);
});
