import {performance} from 'node:perf_hooks';

const peers = new WeakMap();
const PROBE_INTERVAL = 1_000;
const PROBE_EXPIRY = 2_500;
const MIN_WINDOW = 8;
const MAX_WINDOW = 48;

export function attachFramePeer(socket, report) {
  const peer = {probe: null, probeAt: -Infinity, rtt: null, average: null,
    generation: -1, epoch: -1, ack: -1, window: MIN_WINDOW};
  peers.set(socket, peer);
  socket.on('pong', bytes => {
    if (!peer.probe || !peer.probe.equals(bytes)) return;
    const sample = Math.max(0, performance.now() - peer.probeAt);
    peer.probe = null;
    peer.rtt = sample;
    peer.average = peer.average === null ? sample : .8 * peer.average + .2 * sample;
    report(Math.round(sample));
  });
  probeFramePeer(socket, performance.now());
}

export function probeFramePeer(socket, now) {
  const peer = peers.get(socket);
  if (!peer || socket.readyState !== 1 || now - peer.probeAt < PROBE_INTERVAL ||
      (peer.probe && now - peer.probeAt < PROBE_EXPIRY)) return;
  peer.probeAt = now;
  peer.probe = Buffer.allocUnsafe(8);
  peer.probe.writeDoubleBE(now);
  socket.ping(peer.probe);
}

export function frameWindowBlocked(room) {
  for (const [slot, socket] of room.sockets) {
    const peer = peers.get(socket);
    const ack = room.acks[slot - 1];
    if (!peer) {
      if (room.n - ack >= MIN_WINDOW) return true;
      continue;
    }
    // An ACK must free credit before a larger RTT estimate can expand it.
    if (peer.generation !== room.generation || peer.epoch !== room.epoch || peer.ack !== ack) {
      peer.generation = room.generation;
      peer.epoch = room.epoch;
      peer.ack = ack;
      const budget = Math.max(peer.rtt ?? 0, peer.average ?? 0) + 55;
      peer.window = Math.max(MIN_WINDOW, Math.min(MAX_WINDOW, Math.ceil(budget * room.fps / 1000) + 1));
    }
    if (room.n - ack >= peer.window) return true;
  }
  return false;
}
