import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {WebSocket,WebSocketServer} from 'ws';
import {createGlortonBrowserRooms,GLORTON_BROWSER_CREATE_PATH,GLORTON_BROWSER_JOIN_PATH,
  GLORTON_BROWSER_LEAVE_PATH,GLORTON_BROWSER_SOCKET_PATH} from '../server/glorton-browser-rooms.mjs';

function reply(res,status,type,body){
  res.writeHead(status,{'content-type':type});
  res.end(body);
}

async function listen(server){
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function close(server){
  return new Promise(resolve=>{
    server.close(resolve);
    server.closeAllConnections();
  });
}

function nativeAuthority(){
  const room='MNP234';
  const peers=new Map();
  const empty=index=>({index,kind:'human',name:'',fighter:'PeachPlayer',color:index,
    enabled:false,ready:false,connected:false,token:null});
  const slots=[empty(0),empty(1)];
  function broadcast(){
    const state={op:'room_state',protocol:1,host_slot:0,phase:'lobby',server_tick:0,slots};
    for(const peer of peers.keys())if(peer.readyState===WebSocket.OPEN)peer.send(JSON.stringify(state));
  }
  const http=createServer(async (req,res)=>{
    if(req.url==='/health')return reply(res,200,'application/json',JSON.stringify({ok:true,protocol:1,
      max_players:4,release_seat:true}));
    assert.equal(req.url,'/release-seat');
    assert.equal(req.method,'POST');
    const {room:code,token}=JSON.parse(await Array.fromAsync(req).then(chunks=>Buffer.concat(chunks).toString()));
    assert.equal(code,room);
    const index=slots.findIndex(slot=>slot.token===token);
    if(index>0){
      slots[index]=empty(index);
      for(const slot of slots)slot.ready=false;
      broadcast();
    }
    reply(res,200,'application/json',JSON.stringify({released:index>0}));
  });
  const hub=new WebSocketServer({server:http,path:'/ws'});
  hub.on('connection',peer=>{
    peer.on('message',data=>{
      const packet=JSON.parse(data.toString());
      const connected=peers.get(peer);
      if(connected){
        if(packet.op==='lobby_update'){
          Object.assign(connected,packet.patch);
          broadcast();
        }
        return;
      }
      const slot=packet.op==='create'?slots[0]:packet.op==='resume'
        ?slots.find(candidate=>candidate.token===packet.token):slots[packet.slot];
      if(!slot||packet.op==='join'&&(slot.token||packet.name==='拒绝连接')){
        peer.send(JSON.stringify({op:'error',code:'join_denied'}));
        return;
      }
      if(packet.op!=='resume'){
        slot.token=packet.seat_token??randomBytes(24).toString('base64url');
        slot.name=packet.name;
      }
      slot.enabled=true;
      slot.connected=true;
      peers.set(peer,slot);
      peer.send(JSON.stringify({op:'welcome',room,protocol:1,slot:slot.index,token:slot.token}));
      broadcast();
    });
    peer.once('close',()=>{
      const slot=peers.get(peer);
      peers.delete(peer);
      if(slot)slot.connected=false;
      broadcast();
    });
  });
  return {http,hub};
}

async function browserSocket(endpoint,ticket){
  const socket=new WebSocket(endpoint);
  const history=[];
  socket.on('message',data=>history.push(JSON.parse(data.toString())));
  await once(socket,'open');
  const send=packet=>socket.send(JSON.stringify(packet));
  send({op:'attach',room:ticket.room,seat:ticket.seat});
  async function waitFor(predicate,{after=0}={}){
    const signal=AbortSignal.timeout(3000);
    while(true){
      const found=history.slice(after).find(predicate);
      if(found)return found;
      await once(socket,'message',{signal});
    }
  }
  return {socket,history,send,waitFor};
}

test('Glorton joins by name or legacy code, preserves a refresh, and reclaims failed guest seats',async t=>{
  const native=nativeAuthority();
  const backend=await listen(native.http);
  const localWebRoot=fileURLToPath(new URL('../public/',import.meta.url));
  const rooms=createGlortonBrowserRooms({localWebRoot,serviceUrl:backend.replace(/^http/,'ws')+'/ws',
    isRoomNameTaken:name=>name==='existing'});
  const viewer=createServer(async (req,res)=>{
    if(!await rooms.handleHttp(req,res,req.url,(...args)=>reply(res,...args)))reply(res,404,'text/plain','Not Found');
  });
  viewer.on('upgrade',(req,socket,head)=>rooms.handleUpgrade(req,socket,head));
  const origin=await listen(viewer);
  t.after(async()=>{
    rooms.close();
    for(const peer of native.hub.clients)peer.terminate();
    await Promise.all([close(viewer),close(native.http)]);
  });
  const endpoint=origin.replace(/^http/,'ws')+GLORTON_BROWSER_SOCKET_PATH;
  async function post(path,body,status,code){
    const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify(body),signal:AbortSignal.timeout(4000)});
    const result=await response.json();
    assert.equal(response.status,status,JSON.stringify(result));
    if(code)assert.equal(result.error,code);
    return result;
  }

  const password='test-room';
  const create={roomName:'2333',name:'房主',password,capacity:2};
  await post(GLORTON_BROWSER_CREATE_PATH,{...create,roomName:' EXISTING '},409,'ROOM_NAME_TAKEN');
  const hostTicket=await post(GLORTON_BROWSER_CREATE_PATH,create,201);
  await post(GLORTON_BROWSER_CREATE_PATH,create,409,'ROOM_NAME_TAKEN');
  const host=await browserSocket(endpoint,hostTicket);
  await host.waitFor(packet=>packet.op==='welcome');
  assert.equal((await host.waitFor(packet=>packet.op==='state')).roomName,'2333');
  const pending=await post(GLORTON_BROWSER_JOIN_PATH,{room:' ２３３３ ',name:'加载中',password},200);
  assert.equal(pending.room,hostTicket.room);
  assert.equal(pending.roomName,'2333');
  assert.equal(rooms.listRooms()[0].occupied,1);
  assert.equal(rooms.listRooms()[0].available,true);
  const legacy=await post(GLORTON_BROWSER_JOIN_PATH,{room:hostTicket.room,name:'首位来宾',password},200);
  const guest=await browserSocket(endpoint,legacy);
  assert.equal((await guest.waitFor(packet=>packet.op==='welcome')).slot,1);
  const rejected=await browserSocket(endpoint,pending);
  assert.equal((await rejected.waitFor(packet=>packet.op==='error')).code,'ROOM_FULL');
  assert.equal(rooms.listRooms()[0].occupied,2);
  const resumed=await post(GLORTON_BROWSER_JOIN_PATH,{room:'2333',seat:legacy.seat,password},200);
  assert.equal(resumed.seat,legacy.seat);
  const reloaded=await browserSocket(endpoint,resumed);
  assert.equal((await reloaded.waitFor(packet=>packet.op==='welcome')).slot,1);
  const beforeReady=host.history.length;
  reloaded.send({op:'lobby_update',slot:1,patch:{fighter:'TrashPlayer',ready:true}});
  await host.waitFor(packet=>packet.op==='room_state'&&packet.slots[1].ready,{after:beforeReady});

  const beforeLeave=host.history.length;
  await post(GLORTON_BROWSER_LEAVE_PATH,{room:'2333',seat:legacy.seat},200);
  assert.equal(rooms.listRooms()[0].available,true);
  const vacancy=await host.waitFor(packet=>packet.op==='room_state'&&!packet.slots[1].enabled,{after:beforeLeave});
  assert.equal(vacancy.slots[1].name,'');
  assert.equal(vacancy.slots[1].fighter,'PeachPlayer');
  assert.equal(vacancy.slots[1].ready,false);

  const failedTicket=await post(GLORTON_BROWSER_JOIN_PATH,{room:'2333',name:'拒绝连接',password},200);
  const failedGuest=await browserSocket(endpoint,failedTicket);
  assert.equal((await failedGuest.waitFor(packet=>packet.op==='error')).code,'AUTHORITY_UNAVAILABLE');
  assert.equal(rooms.listRooms()[0].connected,1);
  assert.equal(rooms.listRooms()[0].available,true);
  const replacement=await post(GLORTON_BROWSER_JOIN_PATH,{room:'2333',name:'新来宾',password},200);
  const next=await browserSocket(endpoint,replacement);
  assert.equal((await next.waitFor(packet=>packet.op==='welcome')).slot,1);
  const joined=await next.waitFor(packet=>packet.op==='room_state'&&packet.slots[1].name==='新来宾');
  assert.equal(joined.slots[1].ready,false);
  assert.equal(joined.slots[1].fighter,'PeachPlayer');
  await post(GLORTON_BROWSER_LEAVE_PATH,{room:hostTicket.room,seat:legacy.seat},200);
  assert.equal(rooms.listRooms()[0].connected,2);
  await post(GLORTON_BROWSER_LEAVE_PATH,{room:'2333',seat:hostTicket.seat},200);
  assert.equal(rooms.listRooms().length,0);
});
