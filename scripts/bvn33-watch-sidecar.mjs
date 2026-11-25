import {randomBytes} from 'node:crypto';

const OPEN = 1;
const WATCH_LIMIT = 16;
const TICKET_LIFETIME = 60_000;
const FRAME_TIMEOUT = 18_000;
const FRAME_LIMIT = 32 * 1024;

function playersOnline(room) {
  return room.sockets.get(1)?.readyState === OPEN && room.sockets.get(2)?.readyState === OPEN;
}

export function watchable(room) {
  return Boolean(room && room.state === 'running' && room.liveCombat && !room.bot &&
    playersOnline(room));
}

export function setCombatCheckpoint(room, state) {
  room.liveCombat = state?.active === true && typeof state.stage === 'string' && state.stage.endsWith('::GameState');
  if (!room.liveCombat && room.watchProfiles.size) endWatchers(room, 'unavailable');
}

function parseReturnUrl(value) {
  let target;
  try { target = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(target.protocol) || target.pathname !== '/' ||
      target.username || target.password || target.hash || target.href.length > 1024) return null;
  return target.href;
}

function clearExpiredTickets(room, now) {
  for (const [token, entry] of room.watchProfiles) {
    if (!entry.ws && entry.expires <= now) room.watchProfiles.delete(token);
  }
}

export function issueWatchTicket(room, profile, rawReturnUrl, now = Date.now()) {
  if (!watchable(room)) return {status: 409, error: '两名玩家进入战斗后才能观战'};
  const returnUrl = parseReturnUrl(rawReturnUrl);
  if (!returnUrl) return {status: 400, error: '观战返回地址无效'};
  clearExpiredTickets(room, now);
  if (room.watchProfiles.size >= WATCH_LIMIT) return {status: 409, error: '观战人数已满'};
  const token = randomBytes(24).toString('base64url');
  room.watchProfiles.set(token, {profile, returnUrl, expires: now + TICKET_LIFETIME, ws: null});
  return {status: 200, code: room.code, token, role: 'watch'};
}

export function admitWatchSocket(room, token, now = Date.now()) {
  if (!watchable(room)) return null;
  const entry = room.watchProfiles.get(token);
  return entry && !entry.ws && entry.expires > now ? {token, entry} : null;
}

function endWatcher(room, ws, reason) {
  const watcher = room.watchers.get(ws);
  if (!watcher) return;
  room.watchers.delete(ws);
  room.watchProfiles.delete(watcher.token);
  if (ws.readyState === OPEN) ws.send(JSON.stringify({type: 'ended', reason}));
  ws.close(1000);
}

export function endWatchers(room, reason) {
  for (const ws of room.watchers.keys()) endWatcher(room, ws, reason);
  room.watchProfiles.clear();
  syncCapture(room);
}

export function sweepWatchers(room, now = Date.now()) {
  if (room.watchProfiles.size && !playersOnline(room)) {
    endWatchers(room, 'disconnected');
    return;
  }
  if (room.watchProfiles.size && !watchable(room)) {
    endWatchers(room, 'unavailable');
    return;
  }
  clearExpiredTickets(room, now);
  if (room.watchers.size && now - room.watchFrameAt >= FRAME_TIMEOUT)
    endWatchers(room, 'unavailable');
}

function syncCapture(room) {
  const active = room.watchers.size > 0 && watchable(room);
  if (Boolean(room.watchCapture) === active) return;
  room.watchCapture = active;
  if (active) room.watchFrameAt = Date.now();
  const source = room.sockets.get(1);
  if (source?.readyState === OPEN) source.send(JSON.stringify({type: 'watch-capture', active, generation: room.generation}));
}

export function relayWatchFrame(room, ws, bytes, now = Date.now()) {
  if (!room.watchCapture || !watchable(room) || room.sockets.get(1) !== ws || !Buffer.isBuffer(bytes) ||
      bytes.length < 20 || bytes.length > FRAME_LIMIT || bytes.toString('ascii', 0, 4) !== 'RIFF' ||
      bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8 ||
      now - room.watchFrameAt < 80) return;
  room.watchFrameAt = now;
  for (const viewer of room.watchers.keys()) {
    if (viewer.readyState === OPEN && viewer.bufferedAmount < FRAME_LIMIT * 2) viewer.send(bytes, {binary: true});
  }
}

export function attachWatchSocket(room, ws, seat, {send, update, status}) {
  const {token, entry} = seat;
  if (!admitWatchSocket(room, token)) { ws.close(1008); return; }
  const watcher = {token, profile: entry.profile, mode: 'live', live: true};
  entry.ws = ws;
  room.watchers.set(ws, watcher);
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('close', () => {
    if (!room.watchers.delete(ws)) return;
    room.watchProfiles.delete(token);
    syncCapture(room);
    update();
  });
  ws.on('error', () => {});
  send(ws, {type: 'watch-session', returnUrl: entry.returnUrl});
  send(ws, status());
  update();
  syncCapture(room);
  let rateStart = Date.now(), count = 0;
  ws.on('message', (bytes, binary) => {
    if (binary || room.watchers.get(ws) !== watcher) return;
    const now = Date.now();
    if (now - rateStart > 1000) { rateStart = now; count = 0; }
    if (++count > 20) { endWatcher(room, ws, 'disconnected'); syncCapture(room); update(); return; }
    let message;
    try { message = JSON.parse(bytes); } catch { return; }
    if (message?.type === 'ping') send(ws, {type: 'pong'});
  });
}
