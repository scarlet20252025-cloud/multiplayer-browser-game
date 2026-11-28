import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import test from 'node:test';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {createLockstepMatch} from '../server/lockstep-match.mjs';
import {MAX_FRAME_LEAD} from '../public/lockstep/protocol.mjs';

class Peer extends EventEmitter {
  readyState = WebSocket.OPEN;
  bufferedAmount = 0;
  frames = [];
  messages = [];

  send(raw) {
    const message = JSON.parse(raw);
    if (message.type === 'frame') this.frames.push(message);
    else this.messages.push(message);
  }

  message(type, fields) {
    this.emit('message', Buffer.from(JSON.stringify({type, ...fields})), false);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }

  terminate() { this.close(); }
}

async function waitForFrames(peer, count) {
  const deadline = performance.now() + 2000;
  while (peer.frames.length < count && performance.now() < deadline) await delay(10);
  assert(peer.frames.length >= count, 'Timed out waiting for input frames');
}

test('lockstep caps in-flight frames until the slower seat acknowledges', async t => {
  const match = createLockstepMatch({levelId: 0, onEnd: () => {}});
  t.after(() => match.close());
  const first = new Peer();
  const second = new Peer();
  match.attach(first, 0);
  match.attach(second, 1);
  for (const peer of [first, second]) peer.message('ready', {hash: '00000000'});

  await waitForFrames(first, MAX_FRAME_LEAD);
  first.message('ack', {frame: 1, hash: '00000001'});
  await delay(100);
  assert.equal(first.frames.length, MAX_FRAME_LEAD);
  assert.deepEqual(first.frames, second.frames);

  second.message('ack', {frame: 1, hash: '00000001'});
  await waitForFrames(first, MAX_FRAME_LEAD + 1);
  assert.equal(first.frames.at(-1).frame, MAX_FRAME_LEAD + 1);
  assert.deepEqual(first.frames, second.frames);
});

test('four lockstep seats agree on inputs and all confirm player four winning', async t => {
  const results = [];
  const match = createLockstepMatch({levelId: 0, playerCount: 4, playerNames: ['Ada', 'Ben', 'Cam', 'Dee'],
    onEnd: reason => results.push(reason)});
  t.after(() => match.close());
  const peers = Array.from({length: 4}, () => new Peer());
  for (const [seat, peer] of peers.entries()) {
    assert.equal(match.canAttach(seat), true);
    match.attach(peer, seat);
    assert.equal(match.canAttach(seat), false);
    assert.equal(peer.messages[0].seat, seat);
    assert.equal(peer.messages[0].playerCount, 4);
    assert.deepEqual(peer.messages[0].playerNames, ['Ada', 'Ben', 'Cam', 'Dee']);
  }
  assert.equal(match.canAttach(4), false);
  for (const peer of peers.slice(0, 3)) peer.message('ready', {hash: '00000000'});
  assert.equal(peers[0].messages.some(message => message.type === 'start'), false);
  peers[3].message('ready', {hash: '00000000'});
  peers[3].message('input', {mask: 16});
  await waitForFrames(peers[0], 1);
  for (const peer of peers) {
    assert.deepEqual(peer.frames[0].masks, [0, 0, 0, 16]);
    assert.deepEqual(peer.frames[0].pressed, [0, 0, 0, 16]);
  }
  for (const peer of peers.slice(0, 3)) peer.message('ack', {frame: 1, hash: '00000001', winner: 3});
  assert.deepEqual(results, []);
  peers[3].message('ack', {frame: 1, hash: '00000001', winner: 3});
  assert.deepEqual(results, []);
  for (const peer of peers) {
    const {expiresAt, ...result} = peer.messages.at(-1);
    assert.ok(expiresAt > Date.now());
    assert.deepEqual(result, {type: 'ended', reason: 'MATCH_COMPLETED', winner: 3, frame: 1, canRematch: true});
  }
});

test('a divergent checkpoint from any lockstep seat ends the match', async t => {
  const match = createLockstepMatch({levelId: 0, playerCount: 3, onEnd: () => {}});
  t.after(() => match.close());
  const peers = Array.from({length: 3}, () => new Peer());
  for (const [seat, peer] of peers.entries()) {
    match.attach(peer, seat);
    peer.message('ready', {hash: '00000000'});
  }
  await waitForFrames(peers[0], 1);
  for (const peer of peers.slice(0, 2)) peer.message('ack', {frame: 1, hash: '00000001'});
  peers[2].message('ack', {frame: 1, hash: '00000002'});
  for (const peer of peers) assert.equal(peer.messages.at(-1).reason, 'MATCH_DESYNC');
});

test('disconnect freezes input and replays even a frame whose ACK was lost', async t => {
  const results = [];
  const match = createLockstepMatch({levelId: 0, onEnd: reason => results.push(reason)});
  t.after(() => match.close());
  const first = new Peer();
  const second = new Peer();
  match.attach(first, 0);
  match.attach(second, 1);
  for (const peer of [first, second]) peer.message('ready', {hash: '00000000'});
  first.message('input', {mask: 1});
  await waitForFrames(first, MAX_FRAME_LEAD);
  first.close();
  const paused = second.messages.at(-1);
  assert.equal(paused.type, 'paused');
  assert.equal(paused.seat, 0);
  assert.equal(paused.frame, MAX_FRAME_LEAD);
  assert.equal(match.canAttach(0), true);
  assert.deepEqual(results, []);

  const resumed = new Peer();
  match.attach(resumed, 0);
  const welcome = resumed.messages[0];
  assert.equal(welcome.reconnecting, true);
  assert.equal(welcome.started, true);
  assert.equal(welcome.seed, first.messages[0].seed);
  assert.ok(welcome.expiresAt > paused.expiresAt);
  resumed.message('resume', {frame: 1});
  assert.deepEqual(resumed.frames, first.frames);
  first.message('leave'); // A replaced transport cannot terminate the match.

  resumed.message('ack', {frame: 1, hash: '00000001'});
  second.message('ack', {frame: 1, hash: '00000001'});
  for (let frame = 2; frame <= paused.frame; frame++) resumed.message('ack', {frame});
  await delay(75);
  assert.equal(second.frames.length, paused.frame);
  assert.equal(second.messages.at(-1).type, 'paused');
  for (let frame = 2; frame <= paused.frame; frame++) second.message('ack', {frame});
  for (const peer of [resumed, second]) assert.deepEqual(peer.messages.at(-1), {type: 'resumed', frame: paused.frame});
  await waitForFrames(second, paused.frame + 1);
  assert.deepEqual(second.frames[paused.frame].masks, [0, 0]);
  assert.deepEqual(second.frames[paused.frame].pressed, [0, 0]);
  resumed.message('leave');
  assert.deepEqual(results, ['MATCH_ABORTED']);
});

test('reloading a seat recovers from frame zero and checks confirmed digests', async t => {
  const match = createLockstepMatch({levelId: 0, onEnd: () => {}});
  t.after(() => match.close());
  const first = new Peer();
  const second = new Peer();
  match.attach(first, 0);
  match.attach(second, 1);
  for (const peer of [first, second]) peer.message('ready', {hash: '00000000'});
  await waitForFrames(first, 2);
  for (const peer of [first, second]) {
    peer.message('ack', {frame: 1, hash: '00000001'});
    peer.message('ack', {frame: 2});
  }
  first.close();
  const target = second.messages.at(-1).frame;
  const refreshed = new Peer();
  match.attach(refreshed, 0);
  refreshed.message('resume', {frame: 0, hash: '00000000'});
  assert.deepEqual(refreshed.frames, first.frames);
  refreshed.message('ack', {frame: 1, hash: '00000001'});
  refreshed.message('ack', {frame: 2});
  for (let frame = 3; frame <= target; frame++) {
    second.message('ack', {frame});
    refreshed.message('ack', {frame});
  }
  assert.deepEqual(refreshed.messages.at(-1), {type: 'resumed', frame: target});

  refreshed.close();
  const invalid = new Peer();
  match.attach(invalid, 0);
  invalid.message('resume', {frame: 0, hash: '00000000'});
  invalid.message('ack', {frame: 1, hash: '00000002'});
  assert.equal(second.messages.at(-1).reason, 'MATCH_DESYNC');
});

test('a reconnect while loading starts only after every seat resumes or is ready', async t => {
  const match = createLockstepMatch({levelId: 0, onEnd: () => {}});
  t.after(() => match.close());
  const first = new Peer();
  const second = new Peer();
  match.attach(first, 0);
  match.attach(second, 1);
  first.close();
  second.message('ready', {hash: '00000000'});
  assert.equal(second.messages.at(-1).type, 'paused');
  const refreshed = new Peer();
  match.attach(refreshed, 0);
  assert.equal(refreshed.messages[0].started, false);
  refreshed.message('resume', {frame: 0, hash: '00000000'});
  assert.deepEqual(refreshed.messages.at(-1), {type: 'start'});
  assert.deepEqual(second.messages.at(-1), {type: 'start'});
  await waitForFrames(second, 1);
});

test('an initialized seat can recover before the other player opens the game', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const match = createLockstepMatch({levelId: 0, onEnd: () => {}});
  t.after(() => match.close());
  const first = new Peer();
  match.attach(first, 0);
  first.message('ready', {hash: '00000000'});
  first.close();

  const recovered = new Peer();
  match.attach(recovered, 0);
  recovered.message('resume', {frame: 0, hash: '00000000'});
  assert.equal(recovered.messages.at(-1).type, 'welcome');
  t.mock.timers.tick(70_000);
  const second = new Peer();
  assert.equal(match.canAttach(1), true);
  match.attach(second, 1);
  second.message('ready', {hash: '00000000'});
  assert.deepEqual(recovered.messages.at(-1), {type: 'start'});
});

test('a disconnected seat expires after the transport grace and cannot reattach', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  const match = createLockstepMatch({levelId: 0, onEnd: () => {}});
  t.after(() => match.close());
  const first = new Peer();
  const second = new Peer();
  match.attach(first, 0);
  match.attach(second, 1);
  first.close();
  t.mock.timers.tick(19_999);
  assert.equal(match.canAttach(0), true);
  t.mock.timers.tick(1);
  assert.equal(match.canAttach(0), false);
  assert.equal(second.messages.at(-1).reason, 'MATCH_RECONNECT_TIMEOUT');
});

test('a silent connection enters reconnect grace when its frame acknowledgements stop', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const match = createLockstepMatch({levelId: 0, onEnd: () => {}});
  t.after(() => match.close());
  const first = new Peer();
  const second = new Peer();
  match.attach(first, 0);
  match.attach(second, 1);
  for (const peer of [first, second]) peer.message('ready', {hash: '00000000'});
  now = 34;
  t.mock.timers.tick(34);
  first.message('ack', {frame: 1, hash: '00000001'});
  now = 8040;
  t.mock.timers.tick(8060);
  assert.equal(first.messages.at(-1).type, 'paused');
  assert.equal(first.messages.at(-1).seat, 1);
  assert.equal(match.canAttach(0), false);
  assert.equal(match.canAttach(1), true);
});

test('the rematch window expires and releases the finished match', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date']});
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const results = [];
  const match = createLockstepMatch({levelId: 0, onEnd: reason => results.push(reason)});
  t.after(() => match.close());
  const first = new Peer();
  const second = new Peer();
  match.attach(first, 0);
  match.attach(second, 1);
  for (const peer of [first, second]) peer.message('ready', {hash: '00000000'});
  now = 34;
  t.mock.timers.tick(34);
  for (const peer of [first, second]) peer.message('ack', {frame: 1, hash: '00000001', winner: 0});
  t.mock.timers.tick(119_999);
  assert.deepEqual(results, []);
  t.mock.timers.tick(1);
  assert.deepEqual(results, ['MATCH_COMPLETED']);
  assert.deepEqual(first.messages.at(-1), {
    type: 'ended', reason: 'MATCH_COMPLETED', winner: 0, frame: 1, canRematch: false,
  });
});

test('terminal reports are reconciled through replay before displaying the result', async t => {
  const match = createLockstepMatch({levelId: 0, onEnd: () => {}});
  t.after(() => match.close());
  const first = new Peer();
  const second = new Peer();
  match.attach(first, 0);
  match.attach(second, 1);
  for (const peer of [first, second]) peer.message('ready', {hash: '00000000'});
  await waitForFrames(first, 1);

  const acknowledgement = {frame: 1, hash: '00000001', winner: 1};
  first.message('ack', acknowledgement);
  first.close();
  second.message('ack', acknowledgement);
  assert.deepEqual(second.messages.at(-1).type, 'paused');

  const refreshed = new Peer();
  match.attach(refreshed, 0);
  refreshed.message('resume', {frame: 0, hash: '00000000'});
  assert.deepEqual(refreshed.frames, [first.frames[0]]);
  refreshed.message('ack', acknowledgement);
  for (const peer of [refreshed, second]) {
    assert.equal(peer.messages.at(-1).reason, 'MATCH_COMPLETED');
    assert.equal(peer.messages.at(-1).winner, 1);
    assert.equal(peer.messages.at(-1).canRematch, true);
  }
});

test('the same seats and outfits start a new round only after every seat votes', async t => {
  const results = [];
  const outfits = [{robotId: 5, clothId: 0, hatId: 2, expId: 1}, {robotId: 1, clothId: 2, hatId: 0, expId: 3}];
  const bombItSettings = {mapId: 'Forest', modeId: 'collect'};
  const match = createLockstepMatch({levelId: 0, playerNames: ['Ada', 'Ben'], playerOutfits: outfits,
    bombItSettings, onEnd: reason => results.push(reason)});
  t.after(() => match.close());
  const first = new Peer();
  const second = new Peer();
  match.attach(first, 0);
  match.attach(second, 1);
  const firstRound = first.messages[0];
  assert.deepEqual(firstRound.playerOutfits, outfits);
  assert.deepEqual(firstRound.bombItSettings, bombItSettings);
  for (const peer of [first, second]) peer.message('ready', {hash: '00000000'});
  first.message('input', {mask: 1});
  await waitForFrames(first, 1);
  for (const peer of [first, second]) peer.message('ack', {frame: 1, hash: '00000001', winner: null});
  first.message('input', {mask: 0}); // Already queued when the last acknowledgement arrived.
  first.message('rematch');
  first.message('rematch');
  assert.deepEqual(second.messages.at(-1), {type: 'rematch-votes', votes: 1, needed: 2, votedSeats: [0]});
  first.close();
  assert.deepEqual(second.messages.at(-1), {type: 'rematch-votes', votes: 0, needed: 2, votedSeats: []});
  second.message('rematch');

  const rejoined = new Peer();
  match.attach(rejoined, 0);
  assert.equal(rejoined.messages[0].reason, 'MATCH_COMPLETED');
  assert.deepEqual(rejoined.messages[1].votedSeats, [1]);
  rejoined.message('rematch');
  const nextRound = rejoined.messages.at(-1);
  assert.equal(nextRound.type, 'welcome');
  assert.equal(nextRound.nextRound, true);
  assert.equal(nextRound.seat, 0);
  assert.equal(second.messages.at(-1).seat, 1);
  assert.deepEqual(nextRound.playerNames, firstRound.playerNames);
  assert.deepEqual(nextRound.playerOutfits, outfits);
  assert.deepEqual(nextRound.bombItSettings, bombItSettings);
  assert.notEqual(nextRound.seed, firstRound.seed);

  for (const peer of [rejoined, second]) peer.message('ready', {hash: '00000002'});
  await waitForFrames(rejoined, 1);
  assert.deepEqual(rejoined.frames[0], {type: 'frame', frame: 1, masks: [0, 0], pressed: [0, 0]});
  rejoined.message('leave');
  assert.deepEqual(results, ['MATCH_ABORTED']);
});
