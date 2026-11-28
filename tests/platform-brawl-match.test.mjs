import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {test} from 'node:test';
import {WebSocket} from 'ws';
import {createPlatformBrawlMatch} from '../server/platform-brawl-match.mjs';

class Peer extends EventEmitter{
  readyState=WebSocket.OPEN;
  bufferedAmount=0;
  messages=[];
  autoPong=true;

  get latest(){return this.messages.findLast(packet=>packet.type==='brawl');}
  send(text){this.messages.push(JSON.parse(text));}
  input(packet){this.emit('message',Buffer.from(JSON.stringify({type:'input',...packet})),false);}
  leave(){this.emit('message',Buffer.from('{"type":"leave"}'),false);}
  ping(nonce){if(this.autoPong)this.emit('pong',nonce);}
  close(code){this.closedCode=code;this.readyState=WebSocket.CLOSED;this.emit('close');}
  terminate(){this.close(1006);}
}

function createFixture(t,options={}){
  let clock=1000;
  t.mock.method(performance,'now',()=>clock);
  t.mock.timers.enable({apis:['setInterval']});
  const match=createPlatformBrawlMatch({playerNames:['Nori','Rumi'],...options});
  t.after(()=>match.close());
  return {
    match,
    advance(ms){
      const deadline=clock+ms;
      while(clock<deadline){
        clock+=12;
        t.mock.timers.tick(12);
      }
    },
    connect(seat,client=new Peer()){
      match.attach(client,seat);
      assert.deepEqual(client.messages[0],{type:'seat',seat});
      return client;
    },
  };
}

test('confirmed brawl seats enter one shared authoritative match and short action taps survive',t=>{
  const {advance,connect}=createFixture(t);
  const first=connect(0);
  assert.equal(first.latest.phase,'waiting');
  const second=connect(1);
  assert.equal(first.latest.phase,'playing');
  assert.deepEqual(first.latest,second.latest);
  assert.deepEqual(first.latest.players.map(player=>player.name),['Nori','Rumi']);
  assert(first.messages.some(packet=>packet.type==='latency'));
  const before=second.latest.players[0];
  first.input({seq:0,jump:true,right:true});
  first.input({seq:1,right:true});
  first.input({seq:0,left:true});
  advance(108);
  assert(second.latest.players[0].x>before.x);
  assert(second.latest.players[0].y<before.y);
});

test('an admitted third seat can finish loading without blocking a ready pair or resetting the round',t=>{
  const {advance,connect}=createFixture(t,{playerNames:['A','B','C']});
  const first=connect(0);
  connect(1);
  advance(2_880);
  assert.equal(first.latest.phase,'waiting');
  advance(200);
  assert.equal(first.latest.phase,'playing');
  const tick=first.latest.tick;
  const third=connect(2);
  assert(third.latest.tick>=tick);
  assert.equal(third.latest.tick,first.latest.tick);
  assert.equal(third.latest.round,1);
  assert(third.latest.players.every(player=>player.connected));
});

test('a disconnected brawler pauses two-seat play and resumes with the same seat and world',t=>{
  const {advance,connect,match}=createFixture(t);
  const first=connect(0),second=connect(1);
  first.input({seq:0,right:true});
  advance(168);
  first.terminate();
  const before=second.latest.players[0];
  const pausedAt=second.latest.tick;
  advance(1500);
  assert.equal(second.latest.paused,true);
  assert.equal(second.latest.tick,pausedAt);
  assert.equal(second.latest.players[0].connected,false);
  assert(match.canAttach(0));

  const replacement=connect(0);
  assert.equal(replacement.latest.paused,false);
  assert.equal(replacement.latest.players[0].x,before.x);
  assert.equal(replacement.latest.players[0].score,before.score);
  const newer=connect(0);
  assert.equal(replacement.closedCode,4001);
  assert(newer.latest.players[0].connected);
  assert.equal(newer.latest.tick,pausedAt);
  advance(96);
  assert(newer.latest.tick>pausedAt);
});

test('lagging sockets skip snapshots and a reconnect reservation expires after 45 seconds',t=>{
  const ends=[],drops=[];
  const {advance,connect,match}=createFixture(t,{onEnd:reason=>ends.push(reason),onSeatDropped:seat=>drops.push(seat)});
  const first=connect(0),second=connect(1);
  const congestedAt=first.latest.tick;
  first.bufferedAmount=32*1024;
  advance(240);
  assert.equal(first.latest.tick,congestedAt);
  assert(second.latest.tick>congestedAt);
  first.bufferedAmount=0;
  advance(60);
  assert.equal(first.latest.tick,second.latest.tick);
  assert(first.latest.tick>congestedAt);

  first.terminate();
  advance(44_880);
  assert(match.canAttach(0));
  advance(240);
  assert(!match.canAttach(0));
  assert.deepEqual(drops,[0]);
  assert.deepEqual(ends,['PLAYERS_LEFT']);
  assert.equal(second.messages.at(-1).code,'PLAYERS_LEFT');
});

test('a physical shove publishes its hit and credited ring out to both peers',t=>{
  const {advance,connect}=createFixture(t);
  const first=connect(0),second=connect(1);
  function runRight(peer,chunks){
    for(let seq=0;seq<chunks;seq++){
      peer.input({seq,right:true});
      advance(108);
    }
    peer.input({seq:chunks});
    advance(96);
  }
  runRight(second,4);
  runRight(first,13);
  first.input({seq:14,heavy:true});
  first.input({seq:15});
  advance(1656);
  for(const peer of [first,second]){
    const events=peer.messages.flatMap(packet=>packet.events??[]);
    assert(events.some(event=>event.type==='hit'&&event.source===0&&event.target===1));
    assert(events.some(event=>event.type==='ringout'&&event.source===0&&event.target===1));
    assert.equal(peer.latest.players[0].score,1);
  }
});
