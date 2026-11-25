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

  send(raw) {
    const message = JSON.parse(raw);
    if (message.type === 'frame') this.frames.push(message);
  }

  message(type, fields) {
    this.emit('message', Buffer.from(JSON.stringify({type, ...fields})), false);
  }

  close() {
    this.readyState = WebSocket.CLOSED;
    this.emit('close');
  }
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
