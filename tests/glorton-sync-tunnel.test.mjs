import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {setTimeout as sleep} from 'node:timers/promises';
import {test} from 'node:test';
import {WebSocketServer} from 'ws';
import {createGlortonSyncMatch} from '../server/glorton-sync-tunnel.mjs';
import {createLocalSession} from '../public/glorton-online/local-session.mjs';
import {decodeGlortonFrame,encodeGlortonFrame,glortonControlFields} from '../public/glorton-online/frame-wire.mjs';

const seatControls=(...held)=>Object.fromEntries(glortonControlFields.map(field=>[field,held.includes(field)]));

test('Glorton compact transport preserves four seats, actions, acknowledgements and checksums',()=>{
  const frame={op:'frame',tick:100,controls:[seatControls('left','jump_pressed'),seatControls('special_pressed'),
    seatControls('up_trace','down','punch_pressed'),seatControls('right','shield_pressed','shield_released')],
  acks:{'0':17,'1':20,'2':21,'3':22},digest:'matched'};
  const compact=encodeGlortonFrame(frame);
  assert.deepEqual(compact.inputs,[17,64,44,386]);
  assert.ok(JSON.stringify(compact).length<JSON.stringify(frame).length/4);
  assert.deepEqual(decodeGlortonFrame(compact),frame);
  assert.strictEqual(decodeGlortonFrame(frame),frame);
  assert.throws(()=>decodeGlortonFrame({...compact,inputs:[512]}),/Invalid Glorton input masks/);
});

test('Glorton decodes compact frames before the engine reads them and passes snapshots through verbatim',()=>{
  let socket;
  class TestSocket extends EventTarget{
    constructor(){super();socket=this;this.sent=[];this.readyState=1;this.bufferedAmount=0;}
    send(message){this.sent.push(JSON.parse(message));}
    receive(data){this.dispatchEvent(new MessageEvent('message',{data}));}
    close(){this.readyState=3;this.dispatchEvent(new Event('close'));}
  }
  const transport=createLocalSession({room:'MNP234',seat:'0'.repeat(32),url:'ws://example.test',Socket:TestSocket});
  const handle=transport.open();
  socket.dispatchEvent(new Event('open'));
  assert.equal(socket.sent[0].compact_frames,true);
  const snapshot='{"op":"snapshot","snapshot":{"tick":10,"offset":-0.0,"distance":1.0}}';
  socket.receive(snapshot);
  socket.receive('{"op":"frame","tick":11,"inputs":[129,4],"acks":{"0":2},"digest":"matched"}');
  assert.equal(transport.read(handle),snapshot);
  assert.deepEqual(JSON.parse(transport.read(handle)),{op:'frame',tick:11,acks:{'0':2},digest:'matched',
    controls:[seatControls('left','shield_pressed'),seatControls('up_trace')]});
  assert.equal(transport.read(handle),'');
  socket.receive('{"op":"welcome","frame_ack":true}');
  socket.receive('{"op":"match_start","round":1,"initial_snapshot":{"tick":0}}');
  assert(transport.acknowledge(120,true,1));
  socket.receive('{"op":"room_state","round":2,"phase":"lobby","server_tick":0}');
  socket.receive('{"op":"frame","round":1,"tick":121,"inputs":[0,0]}');
  assert(!transport.acknowledge(121,true,1));
  assert(transport.acknowledge(4,true,2));
  assert.deepEqual(socket.sent.at(-1),{op:'frame_ack',tick:4,round:2});
  assert.equal(JSON.parse(transport.read(handle)).op,'welcome');
  assert.equal(JSON.parse(transport.read(handle)).round,1);
  assert.equal(JSON.parse(transport.read(handle)).round,2);
  assert.equal(transport.read(handle),'');
  transport.close(handle);
});

async function waitFor(check){
  for(let attempt=0;attempt<300;attempt++){
    if(check())return;
    await sleep(5);
  }
  assert.fail('Expected packet did not arrive');
}

test('Glorton bounds a slow browser and retains the seats for a new round after the result',async t=>{
  const server=createServer();
  const authority=new WebSocketServer({server,path:'/ws'});
  const peers=new Map();
  const recovery=[];
  const forwarded=[];
  authority.on('connection',socket=>socket.on('message',message=>{
    const packet=JSON.parse(message);
    if(packet.op==='create'||packet.op==='join'){
      const slot=packet.op==='create'?0:packet.slot;
      peers.set(slot,socket);
      socket.send(JSON.stringify({op:'welcome',slot,room:'MNP234',protocol:1,token:String(slot).repeat(32)}));
    }
    if(packet.op==='desync')recovery.push(socket);
    if(['map_vote','rematch'].includes(packet.op))forwarded.push(packet);
  }));
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  let phase;
  const tunnel=createGlortonSyncMatch({serviceUrl:`ws://127.0.0.1:${server.address().port}/ws`,onState:state=>{phase=state.phase;}});
  t.after(async()=>{
    tunnel.close();
    for(const socket of authority.clients)socket.terminate();
    await new Promise(resolve=>server.close(resolve));
  });
  const host=[];
  const guest=[];
  tunnel.attach(1,{name:'host',frameAck:true,compactFrames:true,send:packet=>host.push(JSON.parse(JSON.stringify(packet)))});
  tunnel.attach(2,{name:'guest',frameAck:true,send:packet=>{
    guest.push(packet);
    if(packet.op==='frame'&&packet.tick%4===0)
      setImmediate(()=>tunnel.receive(2,{op:'frame_ack',tick:packet.tick}));
  }});
  await waitFor(()=>guest.some(packet=>packet.op==='welcome'));
  assert.equal(host[0].frame_ack,true);
  assert.equal(host[0].compact_frames,true);
  assert.equal(guest[0].compact_frames,undefined);
  function send(slot,packet){peers.get(slot).send(JSON.stringify(packet));}
  function broadcast(packet){for(const slot of peers.keys())send(slot,packet);}
  assert.equal(tunnel.receive(2,{op:'map_vote',stage:'invalid'}),false);
  assert.equal(tunnel.receive(2,{op:'map_vote',stage:'Rooftop'}),true);
  await waitFor(()=>forwarded.length===1);
  assert.deepEqual(forwarded[0],{op:'map_vote',stage:'Rooftop'});
  broadcast({op:'match_start',round:1,seed:3,tick_ms:25,initial_snapshot:{tick:0},match_config:{}});
  for(let tick=1;tick<=24;tick++){
    broadcast({op:'frame',tick,controls:[seatControls('right'),seatControls('punch_pressed')],acks:{'0':1,'1':2}});
    await sleep(5);
  }
  await waitFor(()=>guest.some(packet=>packet.op==='frame'&&packet.tick===24));
  assert.deepEqual(host.filter(packet=>packet.op==='frame').map(packet=>packet.tick),
    Array.from({length:12},(_,index)=>index+1));
  assert.deepEqual(host.find(packet=>packet.tick===1).inputs,[2,32]);
  assert.deepEqual(guest.find(packet=>packet.tick===1).controls,[seatControls('right'),seatControls('punch_pressed')]);
  assert.equal(recovery.length,0);
  assert.equal(tunnel.receive(1,{op:'frame_ack',tick:24}),false);
  assert.equal(tunnel.receive(1,{op:'frame_ack',tick:12}),true);
  await waitFor(()=>recovery.length===1);
  assert.equal(recovery[0],peers.get(0));
  send(0,{op:'snapshot',snapshot:{tick:24}});
  broadcast({op:'frame',tick:25,controls:[seatControls('shield_released'),seatControls()],acks:{'0':3,'1':4},digest:'intact'});
  await waitFor(()=>host.some(packet=>packet.op==='frame'&&packet.tick===25));
  assert.deepEqual(host.slice(-2).map(packet=>[packet.op,packet.snapshot?.tick??packet.tick]),
    [['snapshot',24],['frame',25]]);
  assert.equal(host.at(-1).digest,'intact');
  assert.deepEqual(decodeGlortonFrame(host.at(-1)).controls,[seatControls('shield_released'),seatControls()]);
  assert.deepEqual(host.at(-1).acks,{'0':3,'1':4});

  const result={reason:'game_set',winner:'host',winner_slot:0};
  broadcast({op:'match_end',round:1,...result,snapshot:{tick:25}});
  await waitFor(()=>host.at(-1).op==='match_end'&&guest.at(-1).op==='match_end');
  assert.equal(phase,'finished');
  assert.equal(tunnel.receive(1,{op:'input',seq:19,tick:25,controls:{left:true}}),false);
  assert.equal(tunnel.receive(1,{op:'rematch',ready:true}),true);
  await waitFor(()=>forwarded.length===2);
  assert.deepEqual(forwarded[1],{op:'rematch',ready:true});

  broadcast({op:'room_state',round:2,phase:'lobby',server_tick:0,slots:[{enabled:true},{enabled:true}]});
  await waitFor(()=>host.at(-1).round===2&&guest.at(-1).round===2);
  assert.equal(phase,'lobby');
  assert.equal(tunnel.receive(1,{op:'frame_ack',tick:25,round:1}),false);
  send(1,{op:'match_end',round:1,...result,snapshot:{tick:25}});
  broadcast({op:'match_start',round:2,seed:5,tick_ms:25,initial_snapshot:{tick:0},match_config:{}});
  broadcast({op:'frame',round:2,tick:1,controls:[seatControls(),seatControls()],acks:{}});
  await waitFor(()=>host.at(-1).tick===1&&guest.at(-1).tick===1);
  assert.equal(phase,'playing');
  assert.equal(guest.filter(packet=>packet.op==='match_end').length,1);
  assert.equal(tunnel.receive(1,{op:'frame_ack',tick:1,round:2}),true);
});
