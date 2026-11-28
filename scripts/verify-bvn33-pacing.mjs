import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createConnection, createServer} from 'node:net';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';

const [sidecar] = process.argv.slice(2);
if (!sidecar) throw Error('Usage: node scripts/verify-bvn33-pacing.mjs <prepared BVN sidecar directory>');

const host = '127.0.0.1';
const context = {proxies: [], peers: []};

async function listen(server) {
  server.listen(0, host);
  await once(server, 'listening');
  return server.address().port;
}

async function waitFor(check, label, timeout = 6000) {
  const deadline = performance.now() + timeout;
  while (performance.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(20);
  }
  throw Error(`Timed out waiting for ${label}`);
}

// Delay whole TCP streams in both directions, including WebSocket control frames.
// The queue maintains wire order even when a later chunk has a lower delay sample.
function delayStream(source, target, delayMs, jitter) {
  let sample = 0;
  let timer;
  const queue = [];
  const schedule = () => {
    if (queue.length) timer = setTimeout(flush, Math.max(0, queue[0].due - performance.now()));
  };
  const flush = () => {
    timer = undefined;
    const now = performance.now();
    while (queue.length && queue[0].due <= now) target.write(queue.shift().chunk);
    schedule();
  };
  source.on('data', chunk => {
    const due = performance.now() + delayMs() + jitter[sample++ % jitter.length];
    queue.push({chunk, due});
    if (timer === undefined) schedule();
  });
  return () => clearTimeout(timer);
}

async function proxy(port, profile) {
  const sockets = new Set();
  const server = createServer(client => {
    const upstream = createConnection({host, port});
    sockets.add(client);
    sockets.add(upstream);
    client.setNoDelay(true);
    upstream.setNoDelay(true);
    const jitter = profile.jitter ?? [0];
    const stopUp = delayStream(client, upstream, () => profile.up, jitter);
    const stopDown = delayStream(upstream, client, () => profile.down, jitter);
    function disconnect() {
      stopUp();
      stopDown();
      for (const socket of [client, upstream]) {
        sockets.delete(socket);
        socket.destroy();
      }
    }
    for (const socket of [client, upstream]) {
      socket.once('error', disconnect);
      socket.once('close', disconnect);
    }
  });
  const delayedPort = await listen(server);
  context.proxies.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  return delayedPort;
}

async function api(port, route, body) {
  const response = await fetch(`http://${host}:${port}${route}`, {
    method: 'POST', body: JSON.stringify(body),
    headers: {'Content-Type': 'application/json'}, signal: AbortSignal.timeout(3000),
  });
  assert(response.ok, `${route} returned HTTP ${response.status}`);
  return response.json();
}

async function connect(port, profile, session, fps, acknowledge) {
  const delayedPort = await proxy(port, profile);
  const search = new URLSearchParams({room: session.code, token: session.token});
  const ws = new WebSocket(`ws://${host}:${delayedPort}/socket?${search}`);
  const peer = {ws, messages: [], frames: [], rtts: []};
  context.peers.push(peer);
  peer.send = message => ws.send(JSON.stringify({generation: peer.generation, ...message}));
  ws.on('message', (raw, binary) => {
    if (binary) return;
    const message = JSON.parse(raw);
    if (message.type === 'reset') peer.generation = message.generation;
    if (message.type === 'transport-rtt') peer.rtts.push(message.ms);
    if (message.type === 'frame') {
      peer.frames.push({message, time: performance.now()});
      if (acknowledge) peer.send({type: 'ack', epoch: message.epoch, n: message.n, fps});
    } else {
      peer.messages.push(message);
    }
  });
  ws.on('error', error => { peer.error = error.code ?? 'socket error'; });
  await once(ws, 'open', {signal: AbortSignal.timeout(6000)});
  await waitFor(() => Number.isInteger(peer.generation), 'seat reset');
  return peer;
}

async function begin(port, profiles, fps, freezeSecond = false) {
  const hostSeat = await api(port, '/api/create', {});
  const guestSeat = await api(port, '/api/join', {code: hostSeat.code});
  const peers = await Promise.all([hostSeat, guestSeat].map((session, seat) =>
    connect(port, profiles[seat], session, fps, !freezeSecond || seat === 0)));
  for (const peer of peers) peer.send({type: 'ready', barrier: 1});
  const resumes = await Promise.all(peers.map(peer => waitFor(
    () => peer.messages.find(message => message.type === 'resume'), 'initial resume')));
  assert(resumes.every(resume => resume.epoch === 1));
  for (const peer of peers) peer.send({type: 'resumed', epoch: 1, state: {fps}});
  return peers;
}

function checkTimeline(peers) {
  const [first, second] = peers.map(peer => peer.frames.map(frame => frame.message));
  for (const [seat, timeline] of [first, second].entries()) {
    assert(!peers[seat].error, `Seat ${seat + 1} had a socket error`);
    assert.equal(peers[seat].ws.readyState, WebSocket.OPEN, `Seat ${seat + 1} disconnected`);
    assert(timeline.length > 0, `Seat ${seat + 1} received no frames`);
    assert(timeline.every(({epoch, n}, index) => epoch === 1 && n === index + 1),
      `Seat ${seat + 1} received skipped, repeated, or out-of-order frames`);
  }
  const common = Math.min(first.length, second.length);
  assert.deepEqual(first.slice(0, common), second.slice(0, common), 'Seat frame and input streams differ');
  return first.slice(0, common);
}

function measure(peer, start, end) {
  const times = peer.frames.filter(({time}) => time >= start && time < end).map(({time}) => time);
  const gaps = times.slice(1).map((time, index) => time - times[index]).sort((a, b) => a - b);
  return {
    fps: Number((times.length * 1000 / (end - start)).toFixed(1)),
    p95GapMs: Math.round(gaps[Math.floor(gaps.length * 0.95)] ?? 0),
    maxGapMs: Math.round(gaps.at(-1) ?? 0),
    maxRttMs: Math.round(Math.max(0, ...peer.rtts)),
  };
}

async function checkRate(port, profiles, fps, duration) {
  const peers = await begin(port, profiles, fps);
  try {
    await waitFor(() => peers.every(peer => peer.frames.length >= 1), 'first active frame');
    const start = performance.now() + 700;
    const end = start + duration;
    for (const [first, second] of [[16, 8], [32, 4], [0, 0]]) {
      peers[0].send({type: 'input', mask: first});
      peers[1].send({type: 'input', mask: second});
      await delay(650);
    }
    await delay(Math.max(0, end - performance.now()));
    const timeline = checkTimeline(peers);
    let match = 0;
    const masks = [[16, 8], [32, 4], [0, 0]];
    for (const {keys} of timeline) {
      if (masks[match] && keys[0] === masks[match][0] && keys[1] === masks[match][1]) match++;
    }
    assert.equal(match, masks.length, 'Both peers must see press, input changes, and release on the same frames');
    return peers.map(peer => measure(peer, start, end));
  } finally {
    for (const peer of peers) peer.ws.close();
  }
}

async function checkFrozen(port) {
  const profiles = [{up: 5, down: 5}, {up: 5, down: 5}];
  const peers = await begin(port, profiles, 60, true);
  try {
    await waitFor(() => peers.every(peer => peer.frames.length >= 8), 'initial bounded window');
    await delay(220);
    const frozenAt = peers[1].frames.length;
    profiles[1].up = profiles[1].down = 200;
    await delay(2400);
    const timeline = checkTimeline(peers);
    assert(frozenAt <= 48, 'The stalled peer must cap unacknowledged frames');
    assert.equal(timeline.length, frozenAt, 'Transport probes alone must not grow a stalled peer’s window');
    return {frames: frozenAt, maxProbeRttMs: Math.round(Math.max(0, ...peers[1].rtts))};
  } finally {
    for (const peer of peers) peer.ws.close();
  }
}

let child;
try {
  const portProbe = createServer();
  const port = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  child = spawn(process.execPath, ['net-server.mjs'], {
    cwd: path.resolve(sidecar), env: {...process.env, HOST: host, PORT: String(port)},
    stdio: 'ignore', windowsHide: true,
  });
  let startupError;
  child.on('error', error => { startupError = error.code; });
  await waitFor(async () => {
    if (startupError || child.exitCode !== null) throw Error(`Isolated sidecar could not start (${startupError ?? child.exitCode})`);
    return fetch(`http://${host}:${port}/health`, {signal: AbortSignal.timeout(350)})
      .then(response => response.ok).catch(() => false);
  }, 'sidecar health');

  const low = [{up: 5, down: 5}, {up: 5, down: 5}];
  const high = [{up: 15, down: 25}, {up: 215, down: 185, jitter: [0, 17, 0, 8, 23, 0, 5]}];
  const result = {
    lowRtt60: await checkRate(port, low, 60, 2100),
    highRtt60: await checkRate(port, high, 60, 4000),
    highRtt30: await checkRate(port, high, 30, 2100),
    frozen: await checkFrozen(port),
  };
  console.log(JSON.stringify(result, null, 2));
  assert(result.lowRtt60.every(seat => seat.fps >= 52), 'The 10 ms RTT baseline must sustain at least 52 fps');
  assert(result.highRtt60.every(seat => seat.fps >= 52), 'The 400 ms RTT battle must sustain at least 52 fps on each seat');
  assert(result.highRtt60[1].maxRttMs >= 320, 'Native WS probes must measure the high RTT during battle');
  assert(result.highRtt60.every(seat => seat.p95GapMs <= 100), 'High RTT must not introduce recurring long pauses');
  assert(result.highRtt30.every(seat => seat.fps >= 26 && seat.fps <= 34),
    'The 30 fps battle must sustain its own pacing under 400 ms RTT');
  assert(result.frozen.maxProbeRttMs >= 320, 'Native WS probes must measure the delayed frozen connection');
} finally {
  for (const peer of context.peers) peer.ws.terminate();
  await Promise.all(context.proxies.map(close => close()));
  child?.kill();
}
