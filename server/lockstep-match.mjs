import {randomInt} from 'node:crypto';
import {WebSocket} from 'ws';
import {
  FRAME_RATE, MAX_FRAME_LEAD, MAX_INPUT_MASK, isCheckpoint, isStateHash, isWinner,
} from '../public/lockstep/protocol.mjs';

const SETUP_TIMEOUT_MS = 90_000;
const FRAME_TIMEOUT_MS = 8_000;
const MAX_BUFFERED_BYTES = 64 * 1024;

export function createLockstepMatch({levelId, onEnd}) {
  const seed = randomInt(0x1_0000_0000);
  const players = [null, null];
  const reports = new Map();
  let phase = 'loading';
  let frame = 0;
  let lastProgress = 0;
  let confirmed = 0;
  let finishFrame = null;
  let ticker;
  const setupTimer = setTimeout(() => end('MATCH_SETUP_TIMEOUT'), SETUP_TIMEOUT_MS);
  setupTimer.unref();

  function send(player, message) {
    if (player?.ws.readyState === WebSocket.OPEN) player.ws.send(JSON.stringify(message));
  }

  function broadcast(message) {
    for (const player of players) send(player, message);
  }

  function end(reason, winner) {
    if (phase === 'ended') return;
    phase = 'ended';
    clearTimeout(setupTimer);
    clearInterval(ticker);
    broadcast({type: 'ended', reason, winner, frame: confirmed});
    onEnd(reason);
  }

  function tick() {
    if (performance.now() - lastProgress > FRAME_TIMEOUT_MS)
      return end('MATCH_TIMEOUT');
    if (finishFrame !== null || frame - confirmed >= MAX_FRAME_LEAD) return;
    if (players.some(player => player.ws.bufferedAmount > MAX_BUFFERED_BYTES)) return;
    frame++;
    reports.set(frame, new Array(2).fill(null));
    const masks = players.map(player => player.held);
    const pressed = players.map(player => player.pressed);
    for (const player of players) player.pressed = 0;
    broadcast({type: 'frame', frame, masks, pressed});
  }

  function ready(player, hash) {
    if (phase !== 'loading' || player.hash !== null || !isStateHash(hash))
      return end('MATCH_PROTOCOL_ERROR');
    player.hash = hash;
    if (!players.every(seat => seat?.hash)) return;
    if (players[0].hash !== players[1].hash) return end('MATCH_DESYNC');
    clearTimeout(setupTimer);
    phase = 'playing';
    lastProgress = performance.now();
    broadcast({type: 'start'});
    ticker = setInterval(tick, 1000 / FRAME_RATE);
    ticker.unref();
  }

  function acknowledge(player, message) {
    const {frame: received, hash, winner} = message;
    const isFinal = winner !== undefined;
    if (phase !== 'playing' || !Number.isSafeInteger(received) ||
        received !== player.ack + 1 || received > frame ||
        (isFinal && !isWinner(winner)) ||
        ((isCheckpoint(received) || isFinal) ? !isStateHash(hash) : hash !== undefined))
      return end('MATCH_PROTOCOL_ERROR');
    const pair = reports.get(received);
    player.ack = received;
    pair[player.seat] = {hash, winner};
    if (isFinal) finishFrame = Math.min(finishFrame ?? received, received);
    if (pair.includes(null)) return;
    const [first, second] = pair;
    if (first.hash !== second.hash || first.winner !== second.winner)
      return end('MATCH_DESYNC');
    confirmed = received;
    lastProgress = performance.now();
    reports.delete(received);
    if (isFinal) end('MATCH_COMPLETED', winner);
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
      case 'ack': return acknowledge(player, message);
      case 'input': {
        const {mask} = message;
        if (phase !== 'playing' || !Number.isInteger(mask) || mask < 0 || mask > MAX_INPUT_MASK)
          return end('MATCH_PROTOCOL_ERROR');
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
    return phase === 'loading' && players[seat] === null;
  }

  return {
    canAttach,
    attach(ws, seat) {
      if (!canAttach(seat)) return ws.close(1008, 'Seat unavailable');
      const player = {ws, seat, hash: null, held: 0, pressed: 0, ack: 0};
      players[seat] = player;
      ws.on('error', () => end('MATCH_DISCONNECTED'));
      ws.on('close', () => end('MATCH_DISCONNECTED'));
      ws.on('message', (raw, binary) => receive(player, raw, binary));
      send(player, {type: 'welcome', seat, levelId, seed, tickRate: FRAME_RATE});
    },
    async close() {
      end('SESSION_ENDED');
      for (const player of players) player?.ws.close(1000);
    },
  };
}
