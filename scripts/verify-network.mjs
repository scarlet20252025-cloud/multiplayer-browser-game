import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { startServer } from '../server/index.mjs';
import { PROTOCOL, BUILD_ID, GAME_ID, INPUT_TIMEOUT_MS, percentile } from '../server/protocol.mjs';

// This suite uses the real Ruffle authority. No substitute simulation is supplied.
const handshake={protocol:PROTOCOL,build:BUILD_ID,game:GAME_ID};
const checks=[];
const clients=[];
const relays=[];
const record=(name,detail)=>{checks.push({name,status:'passed',detail});console.log('PASS',name);};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let app;
let status='failed';

class Peer {
  constructor(url){
    this.ws=new WebSocket(url);this.messages=[];this.waiters=new Set();this.seq=0;
    this.ws.on('message',data=>{
      const message=JSON.parse(data.toString());
      this.messages.push(message);
      for(const inspect of [...this.waiters])inspect(message);
    });
    this.ws.on('error',()=>{});
  }
  async open(){await once(this.ws,'open');return this;}
  send(value){this.ws.send(JSON.stringify(value));}
  input(fields={}){
    const seq=this.seq++;
    this.send({type:'input',seq,moveX:0,moveY:0,buttons:0,...fields});
    return seq;
  }
  wait(predicate,{after=0,timeout=60000}={}){
    const existing=this.messages.slice(after).find(predicate);
    if(existing)return Promise.resolve(existing);
    return new Promise((resolve,reject)=>{
      const inspect=message=>{if(predicate(message)){clearTimeout(timer);this.waiters.delete(inspect);resolve(message);}};
      const timer=setTimeout(()=>{this.waiters.delete(inspect);reject(new Error('Timed out waiting for network message'));},timeout);
      this.waiters.add(inspect);
    });
  }
  get state(){return this.messages.findLast(m=>m.type==='state')?.snapshot;}
  async close(){
    if(this.ws.readyState===WebSocket.CLOSED)return;
    const closed=once(this.ws,'close');this.ws.close();await closed;
  }
}
async function peer(url){const value=new Peer(url);clients.push(value);return value.open();}

/** An application-level delay relay, not a packet-loss or real Internet emulator. */
async function makeDelayRelay(target,oneWayMs){
  const server=http.createServer();
  const wss=new WebSocketServer({server});
  const connections=new Set();const timers=new Set();
  const later=action=>{const timer=setTimeout(()=>{timers.delete(timer);action();},oneWayMs);timers.add(timer);};
  wss.on('connection',downstream=>{
    const upstream=new WebSocket(target);connections.add(downstream);connections.add(upstream);
    const waiting=[];
    downstream.on('message',data=>{
      const copy=Buffer.from(data);
      if(upstream.readyState===WebSocket.CONNECTING)waiting.push(copy);
      else later(()=>{if(upstream.readyState===WebSocket.OPEN)upstream.send(copy,{binary:false});});
    });
    upstream.on('open',()=>{for(const data of waiting)later(()=>{if(upstream.readyState===WebSocket.OPEN)upstream.send(data,{binary:false});});});
    upstream.on('message',data=>{const copy=Buffer.from(data);later(()=>{if(downstream.readyState===WebSocket.OPEN)downstream.send(copy,{binary:false});});});
    downstream.on('error',()=>{});upstream.on('error',()=>{});
    downstream.on('close',()=>{connections.delete(downstream);upstream.close();});
    upstream.on('close',()=>{connections.delete(upstream);downstream.close();});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const relay={url:`ws://127.0.0.1:${server.address().port}`,async close(){
    for(const timer of timers)clearTimeout(timer);
    for(const ws of connections)ws.terminate();
    await new Promise(resolve=>wss.close(resolve));
    await new Promise(resolve=>server.close(resolve));
  }};
  relays.push(relay);return relay;
}
async function pair(url){
  const a=await peer(url),b=await peer(url);
  a.send({type:'create',...handshake,name:'Network A'});
  const first=await a.wait(m=>m.type==='welcome');
  a.seq=first.lastInputSeq+1;
  b.send({type:'join',...handshake,code:first.room.code,name:'Network B'});
  const second=await b.wait(m=>m.type==='welcome');b.seq=second.lastInputSeq+1;
  a.send({type:'ready'});b.send({type:'ready'});
  await a.wait(m=>m.type==='state'&&m.snapshot.tick>=2);
  return {a,b,first,second};
}
async function ackSamples(a,count){
  const samples=[];
  for(let i=0;i<count;i++){
    const after=a.messages.length;const started=performance.now();const seq=a.input({aimX:(i+1)/(count+1)});
    await a.wait(m=>m.type==='state'&&m.ack[0]>=seq,{after,timeout:10000});
    samples.push(Number((performance.now()-started).toFixed(3)));
  }
  return {count,samplesMs:samples,p50Ms:percentile(samples,.5),p95Ms:percentile(samples,.95)};
}

await mkdir('evidence',{recursive:true});
try{
  app=await startServer({port:0,maxRooms:3});
  const url=app.url.replace('http:','ws:')+'/ws';
  const {a,b,first}=await pair(url);
  record('real WebSocket inputs reach a real AS3 authority',{room:first.room.code,initialTick:a.state.tick});
  const observer=await peer(url);
  observer.send({type:'join',...handshake,code:first.room.code,build:'wrong-build'});
  await observer.wait(m=>m.type==='error'&&m.code==='BUILD_MISMATCH');
  observer.send({type:'join',...handshake,code:first.room.code});
  await observer.wait(m=>m.type==='error'&&m.code==='ROOM_FULL');
  observer.send({type:'resume',...handshake,resumeToken:'not-a-real-token'});
  await observer.wait(m=>m.type==='error'&&m.code==='RESUME_REJECTED');
  record('room capacity, build compatibility and resume ownership enforced',{});

  a.send({type:'input',seq:100,moveX:1,moveY:0,buttons:0,slot:1});
  await a.wait(m=>m.type==='error'&&m.code==='UNKNOWN_INPUT_FIELD');
  a.send({type:'state',snapshot:{tick:999999}});
  await a.wait(m=>m.type==='error'&&m.code==='UNKNOWN_MESSAGE');
  const seq=a.input();
  await a.wait(m=>m.type==='state'&&m.ack[0]>=seq);
  const beforeStale=a.state;const staleCount=app.getMetrics().staleInputs;
  a.send({type:'input',seq,moveX:1,moveY:1,buttons:1});
  await a.wait(m=>m.type==='state'&&m.snapshot.tick>=beforeStale.tick+2);
  assert.equal(app.getMetrics().staleInputs,staleCount+1);
  assert.deepEqual(a.state.players,beforeStale.players);
  record('seat spoofing, client state replacement and stale input rejected',{});

  let edge,timingAttempts=0,sameTick=false;
  // Retry only a proven scheduling-window miss. A lost AS3 edge always fails.
  for(;timingAttempts<5&&!sameTick;){
    timingAttempts++;
    const previous=a.state.tick;
    await a.wait(m=>m.type==='state'&&m.snapshot.tick>previous);
    const edgeStart=a.state;const edgeOffset=a.messages.length;
    const down=a.input({buttons:1});const up=a.input({buttons:0});
    edge=await a.wait(m=>m.type==='state'&&m.ack[0]>=up,{after:edgeOffset});
    const consumed=a.messages.slice(edgeOffset).filter(m=>m.type==='state'&&m.ack[0]>=down);
    assert.equal(edge.snapshot.players[0].buttons,0);
    assert.equal(edge.snapshot.players[0].pressedCount,edgeStart.players[0].pressedCount+1);
    assert.equal(edge.snapshot.players[0].releasedCount,edgeStart.players[0].releasedCount+1);
    assert.deepEqual(edge.snapshot.players[1],edgeStart.players[1]);
    sameTick=consumed[0].ack[0]===up;
    if(!sameTick)assert.equal(consumed[0].ack[0],down);
  }
  assert.ok(sameTick,'No same-tick short tap was observed in five timing windows');
  const nextEdge=await a.wait(m=>m.type==='state'&&m.snapshot.tick>edge.snapshot.tick);
  assert.equal(nextEdge.snapshot.players[0].pressedCount,edge.snapshot.players[0].pressedCount);
  assert.equal(nextEdge.snapshot.players[0].releasedCount,edge.snapshot.players[0].releasedCount);
  record('down and up in one tick survive WebSocket, Node buffer and AS3',{timingAttempts,tick:edge.snapshot.tick,pressedCount:edge.snapshot.players[0].pressedCount,releasedCount:edge.snapshot.players[0].releasedCount});

  const activeSeq=a.input({buttons:1,moveX:1});
  await a.wait(m=>m.type==='state'&&m.ack[0]>=activeSeq&&m.snapshot.players[0].buttons===1);
  const expireAfter=a.messages.length;
  await a.wait(m=>m.type==='state'&&m.snapshot.players[0].buttons===0,{after:expireAfter,timeout:INPUT_TIMEOUT_MS+2500});
  const expired=a.state;
  await a.wait(m=>m.type==='state'&&m.snapshot.tick>=expired.tick+3);
  assert.equal(a.state.players[0].x,expired.players[0].x);
  record('silent client releases held keys after input timeout',{configuredTimeoutMs:INPUT_TIMEOUT_MS});

  const baseline=await ackSamples(a,12);
  record('loopback input-to-authoritative-ack measurement',baseline);
  const beforeDisconnect=b.messages.length;
  await a.close();
  await b.wait(m=>m.type==='room'&&m.room.status==='waiting',{after:beforeDisconnect});
  await delay(100);
  const pausedTick=b.state.tick;
  await delay(120);assert.equal(b.state.tick,pausedTick);
  const resumed=await peer(url);
  resumed.send({type:'resume',...handshake,resumeToken:first.resumeToken});
  const welcome=await resumed.wait(m=>m.type==='welcome');
  assert.equal(welcome.slot,0);assert.equal(welcome.room.code,first.room.code);
  const beforeResume=b.messages.length;
  resumed.send({type:'ready'});
  await b.wait(m=>m.type==='state'&&m.snapshot.tick>pausedTick,{after:beforeResume});
  record('disconnect pauses room and token resumes original seat',{slot:welcome.slot,room:welcome.room.code});
  resumed.send({type:'leave'});b.send({type:'leave'});
  await resumed.wait(m=>m.type==='left');await b.wait(m=>m.type==='left');

  const relay=await makeDelayRelay(url,40);
  const delayed=await pair(relay.url);
  const delayedSamples=await ackSamples(delayed.a,12);
  assert.ok(delayedSamples.p50Ms>=70,'The synthetic delay must actually affect the measured round trip');
  record('inputs and authoritative acknowledgements cross a 40 ms each-way delay relay',{
    simulatedOneWayMs:40,simulatedBaseRoundTripMs:80,...delayedSamples,
    meaning:'Input send to acknowledged authoritative snapshot arrival; excludes browser render/paint; no packet loss or jitter model',
  });
  status='passed';
}catch(error){
  checks.push({name:'failure',status:'failed',message:error.stack});console.error(error);process.exitCode=1;
}finally{
  await writeFile('evidence/network-results.json',JSON.stringify({schema:1,status,recordedAt:new Date().toISOString(),
    scope:'Authored AS3 probe and local synthetic delays only; original games and real Internet networks are not validated',
    environment:{node:process.version,network:'loopback and application-level fixed delay relay'},checks,metrics:app?.getMetrics()??null},null,2)+'\n');
  await Promise.all(clients.map(client=>client.close().catch(()=>{})));
  for(const relay of relays)await relay.close();
  await app?.close();
}
