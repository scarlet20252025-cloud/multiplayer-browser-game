// Server logic tests with an injected fake authority. Real Ruffle and the
// authored probe have separate browser E2E; neither suite verifies uploaded games.
import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {startServer} from '../server/index.mjs';
import {PROTOCOL,BUILD_ID,GAME_ID} from '../server/protocol.mjs';

const control=(type,extra={})=>({type,protocol:PROTOCOL,build:BUILD_ID,game:GAME_ID,...extra});
const input=(seq,buttons=0)=>({type:'input',seq,moveX:0,moveY:0,buttons,aimX:.5,aimY:.5});
function deferred(){
  let resolve,reject;
  const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
  return {promise,resolve,reject};
}
async function until(predicate,message='condition did not become true'){
  const end=Date.now()+2000;
  while(!predicate()){
    assert.ok(Date.now()<end,message);
    await delay(5);
  }
}
function fakeAuthority(beforeStep){
  let state={protocol:PROTOCOL,version:BUILD_ID,tick:0,players:[0,1].map(id=>({
    id,x:id===0?160:480,y:180,buttons:0,aimX:id===0?.25:.75,aimY:.5,pressedCount:0,releasedCount:0
  }))};
  const closed=deferred();
  const fake={
    calls:[],closeCount:0,
    read:()=>structuredClone(state),
    async step(values){
      const inputs=structuredClone(values);
      fake.calls.push(inputs);
      if(beforeStep)await Promise.race([
        Promise.resolve().then(()=>beforeStep(inputs,fake.calls.length)),
        closed.promise.then(()=>{throw new Error('fake context closed');})
      ]);
      if(fake.closeCount)throw new Error('fake context closed');
      state={...state,tick:state.tick+1,players:state.players.map((p,i)=>({...p,
        buttons:inputs[i].buttons,aimX:inputs[i].aimX,aimY:inputs[i].aimY,
        pressedCount:p.pressedCount+Number(inputs[i].pressed!==0),
        releasedCount:p.releasedCount+Number(inputs[i].released!==0)
      }))};
      return structuredClone(state);
    },
    async close(){fake.closeCount++;closed.resolve();}
  };
  return fake;
}
function controlledFactory(){
  const pending=[];
  const factory=({signal})=>{
    const gate=deferred();
    const authority=fakeAuthority();
    const entry={authority,signal,finish:()=>gate.resolve(authority)};
    pending.push(entry);
    // Model an initialization that finishes after cancellation. The server must
    // close the returned authority instead of publishing a late welcome.
    signal.addEventListener('abort',entry.finish,{once:true});
    return gate.promise;
  };
  return {factory,pending};
}
async function runServer(t,options={}){
  const app=await startServer({port:0,maxRooms:4,authorityFactory:()=>fakeAuthority(),...options});
  t.after(()=>app.close());
  return app;
}
async function client(app){
  const ws=new WebSocket(app.url.replace('http:','ws:')+'/ws');
  const history=[],inbox=[],waiters=new Set();
  ws.on('message',buffer=>{
    const value=JSON.parse(buffer.toString());history.push(value);
    const waiter=[...waiters].find(item=>item.matches(value));
    if(waiter){waiters.delete(waiter);clearTimeout(waiter.timer);waiter.resolve(value);}
    else inbox.push(value);
  });
  await once(ws,'open');
  return {
    ws,history,
    send:value=>ws.send(JSON.stringify(value)),
    next(type,predicate=()=>true){
      const matches=value=>value.type===type&&predicate(value);
      const index=inbox.findIndex(matches);
      if(index>=0)return Promise.resolve(inbox.splice(index,1)[0]);
      return new Promise((resolve,reject)=>{
        const waiter={matches,resolve,timer:setTimeout(()=>{
          waiters.delete(waiter);reject(new Error(`Timed out waiting for ${type}`));
        },2000)};
        waiters.add(waiter);
      });
    },
    async barrier(){
      const id=`barrier-${Math.random()}`;
      ws.send(JSON.stringify({type:'ping',id}));
      return this.next('pong',value=>value.id===id);
    },
    async disconnect(){
      if(ws.readyState===WebSocket.CLOSED)return;
      const done=once(ws,'close');ws.terminate();await done;
    }
  };
}
async function pair(app){
  const a=await client(app),b=await client(app);
  a.send(control('create'));
  const first=await a.next('welcome');
  b.send(control('join',{code:first.room.code}));
  const second=await b.next('welcome');
  a.send({type:'ready'});b.send({type:'ready'});
  await a.next('room',message=>message.room.status==='running');
  return {a,b,first,second,room:app.rooms.get(first.room.code)};
}

test('fake authority: concurrent match requests reserve two seats in one booting room',async t=>{
  const controlled=controlledFactory();
  const app=await runServer(t,{authorityFactory:controlled.factory});
  const a=await client(app),b=await client(app);
  a.send(control('match'));b.send(control('match'));
  await Promise.all([a.barrier(),b.barrier()]);
  assert.equal(controlled.pending.length,1);
  assert.equal(app.rooms.size,1);
  const room=[...app.rooms.values()][0];
  assert.equal(room.status,'starting');assert.ok(room.members.every(Boolean));
  a.send(control('create'));
  assert.equal((await a.next('error')).code,'ALREADY_JOINED');
  controlled.pending[0].finish();
  const [one,two]=await Promise.all([a.next('welcome'),b.next('welcome')]);
  assert.equal(one.room.code,two.room.code);assert.notEqual(one.slot,two.slot);
  a.send({type:'leave'});b.send({type:'leave'});
  await Promise.all([a.next('left'),b.next('left')]);
  await until(()=>controlled.pending[0].authority.closeCount===1);
  assert.equal(app.rooms.size,0);
});

test('fake authority: disconnect during boot releases only its reservation and leaves no orphan',async t=>{
  const controlled=controlledFactory();
  const app=await runServer(t,{authorityFactory:controlled.factory});
  const a=await client(app),b=await client(app),c=await client(app);
  a.send(control('match'));b.send(control('match'));
  await Promise.all([a.barrier(),b.barrier()]);
  const room=[...app.rooms.values()][0];
  await a.disconnect();await until(()=>room.members.filter(Boolean).length===1);
  c.send(control('match'));await c.barrier();
  assert.equal(controlled.pending.length,1);assert.equal(app.rooms.size,1);
  controlled.pending[0].finish();
  const [second,third]=await Promise.all([b.next('welcome'),c.next('welcome')]);
  assert.equal(second.room.code,third.room.code);assert.notEqual(second.slot,third.slot);
  b.send({type:'leave'});c.send({type:'leave'});
  await Promise.all([b.next('left'),c.next('left')]);
  await until(()=>controlled.pending[0].authority.closeCount===1);
  assert.equal(app.rooms.size,0);
});

test('fake authority: abandoning the last booting seat cancels and closes late initialization',async t=>{
  const controlled=controlledFactory();
  const app=await runServer(t,{authorityFactory:controlled.factory,maxRooms:1});
  const a=await client(app);
  a.send(control('create'));await a.barrier();
  a.send({type:'leave'});await a.next('left');
  await until(()=>controlled.pending[0].authority.closeCount===1);
  assert.equal(controlled.pending[0].signal.aborted,true);
  assert.equal(app.rooms.size,0);
  assert.equal(a.history.some(message=>message.type==='welcome'),false);
  a.send(control('create'));await a.barrier();
  assert.equal(controlled.pending.length,2);
  controlled.pending[1].finish();assert.ok(await a.next('welcome'));
});

test('fake authority: slow creation does not block another room resume, ready or leave',async t=>{
  const controlled=controlledFactory();let creations=0;
  const app=await runServer(t,{authorityFactory:args=>++creations===1?fakeAuthority():controlled.factory(args)});
  const {a,b,first,room}=await pair(app);
  await a.disconnect();await until(()=>!room.members[0].ws);
  const newcomer=await client(app);newcomer.send(control('create'));await newcomer.barrier();
  assert.equal(controlled.pending.length,1);
  const resumed=await client(app);
  resumed.send(control('resume',{resumeToken:first.resumeToken}));
  const welcome=await resumed.next('welcome');
  assert.equal(welcome.room.code,first.room.code);assert.equal(welcome.slot,0);
  resumed.send({type:'ready'});await resumed.next('room',m=>m.room.status==='running');
  b.send({type:'leave'});await b.next('left');
  assert.equal(controlled.pending[0].authority.closeCount,0);
  assert.equal(newcomer.history.some(message=>message.type==='welcome'),false);
  controlled.pending[0].finish();await newcomer.next('welcome');
});

test('fake authority: failed initialization frees the seat and closes allocated resources before retry',async t=>{
  const invalid=fakeAuthority();invalid.read=()=>({protocol:PROTOCOL,version:BUILD_ID,tick:0,players:[]});
  let creations=0;
  const app=await runServer(t,{authorityFactory:()=>++creations===1?invalid:fakeAuthority()});
  const a=await client(app);a.send(control('create'));
  assert.equal((await a.next('error')).code,'ROOM_START_FAILED');
  await until(()=>invalid.closeCount===1);assert.equal(app.rooms.size,0);
  a.send(control('create'));assert.ok(await a.next('welcome'));assert.equal(app.rooms.size,1);
});

test('fake authority: rooms still releasing resources count toward the capacity limit',async t=>{
  const release=deferred(),authority=fakeAuthority();let creations=0;
  const close=authority.close;
  authority.close=async()=>{await release.promise;await close();};
  const app=await runServer(t,{maxRooms:1,authorityFactory:()=>++creations===1?authority:fakeAuthority()});
  try {
    const a=await client(app);a.send(control('create'));
    const welcome=await a.next('welcome');const room=app.rooms.get(welcome.room.code);
    a.send({type:'leave'});await a.next('left');
    a.send(control('create'));assert.equal((await a.next('error')).code,'SERVER_FULL');
    assert.equal(creations,1);
    release.resolve();await room.destroyPromise;
    a.send(control('create'));assert.ok(await a.next('welcome'));assert.equal(creations,2);
  } finally {release.resolve();}
});

test('fake authority: snapshot acknowledgement refers to sampled input, not newer arrivals',async t=>{
  const gate=deferred(),started=deferred();
  const authority=fakeAuthority((inputs,count)=>{if(count===1){started.resolve();return gate.promise;}});
  const app=await runServer(t,{authorityFactory:()=>authority});
  const {a}=await pair(app);await started.promise;
  a.send(input(20,1));await a.barrier();
  gate.resolve();
  const first=await a.next('state',message=>message.snapshot.tick===1);
  assert.equal(first.ack[0],authority.calls[0][0].seq);assert.ok(first.ack[0]<20);
  const applied=await a.next('state',message=>message.ack[0]===20);
  assert.equal(applied.snapshot.players[0].pressedCount,1);
});

test('fake authority: pause and reconnect discard both seats pending edges, including waiting input',async t=>{
  const gate=deferred(),started=deferred();
  const authority=fakeAuthority((inputs,count)=>{if(count===1){started.resolve();return gate.promise;}});
  const app=await runServer(t,{authorityFactory:()=>authority});
  const {a,b,first,room}=await pair(app);await started.promise;
  a.send(input(5,1));b.send(input(9,2));await Promise.all([a.barrier(),b.barrier()]);
  await a.disconnect();await until(()=>room.status==='waiting');
  b.send(input(10,2));await b.barrier();
  const resumed=await client(app);resumed.send(control('resume',{resumeToken:first.resumeToken}));
  const welcome=await resumed.next('welcome');assert.equal(welcome.lastInputSeq,5);
  resumed.send({type:'ready'});await resumed.next('room',message=>message.room.status==='running');
  gate.resolve();
  const state=await resumed.next('state',message=>message.snapshot.tick>=2);
  assert.deepEqual(authority.calls[1].map(value=>({seq:value.seq,buttons:value.buttons,pressed:value.pressed,released:value.released})),[
    {seq:5,buttons:0,pressed:0,released:0},{seq:10,buttons:0,pressed:0,released:0}
  ]);
  assert.ok(state.snapshot.players.every(player=>player.pressedCount===0&&player.releasedCount===0));
});

test('fake authority: failed rooms cannot be readied, joined, resumed or matched again',async t=>{
  const bad=fakeAuthority(()=>{throw new Error('intentional fake failure');});let creations=0;
  const app=await runServer(t,{authorityFactory:()=>++creations===1?bad:fakeAuthority()});
  const {a,b,first,room}=await pair(app);
  assert.equal((await a.next('error')).code,'AUTHORITY_FAILED');assert.equal(room.status,'failed');
  a.send({type:'ready'});assert.equal((await a.next('error')).code,'ROOM_FAILED');
  b.send({type:'leave'});await b.next('left');assert.equal(room.status,'failed');
  const c=await client(app);c.send(control('join',{code:first.room.code}));
  assert.equal((await c.next('error')).code,'ROOM_FAILED');
  c.send(control('match'));assert.notEqual((await c.next('welcome')).room.code,first.room.code);
  await a.disconnect();await until(()=>!room.members[0].ws);
  const resumed=await client(app);resumed.send(control('resume',{resumeToken:first.resumeToken}));
  assert.equal((await resumed.next('error')).code,'RESUME_REJECTED');
  assert.equal(room.status,'failed');assert.equal(bad.closeCount,1);
});

test('fake authority: shutdown cancels an in-flight step without reporting authority failure',async t=>{
  const gate=deferred(),started=deferred();
  const authority=fakeAuthority(()=>{started.resolve();return gate.promise;});
  const app=await runServer(t,{authorityFactory:()=>authority});
  const {a,b,room}=await pair(app);await started.promise;
  const firstClose=app.close();assert.equal(app.close(),firstClose);await firstClose;
  assert.equal(room.destroyed,true);assert.equal(room.status,'closed');assert.equal(authority.closeCount,1);
  assert.equal(app.rooms.size,0);
  assert.equal([...a.history,...b.history].some(message=>message.code==='AUTHORITY_FAILED'),false);
});

test('fake authority: shutdown drains a booting room and closes its late authority once',async t=>{
  const controlled=controlledFactory();
  const app=await runServer(t,{authorityFactory:controlled.factory});
  const a=await client(app);a.send(control('create'));await a.barrier();
  await app.close();
  assert.equal(controlled.pending[0].signal.aborted,true);
  assert.equal(controlled.pending[0].authority.closeCount,1);assert.equal(app.rooms.size,0);
  assert.equal(a.history.some(message=>message.type==='welcome'||message.type==='error'),false);
});
