import {randomInt} from 'node:crypto';
import {WebSocket} from 'ws';
import {
  FRAME_RATE, MAX_FRAME_LEAD, MAX_INPUT_MASK, MIN_LOCKSTEP_PLAYERS,
  isCheckpoint, isFrameRate, isLockstepPlayerCount, isStateHash, isWinner,
} from '../public/lockstep/protocol.mjs';

const SETUP_TIMEOUT_MS = 90_000;
const FRAME_TIMEOUT_MS = 8_000;
const RECONNECT_TIMEOUT_MS = 20_000;
const CATCH_UP_TIMEOUT_MS = 60_000;
const REMATCH_TIMEOUT_MS = 120_000;
const REPLAY_WINDOW = 32;
const REPLAY_FRAMES = 12_000;
const MAX_BUFFERED_BYTES = 64 * 1024;

export function createLockstepMatch({
  levelId, onEnd, tickRate = FRAME_RATE, playerCount = MIN_LOCKSTEP_PLAYERS, playerNames = [], playerOutfits, bombItSettings,
}) {
  if (!isFrameRate(tickRate)) throw new RangeError('Invalid lockstep tick rate');
  if (!isLockstepPlayerCount(playerCount)) throw new RangeError('Invalid lockstep player count');
  const tickInterval = 1000 / tickRate;
  let seed = randomInt(0x1_0000_0000);
  const players = new Array(playerCount).fill(null);
  const names = Array.from({length: playerCount}, (_, seat) =>
    typeof playerNames?.[seat] === 'string' ? playerNames[seat] : null);
  const outfits = playerOutfits?.map(outfit => ({...outfit}));
  const settings = bombItSettings && {...bombItSettings};
  const reports = new Map();
  const checkpoints = new Map();
  const rematchVotes = new Set();
  const historyStride = 2 * playerCount;
  const history = new Uint16Array(REPLAY_FRAMES * historyStride);
  let phase = 'loading';
  let pause;
  let frame = 0;
  let lastProgress = 0;
  let confirmed = 0;
  let finishFrame = null;
  let result;
  let ticker;
  let nextTickAt;
  let setupTimer;
  let rematchTimer;
  scheduleSetupDeadline();

  function send(player, message) {
    if (player?.ws?.readyState === WebSocket.OPEN) player.ws.send(JSON.stringify(message));
  }

  function broadcast(message) {
    for (const player of players) send(player, message);
  }

  function end(reason, winner) {
    if (phase === 'ended') return;
    phase = 'ended';
    clearTimeout(setupTimer);
    clearTimeout(ticker);
    clearTimeout(pause?.timer);
    clearTimeout(rematchTimer);
    broadcast({type: 'ended', reason, winner, frame: confirmed,
      ...(reason === 'MATCH_COMPLETED' ? {canRematch: false} : {})});
    onEnd(reason);
  }

  function scheduleSetupDeadline() {
    setupTimer = setTimeout(() => end('MATCH_SETUP_TIMEOUT'), SETUP_TIMEOUT_MS);
    setupTimer.unref();
  }

  function completeRound(winner) {
    phase = 'completed';
    clearTimeout(ticker);
    result = {type: 'ended', reason: 'MATCH_COMPLETED', winner, frame: confirmed, canRematch: true,
      expiresAt: Date.now() + REMATCH_TIMEOUT_MS};
    broadcast(result);
    rematchTimer = setTimeout(() => end('MATCH_COMPLETED', winner), REMATCH_TIMEOUT_MS);
    rematchTimer.unref();
  }

  function voteStatus() {
    return {type: 'rematch-votes', votes: rematchVotes.size, needed: playerCount, votedSeats: [...rematchVotes]};
  }

  function voteRematch(player) {
    if (phase !== 'completed' || rematchVotes.has(player.seat)) return;
    rematchVotes.add(player.seat);
    broadcast(voteStatus());
    if (!players.every(seat => seat.ws && rematchVotes.has(seat.seat))) return;
    clearTimeout(rematchTimer);
    rematchVotes.clear();
    reports.clear();
    checkpoints.clear();
    phase = 'loading';
    const previousSeed = seed;
    while (seed === previousSeed) seed = randomInt(0x1_0000_0000);
    frame = 0;
    confirmed = 0;
    finishFrame = null;
    result = null;
    for (const seat of players) {
      seat.hash = null;
      seat.held = 0;
      seat.pressed = 0;
      seat.ack = 0;
    }
    scheduleSetupDeadline();
    for (const seat of players) welcome(seat, {nextRound: true});
  }

  function tick() {
    if (frame > confirmed && performance.now() - lastProgress > FRAME_TIMEOUT_MS) {
      for (const player of players) {
        if (player.ack !== confirmed) continue;
        const ws = player.ws;
        disconnected(player, ws);
        ws.terminate();
      }
      return;
    }
    if (finishFrame !== null || frame - confirmed >= MAX_FRAME_LEAD) return;
    if (players.some(player => player.ws.bufferedAmount > MAX_BUFFERED_BYTES)) return;
    frame++;
    reports.set(frame, new Array(playerCount).fill(null));
    const masks = players.map(player => player.held);
    const pressed = players.map(player => player.pressed);
    const offset = historyOffset(frame);
    history.set(masks, offset);
    history.set(pressed, offset + playerCount);
    checkpoints.delete(frame - REPLAY_FRAMES);
    for (const player of players) player.pressed = 0;
    broadcast({type: 'frame', frame, masks, pressed});
  }

  function scheduleTick() {
    if (phase !== 'playing' || pause) return;
    const delay = Math.max(1, Math.ceil(nextTickAt - performance.now()));
    ticker = setTimeout(() => {
      tick();
      // Correct timer rounding without dispatching a burst after a long stall.
      const now = performance.now();
      nextTickAt += tickInterval;
      if (nextTickAt <= now) nextTickAt = now + tickInterval;
      scheduleTick();
    }, delay);
    ticker.unref();
  }

  function beginTicks() {
    lastProgress = performance.now();
    nextTickAt = lastProgress + tickInterval;
    scheduleTick();
  }

  function startIfReady() {
    if (phase !== 'loading' || pause || !players.every(player => player?.hash && player.ws)) return;
    if (!players.every(player => player.hash === players[0].hash)) return end('MATCH_DESYNC');
    clearTimeout(setupTimer);
    phase = 'playing';
    broadcast({type: 'start'});
    beginTicks();
  }

  function ready(player, hash) {
    if (phase !== 'loading' || player.hash !== null || player.recovery || !isStateHash(hash))
      return end('MATCH_PROTOCOL_ERROR');
    player.hash = hash;
    maybeResume();
    startIfReady();
  }

  function historyOffset(number) {
    return ((number - 1) % REPLAY_FRAMES) * historyStride;
  }

  function pauseNotice() {
    return {type: 'paused', seat: pause.seat, frame: targetFrame(), expiresAt: pause.expiresAt};
  }

  function setPauseDeadline(ms) {
    clearTimeout(pause.timer);
    pause.expiresAt = Date.now() + ms;
    pause.timer = setTimeout(() => {
      const winner = checkpoints.get(finishFrame)?.winner;
      if (winner !== undefined) end('MATCH_COMPLETED', winner);
      else end('MATCH_RECONNECT_TIMEOUT');
    }, ms);
    pause.timer.unref();
  }

  function disconnected(player, ws) {
    if (phase === 'ended' || player.ws !== ws) return;
    player.ws = null;
    player.recovery = null;
    if (phase === 'completed') {
      if (rematchVotes.delete(player.seat)) broadcast(voteStatus());
      return;
    }
    if (!pause) {
      clearTimeout(ticker);
      pause = {seat: player.seat, extended: false};
      setPauseDeadline(RECONNECT_TIMEOUT_MS);
      for (const seated of players) {
        if (!seated) continue;
        seated.held = 0;
        seated.pressed = 0;
      }
    }
    pause.seat = player.seat;
    broadcast(pauseNotice());
  }

  function extendPauseIfConnected() {
    if (!pause || pause.extended || players.some(player => player && !player.ws)) return false;
    pause.extended = true;
    setPauseDeadline(CATCH_UP_TIMEOUT_MS);
    return true;
  }

  function targetFrame() {
    return finishFrame ?? frame;
  }

  function maybeResume() {
    if (!pause || phase === 'ended' || players.some(player => player && (!player.ws || player.recovery))) return;
    if (phase === 'playing' && confirmed < targetFrame()) return;
    clearTimeout(pause.timer);
    pause = null;
    if (phase === 'loading') return startIfReady();
    const winner = checkpoints.get(finishFrame)?.winner;
    if (winner !== undefined) return completeRound(winner);
    broadcast({type: 'resumed', frame});
    beginTicks();
  }

  function fillReplayWindow(player) {
    const replay = player.recovery;
    const target = targetFrame();
    if (replay.ack >= target) {
      player.recovery = null;
      maybeResume();
      return;
    }
    const endFrame = Math.min(target, replay.ack + REPLAY_WINDOW);
    while (replay.sent < endFrame && player.ws.bufferedAmount < MAX_BUFFERED_BYTES) {
      const number = ++replay.sent;
      const offset = historyOffset(number);
      send(player, {type: 'frame', frame: number,
        masks: Array.from(history.subarray(offset, offset + playerCount)),
        pressed: Array.from(history.subarray(offset + playerCount, offset + historyStride))});
    }
  }

  function resume(player, message) {
    const {frame: applied, hash} = message;
    if (!pause || !player.recovery || player.recovery.ack !== null ||
        !Number.isSafeInteger(applied) || applied < 0 || applied > frame ||
        (applied > 0 && applied < player.ack) || (applied === 0 && !isStateHash(hash)) ||
        (hash !== undefined && !isStateHash(hash))) return end('MATCH_PROTOCOL_ERROR');
    if (hash !== undefined && player.hash !== null && hash !== player.hash) return end('MATCH_DESYNC');
    player.hash ??= hash;
    const from = Math.min(applied, player.ack);
    if (from < frame - REPLAY_FRAMES) return end('MATCH_REPLAY_UNAVAILABLE');
    player.recovery = {ack: from, sent: from};
    fillReplayWindow(player);
  }

  function acknowledge(player, message) {
    const {frame: received, hash, winner} = message;
    const isFinal = winner !== undefined;
    const replay = player.recovery;
    const expected = (replay ? replay.ack : player.ack) + 1;
    if (phase !== 'playing' || !Number.isSafeInteger(received) ||
        received !== expected || received > frame || (replay && (replay.ack === null || received > replay.sent)) ||
        (isFinal && !isWinner(winner, playerCount)) ||
        ((isCheckpoint(received) || isFinal) ? !isStateHash(hash) : hash !== undefined))
      return end('MATCH_PROTOCOL_ERROR');
    if (received <= player.ack) {
      const prior = received <= confirmed ? checkpoints.get(received) : reports.get(received)?.[player.seat];
      if (prior?.hash !== hash || prior?.winner !== winner) return end('MATCH_DESYNC');
    } else {
      if (received !== player.ack + 1) return end('MATCH_PROTOCOL_ERROR');
      recordAcknowledgement(player, received, hash, winner);
    }
    if (phase === 'ended') return;
    if (replay) {
      replay.ack = received;
      fillReplayWindow(player);
    }
    maybeResume();
  }

  function recordAcknowledgement(player, received, hash, winner) {
    const frameReports = reports.get(received);
    player.ack = received;
    frameReports[player.seat] = {hash, winner};
    if (winner !== undefined) finishFrame = Math.min(finishFrame ?? received, received);
    if (frameReports.includes(null)) return;
    if (!frameReports.every(report => report.hash === hash && report.winner === winner))
      return end('MATCH_DESYNC');
    confirmed = received;
    lastProgress = performance.now();
    reports.delete(received);
    if (hash !== undefined) checkpoints.set(received, {hash, winner});
    if (winner !== undefined && !pause) completeRound(winner);
  }

  function receive(player, raw, binary) {
    if (phase === 'ended') return;
    let message;
    try { message = binary ? null : JSON.parse(raw.toString()); }
    catch { return end('MATCH_PROTOCOL_ERROR'); }
    if (!message || typeof message !== 'object' || Array.isArray(message))
      return end('MATCH_PROTOCOL_ERROR');
    switch (message.type) {
      case 'ready': return ready(player, message.hash);
      case 'resume': return resume(player, message);
      case 'ack': return phase === 'completed' ? undefined : acknowledge(player, message);
      case 'rematch': return voteRematch(player);
      case 'input': {
        const {mask} = message;
        if (!Number.isInteger(mask) || mask < 0 || mask > MAX_INPUT_MASK)
          return end('MATCH_PROTOCOL_ERROR');
        if (phase !== 'playing' || pause) return;
        player.pressed |= mask & ~player.held;
        player.held = mask;
        return;
      }
      case 'leave': return end('MATCH_ABORTED');
      case 'error': return end('MATCH_CLIENT_ERROR');
      default: return end('MATCH_PROTOCOL_ERROR');
    }
  }

  function canAttach(seat) {
    if (phase === 'ended' || !Number.isInteger(seat) || seat < 0 || seat >= playerCount) return false;
    const player = players[seat];
    return player ? player.ws === null : phase === 'loading';
  }

  function welcome(player, extra) {
    send(player, {type: 'welcome', seat: player.seat, levelId, seed, tickRate, playerCount, playerNames: names,
      ...(outfits ? {playerOutfits: outfits} : {}), ...(settings ? {bombItSettings: settings} : {}), ...extra});
  }

  return {
    canAttach,
    attach(ws, seat) {
      if (!canAttach(seat)) return ws.close(1008, 'Seat unavailable');
      const reconnecting = players[seat] !== null;
      const player = players[seat] ??= {seat, hash: null, held: 0, pressed: 0, ack: 0};
      player.ws = ws;
      player.recovery = reconnecting && phase !== 'completed' ? {ack: null} : null;
      ws.on('error', () => {
        disconnected(player, ws);
        ws.terminate();
      });
      ws.on('close', () => disconnected(player, ws));
      ws.on('message', (raw, binary) => {
        if (player.ws === ws) receive(player, raw, binary);
      });
      if (phase === 'completed') {
        send(player, result);
        send(player, voteStatus());
        return;
      }
      const extended = extendPauseIfConnected();
      welcome(player, reconnecting ? {reconnecting, started: phase === 'playing', frame: targetFrame(), expiresAt: pause.expiresAt} : {});
      if (extended) for (const teammate of players) if (teammate !== player) send(teammate, pauseNotice());
    },
    async close() {
      end('SESSION_ENDED');
      for (const player of players) player?.ws?.close(1000);
    },
  };
}
