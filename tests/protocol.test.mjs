import test from 'node:test';
import assert from 'node:assert/strict';
import {InputBuffer,validateInput,validateSnapshot,INPUT_TIMEOUT_MS,BUILD_ID} from '../server/protocol.mjs';
const input=(seq,buttons=0,extra={})=>({type:'input',seq,moveX:0,moveY:0,buttons,...extra});
test('only action data is accepted; coordinates, seat spoofing and nonfinite aim are rejected',()=>{
  assert.equal(validateInput(input(0)),null);
  for(const extra of [{slot:1},{x:999},{hp:999},{aimX:Infinity},{aimY:-.1},{moveX:20}])assert.ok(validateInput(input(1,0,extra)));
});
test('short down/up between ticks preserves both edges, with no held button',()=>{
  const b=new InputBuffer();b.receive(input(0,1),100);b.receive(input(1,0),101);
  const first=b.consume(102);assert.equal(first.buttons,0);assert.equal(first.pressed,1);assert.equal(first.released,1);
  const next=b.consume(103);assert.equal(next.pressed,0);assert.equal(next.released,0);
});
test('duplicate and out-of-order packets cannot resurrect a released key',()=>{
  const b=new InputBuffer();b.receive(input(10,1),100);b.receive(input(11,0),101);
  assert.equal(b.receive(input(10,1),102),'STALE_INPUT');assert.equal(b.consume(103).buttons,0);
});
test('missing heartbeat clears all held buttons and motion',()=>{
  const b=new InputBuffer();b.receive(input(0,3,{moveX:1,moveY:-1}),100);
  const next=b.consume(101+INPUT_TIMEOUT_MS);assert.equal(next.moveX,0);assert.equal(next.moveY,0);assert.equal(next.buttons,0);assert.equal(next.released,3);assert.equal(next.pressed,0);
});
test('session reset discards pending edges and holds while preserving sequence and aim',()=>{
  const b=new InputBuffer();b.receive(input(8,3,{moveX:1,moveY:-1,aimX:.2,aimY:.8}),100);
  b.resetPending();
  assert.deepEqual(b.consume(101),{seq:8,moveX:0,moveY:0,buttons:0,pressed:0,released:0,aimX:.2,aimY:.8});
  assert.equal(b.receive(input(8,1),102),'STALE_INPUT');
  assert.equal(b.receive(input(9,1),103),null);
  assert.equal(b.consume(104).pressed,1);
});
test('each player has independent state and pointer coordinates',()=>{
  const a=new InputBuffer(),b=new InputBuffer();a.receive(input(0,1,{aimX:.2,aimY:.3}),10);b.receive(input(0,2,{aimX:.8,aimY:.7}),10);
  assert.equal(a.consume(11).aimX,.2);assert.equal(b.consume(11).aimX,.8);a.release();assert.equal(b.consume(12).buttons,2);
});
test('snapshots require matching build, increasing tick, finite values and exact seat order',()=>{
  const s={protocol:1,version:BUILD_ID,tick:0,players:[
    {id:0,x:160,y:180,buttons:0,aimX:.25,aimY:.5,pressedCount:0,releasedCount:0},
    {id:1,x:480,y:180,buttons:0,aimX:.75,aimY:.5,pressedCount:0,releasedCount:0}
  ]};
  assert.equal(validateSnapshot(s),true);assert.equal(validateSnapshot(s,0),false);
  assert.equal(validateSnapshot({...s,version:'wrong'}),false);
  assert.equal(validateSnapshot({...s,players:[s.players[1],s.players[0]]}),false);
  assert.equal(validateSnapshot({...s,players:[{...s.players[0],x:NaN},s.players[1]]}),false);
  for(const extra of [{aimX:NaN},{aimY:1.01},{pressedCount:undefined},{releasedCount:-1},
    {pressedCount:1.5},{releasedCount:2147483648}]){
    assert.equal(validateSnapshot({...s,players:[{...s.players[0],...extra},s.players[1]]}),false);
  }
  assert.equal(validateSnapshot({...s,tick:2147483648}),false);
});
