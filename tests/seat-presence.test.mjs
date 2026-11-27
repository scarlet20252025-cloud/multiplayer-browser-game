import test from 'node:test';
import assert from 'node:assert/strict';
import {SeatPresence} from '../server/seat-presence.mjs';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('issue and claim round-trips the seat token', ()=>{
  const presence=new SeatPresence({capacity:2});
  const token=presence.issue(1);
  assert.match(token,/^[a-f0-9]{32}$/);
  assert.equal(presence.claim(token),1);
  assert.equal(presence.claim(token),1,'claim is idempotent while the lease lives');
  assert.equal(presence.claim('f'.repeat(32)),null);
  assert.equal(presence.claim('nope'),null);
});

test('hold keeps the seat for the grace window, then expires once', async ()=>{
  const expired=[];
  const presence=new SeatPresence({capacity:2,graceMs:60,onExpire:slot=>expired.push(slot)});
  const token=presence.issue(0);
  presence.hold(0);
  assert.deepEqual(presence.reservedSlots(),[0]);
  assert.ok(presence.expiresAt(0)>Date.now());
  assert.equal(presence.claim(token),0,'can still come back inside the window');
  assert.deepEqual(presence.reservedSlots(),[],'claim clears the reservation');

  presence.hold(0);
  await sleep(100);
  assert.deepEqual(expired,[0]);
  assert.equal(presence.claim(token),null);
  assert.deepEqual(presence.reservedSlots(),[]);
});

test('release invalidates the token immediately', ()=>{
  const presence=new SeatPresence({capacity:2});
  const token=presence.issue(0);
  presence.release(0);
  assert.equal(presence.claim(token),null);
  assert.deepEqual(presence.reservedSlots(),[]);
});

test('a new token replaces the old one for the same seat', ()=>{
  const presence=new SeatPresence({capacity:2});
  const first=presence.issue(0);
  const second=presence.issue(0);
  assert.notEqual(first,second);
  assert.equal(presence.claim(first),null);
  assert.equal(presence.claim(second),0);
});

test('dispose cancels pending reservations', async ()=>{
  const expired=[];
  const presence=new SeatPresence({capacity:2,graceMs:40,onExpire:slot=>expired.push(slot)});
  presence.issue(0);
  presence.hold(0);
  presence.dispose();
  await sleep(80);
  assert.deepEqual(expired,[]);
});

test('rejects impossible capacities and slots', ()=>{
  assert.throws(()=>new SeatPresence({capacity:0}),RangeError);
  assert.throws(()=>new SeatPresence({capacity:9}),RangeError);
  const presence=new SeatPresence({capacity:2});
  assert.throws(()=>presence.issue(2),RangeError);
  assert.throws(()=>presence.release(-1),RangeError);
});
