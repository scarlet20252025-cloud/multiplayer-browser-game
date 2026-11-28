import {randomBytes,randomInt,scrypt,timingSafeEqual} from 'node:crypto';
import {existsSync} from 'node:fs';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {promisify} from 'node:util';
import {WebSocket,WebSocketServer} from 'ws';
import {normalizeRoomName} from './room-registry.mjs';
import {createGlortonSyncMatch} from './glorton-sync-tunnel.mjs';

export const GLORTON_BROWSER_HEALTH_PATH='/glorton-online/browser-health';
export const GLORTON_BROWSER_CREATE_PATH='/glorton-online/rooms';
export const GLORTON_BROWSER_JOIN_PATH='/glorton-online/join';
export const GLORTON_BROWSER_LEAVE_PATH='/glorton-online/leave';
export const GLORTON_BROWSER_SOCKET_PATH='/glorton-online/browser-ws';
export const GLORTON_LOCAL_PLAY_PATH='/glorton-local/index.html';

const hashPassword=promisify(scrypt);
const alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const roomPattern=/^[A-HJ-NP-Z2-9]{6}$/;
const seatPattern=/^[A-Za-z0-9_-]{32}$/;
const phases=new Set(['waiting','lobby','playing','finished','ended']);
const jsonType='application/json; charset=utf-8';
const seatWait=50_000;
const reconnectWait=22_000; // The upstream authority preserves a disconnected playing seat for 25 seconds.
const attachWait=4500;
const idleLobbyWait=10*60_000;
const maxBody=2048;
const maxBrowserBuffer=16*1024;
const browserProbeInterval=1000;
const browserProbeExpiry=2500;
const maxRooms=3;
const maxSockets=16;
const maxAdmissions=8;
const maxPendingPerRoom=12;
const aliasKey=value=>value.normalize('NFKC').toLocaleLowerCase('en-US');

function problem(status,code,message){
  return Object.assign(Error(message),{status,code});
}

function readJson(req){
  if(!/^application\/json\b/i.test(req.headers['content-type']??'')){
    req.resume();
    throw problem(415,'INVALID_CONTENT_TYPE','请求需要使用 JSON 格式。');
  }
  return new Promise((resolve,reject)=>{
    const chunks=[];
    let size=0;
    const timer=setTimeout(()=>fail(problem(408,'REQUEST_TIMEOUT','提交超时，请重试。')),4000);
    timer.unref();
    function cleanup(){
      clearTimeout(timer);
      req.off('data',onData).off('end',onEnd).off('aborted',onAbort).off('error',onAbort);
    }
    function fail(error){cleanup();req.resume();reject(error);}
    function onAbort(){fail(problem(400,'REQUEST_ABORTED','提交已中断。'));}
    function onData(chunk){
      size+=chunk.length;
      if(size>maxBody){fail(problem(413,'REQUEST_TOO_LARGE','请求过大。'));return;}
      chunks.push(chunk);
    }
    function onEnd(){
      cleanup();
      try{
        const body=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
        if(!body||Array.isArray(body)||typeof body!=='object')throw Error();
        resolve(body);
      }catch{reject(problem(400,'INVALID_JSON','无法读取提交内容。'));}
    }
    req.on('data',onData).once('end',onEnd).once('aborted',onAbort).once('error',onAbort);
  });
}

function makePlayer(role,name,wait){
  return {role,name,token:randomBytes(24).toString('base64url'),socket:null,
    expiresAt:Date.now()+wait,paused:false};
}

function browserPhase(room){
  return room.ended?'ended':room.syncPhase??'waiting';
}

const isMatchPlayer=(room,player)=>!room.matchSeats||room.matchSeats.includes(player.role-1);
const roomPaused=room=>room.syncPaused===true||room.players.some(player=>
  player?.paused===true&&(browserPhase(room)!=='playing'||isMatchPlayer(room,player)));

function rosterFields(room){
  return room.automaticRoster?{automaticRoster:true,minimumPlayers:2}:{};
}

function expirationReason(room,now){
  const relevant=browserPhase(room)==='playing'
    ?room.players.filter(player=>player&&isMatchPlayer(room,player)):[room.players[0]];
  if(relevant.some(player=>player&&player.expiresAt!==null&&player.expiresAt<=now))
    return '玩家离线超过保留时间，房间已关闭。';
  if(browserPhase(room)!=='playing'&&room.activity+idleLobbyWait<=now)
    return '房间长时间没有操作，已关闭。';
  return null;
}

function publicRoom(room){
  const current=browserPhase(room);
  const phase=current==='playing'||current==='finished'?current:'select';
  const occupied=room.players.filter(Boolean).length;
  const connected=room.players.filter(player=>player?.socket?.readyState===WebSocket.OPEN).length;
  const paused=roomPaused(room);
  return {key:'glorton:'+room.id,gameId:'glorton',name:room.name,code:room.id,
    occupied,connected,capacity:room.players.length,participants:phase==='playing'?(room.matchSeats?.length??occupied):0,
    phase,available:phase==='select'&&occupied<room.players.length&&!room.players[0].paused,paused,...rosterFields(room)};
}

function send(socket,message){
  if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message),{binary:false},error=>{
    if(error)socket.terminate();
  });
}

export function createGlortonBrowserRooms({localWebRoot,viewerOrigins=[],isRoomNameTaken=()=>false,
  serviceUrl='ws://127.0.0.1:18746/ws'}={}){
  if(typeof localWebRoot!=='string'||!localWebRoot.trim())throw Error('Glorton browser build root is required');
  const authority=new URL(serviceUrl);
  if(authority.protocol!=='ws:'||authority.hostname!=='127.0.0.1'||authority.pathname!=='/ws'||
    authority.username||authority.password||authority.search||authority.hash)throw Error('Expected a loopback Glorton authority');
  const authorityHealth=new URL('/health',authority);
  authorityHealth.protocol='http:';
  const entry=path.resolve(localWebRoot,'index.html');
  const initialSeatWait=existsSync(path.resolve(localWebRoot,'provider-loader.mjs'))?160_000:seatWait;
  const origins=new Set(viewerOrigins.filter(Boolean).map(origin=>new URL(origin).origin));
  const acceptsOrigin=req=>!req.headers.origin||origins.has(req.headers.origin);
  const rooms=new Map();
  const names=new Map();
  const hub=new WebSocketServer({noServer:true,maxPayload:maxBody});
  let closing=false,admissions=0,healthPromise,healthCheckedAt=0;

  function listRooms(){
    if(closing)return [];
    const now=Date.now();
    for(const room of rooms.values())pruneGuests(room,now);
    return [...rooms.values()].filter(room=>!room.ended&&!expirationReason(room,now)).map(publicRoom);
  }

  function authorityFeatures(){
    if(closing)return Promise.resolve(null);
    const now=Date.now();
    if(healthPromise&&now-healthCheckedAt<2500)return healthPromise;
    healthCheckedAt=now;
    healthPromise=(async()=>{
      try{
        await access(entry);
        const response=await fetch(authorityHealth,{signal:AbortSignal.timeout(1300),redirect:'error'});
        if(!response.ok){await response.body?.cancel();return null;}
        const health=await response.json();
        if(health.ok!==true||health.protocol!==1)return null;
        const capacity=health.max_players;
        return {capacity:Number.isInteger(capacity)&&capacity>=2?Math.min(capacity,4):2,
          automaticRoster:health.automatic_roster===true};
      }catch{return null;}
    })();
    return healthPromise;
  }

  function state(room,player){
    return {op:'state',room:room.id,roomName:room.name,role:player.role,phase:browserPhase(room),
      capacity:room.players.length,
      connected:room.players.map(item=>item?.socket?.readyState===WebSocket.OPEN),
      ready:room.ready,paused:roomPaused(room),
      ...rosterFields(room),...(room.matchSeats?{match_slots:room.matchSeats}:{}),
      ...(room.ended?{message:room.endMessage}:{})};
  }

  function broadcast(room){
    for(const player of room.players)if(player?.socket)send(player.socket,state(room,player));
  }

  function endRoom(room,message){
    if(room.ended)return;
    room.ended=true;
    room.endMessage=message;
    room.deleteAt=Date.now()+1500;
    room.sync?.close();
    broadcast(room);
  }

  function releaseGuest(room,player){
    if(room.players[player.role-1]!==player)return;
    const socket=player.socket;
    player.socket=null;
    room.players[player.role-1]=null;
    room.ready=room.ready.map((ready,index)=>room.automaticRoster&&index!==player.role-1&&ready);
    room.activity=Date.now();
    void room.sync?.release(player.role);
    if(socket?.readyState===WebSocket.OPEN)socket.close(1000,'Seat released');
    broadcast(room);
  }

  function pruneGuests(room,now){
    for(const [token,player] of room.pending)if(player.expiresAt<=now)room.pending.delete(token);
    if(room.ended||browserPhase(room)==='playing')return;
    for(const player of room.players.slice(1)){
      if(player&&player.expiresAt!==null&&player.expiresAt<=now)releaseGuest(room,player);
    }
  }

  function attachLocalPlayer(room,player,socket,{frameAck,compactFrames}){
    room.sync??=createGlortonSyncMatch({
      serviceUrl:authority.href,
      capacity:room.players.length,
      automaticRoster:room.automaticRoster,
      onState(update){
        if(update.phase==='finished'&&browserPhase(room)!=='finished')room.activity=Date.now();
        if(phases.has(update.phase))room.syncPhase=update.phase;
        if(Array.isArray(update.ready))room.ready=update.ready;
        room.matchSeats=update.matchSeats;
        room.syncPaused=update.paused===true;
        broadcast(room);
      },
      onEnd(message){endRoom(room,message);},
      onError(){endRoom(room,'游戏连接已结束，请返回大厅。');},
      onSeatError(role){
        const failed=room.players[role-1];
        if(failed)releaseGuest(room,failed);
      },
    });
    const canSend=()=>player.socket===socket&&socket.readyState===WebSocket.OPEN&&socket.bufferedAmount<=maxBrowserBuffer;
    const attached=room.sync.attach(player.role,{name:player.name,frameAck,compactFrames,canSend,send(packet){
      if(!canSend())return false;
      send(socket,packet);
      return true;
    }});
    if(!attached){
      send(socket,{op:'error',code:'MATCH_STARTED',message:'对局已经开始，可以等下一局再加入。',fatal:true});
      releaseGuest(room,player);
      return;
    }
    if(frameAck)measureBrowserRoundTrip(room,player,socket,canSend);
  }

  function measureBrowserRoundTrip(room,player,socket,canSend){
    let probe=null,average=null;
    function sample(){
      if(!canSend())return;
      const now=performance.now();
      if(probe&&now-probe.readDoubleBE(0)<browserProbeExpiry)return;
      probe=Buffer.allocUnsafe(8);
      probe.writeDoubleBE(now);
      socket.ping(probe,error=>{if(error)socket.terminate();});
    }
    socket.on('pong',value=>{
      if(player.socket!==socket||!probe?.equals(value))return;
      const rtt=Math.max(0,performance.now()-probe.readDoubleBE(0));
      probe=null;
      average=average===null?rtt:average*0.8+rtt*0.2;
      room.sync.setRoundTrip(player.role,Math.max(rtt,average));
      if(canSend())send(socket,{op:'link_stats',rtt_ms:Math.round(average)});
    });
    const interval=setInterval(sample,browserProbeInterval);
    interval.unref();
    socket.once('close',()=>clearInterval(interval));
    sample();
  }

  function removeRoom(room){
    rooms.delete(room.id);
    if(names.get(room.nameKey)===room)names.delete(room.nameKey);
    room.sync?.close();
    for(const player of room.players)player?.socket?.terminate();
  }

  const expiry=setInterval(()=>{
    const now=Date.now();
    for(const room of rooms.values()){
      if(room.ended){if(room.deleteAt<=now)removeRoom(room);continue;}
      pruneGuests(room,now);
      const reason=expirationReason(room,now);
      if(reason)endRoom(room,reason);
    }
  },500);
  expiry.unref();

  function nextRoomCode(){
    let code;
    do{code=Array.from({length:6},()=>alphabet[randomInt(alphabet.length)]).join('');}
    while(rooms.has(code)||hasRoomName(code.toLowerCase())||isRoomNameTaken(code.toLowerCase()));
    return code;
  }

  function hasRoomName(key){
    const alias=aliasKey(key);
    const room=names.get(alias)??rooms.get(alias.toUpperCase());
    return Boolean(room&&!room.ended&&!expirationReason(room,Date.now()));
  }

  function resolveRoom(value){
    if(typeof value!=='string')return null;
    const code=value.normalize('NFKC').trim().toUpperCase();
    const byCode=roomPattern.test(code)?rooms.get(code):null;
    if(byCode&&!byCode.ended&&!expirationReason(byCode,Date.now()))return byCode;
    try{return names.get(aliasKey(normalizeRoomName(value).key))??null;}
    catch{return null;}
  }

  function playerByToken(room,value){
    if(typeof value!=='string'||!seatPattern.test(value))return null;
    const token=Buffer.from(value);
    return room.players.find(player=>player&&timingSafeEqual(Buffer.from(player.token),token))??room.pending.get(value)??null;
  }

  function admission(room,player){
    const params=new URLSearchParams({room:room.id,seat:player.token});
    return {ok:true,room:room.id,roomName:room.name,seat:player.token,role:player.role,capacity:room.players.length,renderMode:'local',
      playUrl:GLORTON_LOCAL_PLAY_PATH+'#'+params,...rosterFields(room)};
  }

  function normalizeName(value,role){
    const name=typeof value==='string'?value.replace(/\p{Cc}/gu,'').trim():'';
    return Array.from(name).slice(0,16).join('')||'玩家 '+role;
  }

  async function admit(req,create,features){
    const body=await readJson(req);
    if(typeof body.password!=='string'||body.password.length<4||body.password.length>64){
      throw problem(400,'INVALID_PASSWORD','房间密码需要 4–64 个字符。');
    }
    if(create){
      const automaticRoster=body.roster==='auto';
      if(body.roster!==undefined&&(!automaticRoster||body.capacity!==undefined))
        throw problem(400,'INVALID_ROSTER','房间人数设置无效。');
      if(automaticRoster&&!features.automaticRoster)
        throw problem(503,'ROSTER_UNAVAILABLE','等待联机房间服务升级后再试。');
      const requestedCapacity=body.capacity===undefined?2:body.capacity;
      const capacity=automaticRoster?features.capacity:requestedCapacity;
      if(!Number.isInteger(capacity)||capacity<2||capacity>4)
        throw problem(400,'INVALID_CAPACITY','房间人数需要在 2 到 4 人之间。');
      if(capacity>features.capacity)throw problem(503,'CAPACITY_UNAVAILABLE','联机服务暂时只支持 '+features.capacity+' 人房间。');
      let name;
      if(body.roomName!==undefined&&!(typeof body.roomName==='string'&&!body.roomName.trim())){
        try{name=normalizeRoomName(body.roomName);}
        catch(error){throw problem(400,error.code,error.message);}
      }
      const salt=randomBytes(16);
      const password=await hashPassword(body.password,salt,32);
      if(closing||Array.from(rooms.values()).filter(room=>!room.ended).length>=maxRooms){
        throw problem(503,'ROOM_LIMIT','房间暂时已满，请稍后再试。');
      }
      if(name&&(hasRoomName(name.key)||isRoomNameTaken(name.key)||isRoomNameTaken(aliasKey(name.key))))
        throw problem(409,'ROOM_NAME_TAKEN','这个房间名已被使用，请加入该房间或换个名字。');
      const player=makePlayer(1,normalizeName(body.name,1),initialSeatWait);
      const id=nextRoomCode();
      name??=normalizeRoomName(id);
      const players=Array(capacity).fill(null);
      players[0]=player;
      const room={id,name:name.display,nameKey:aliasKey(name.key),salt,password,players,automaticRoster,pending:new Map(),
        ready:Array(capacity).fill(false),activity:Date.now()};
      rooms.set(room.id,room);
      names.set(room.nameKey,room);
      return {result:admission(room,player),allocated:true};
    }
    const room=resolveRoom(body.room);
    if(!room||room.ended||expirationReason(room,Date.now()))throw problem(404,'ROOM_NOT_FOUND','房间不存在或已关闭。');
    const password=await hashPassword(body.password,room.salt,32);
    if(!timingSafeEqual(room.password,password))throw problem(403,'WRONG_PASSWORD','房间密码不正确。');
    if(closing||room.ended||rooms.get(room.id)!==room||expirationReason(room,Date.now()))
      throw problem(404,'ROOM_NOT_FOUND','房间不存在或已关闭。');
    pruneGuests(room,Date.now());
    const existing=playerByToken(room,body.seat);
    if(existing)return {result:admission(room,existing),allocated:false};
    if(browserPhase(room)==='playing')throw problem(409,'MATCH_STARTED','对局已经开始。');
    if(browserPhase(room)==='finished')throw problem(409,'MATCH_FINISHED','房间正在结算，请等待下一局。');
    if(room.players[0].paused)throw problem(409,'HOST_RECONNECTING','房主正在重连，请稍后再试。');
    const slot=room.players.indexOf(null);
    if(slot===-1)throw problem(409,'ROOM_FULL','房间人数已满。');
    if(room.pending.size>=maxPendingPerRoom)throw problem(503,'SERVER_BUSY','加入请求较多，请稍后再试。');
    const preferred=new Set([...room.pending.values()].map(item=>item.role));
    const unclaimed=room.players.findIndex((item,index)=>item===null&&!preferred.has(index+1));
    const role=(unclaimed===-1?slot:unclaimed)+1;
    const player=makePlayer(role,normalizeName(body.name,role),initialSeatWait);
    room.pending.set(player.token,player);
    room.activity=Date.now();
    return {result:admission(room,player),allocated:true};
  }

  function leave(room,player){
    if(room.ended||!player)return;
    if(room.pending.delete(player.token))return;
    if(player.role===1){endRoom(room,'房主已退出，房间已关闭。');return;}
    if(browserPhase(room)==='playing'&&isMatchPlayer(room,player)){endRoom(room,'玩家已退出，对局已结束。');return;}
    releaseGuest(room,player);
  }

  async function handleHttp(req,res,pathname,reply){
    const health=pathname===GLORTON_BROWSER_HEALTH_PATH;
    const create=pathname===GLORTON_BROWSER_CREATE_PATH;
    const release=pathname===GLORTON_BROWSER_LEAVE_PATH;
    if(!health&&!create&&!release&&pathname!==GLORTON_BROWSER_JOIN_PATH)return false;
    const respond=(status,data,headers)=>{if(!res.destroyed)reply(status,jsonType,JSON.stringify(data),headers);};
    try{
      if(!acceptsOrigin(req))throw problem(403,'FORBIDDEN','请从当前大厅打开游戏。');
      if(health){
        if(!['GET','HEAD'].includes(req.method))throw problem(405,'METHOD_NOT_ALLOWED','不支持此请求。');
        const ok=Boolean(await authorityFeatures());
        respond(ok?200:503,{ok,browser:true});
      }else{
        if(req.method!=='POST')throw problem(405,'METHOD_NOT_ALLOWED','不支持此请求。');
        if(release){
          const {room:reference,seat}=await readJson(req);
          const room=resolveRoom(reference);
          if(room)leave(room,playerByToken(room,seat));
          respond(200,{ok:true});
          return true;
        }
        if(admissions>=maxAdmissions)throw problem(503,'SERVER_BUSY','请求较多，请稍后再试。');
        admissions++;
        try{
          const features=await authorityFeatures();
          if(!features)throw problem(503,'RUNTIME_UNAVAILABLE','网页联机服务暂不可用。');
          const {result,allocated}=await admit(req,create,features);
          if(res.destroyed&&allocated){
            const room=rooms.get(result.room);
            if(room)leave(room,playerByToken(room,result.seat));
            return true;
          }
          respond(create?201:200,result);
        }finally{admissions--;}
      }
    }catch(error){
      req.resume();
      respond(error.status??500,{ok:false,error:error.code??'SERVER_ERROR',
        message:error.status?error.message:'服务暂时出错，请重试。'});
    }
    return true;
  }

  function connect(socket){
    let room,player,packetCount=0,packetResetAt=Date.now();
    const timer=setTimeout(()=>socket.close(1008,'Attach timeout'),attachWait);
    timer.unref();
    const reject=(code,message)=>{
      send(socket,{op:'error',code,message,fatal:true});
      if(player?.role>1&&player.socket===socket&&browserPhase(room)!=='playing')releaseGuest(room,player);
      socket.close(1008);
    };
    socket.on('error',()=>socket.terminate());
    socket.on('message',(data,binary)=>{
      const now=Date.now();
      if(now-packetResetAt>=1000){packetResetAt=now;packetCount=0;}
      if(binary||++packetCount>90)return reject('PROTOCOL_ERROR','收到过多操作，请重新进入房间。');
      let packet;
      try{packet=JSON.parse(data.toString());}catch{return reject('PROTOCOL_ERROR','无法读取房间消息。');}
      if(!packet||typeof packet!=='object')return reject('PROTOCOL_ERROR','无法读取房间消息。');
      if(!player){
        if(packet.op!=='attach'||typeof packet.room!=='string'||!roomPattern.test(packet.room)){
          return reject('PROTOCOL_ERROR','请使用大厅提供的房间链接。');
        }
        const requested=rooms.get(packet.room);
        if(!requested)return reject('ROOM_NOT_FOUND','房间不存在或已关闭。');
        if(requested.ended)return reject('ROOM_ENDED',requested.endMessage);
        if(expirationReason(requested,now))return reject('ROOM_NOT_FOUND','房间不存在或已关闭。');
        const admitted=playerByToken(requested,packet.seat);
        if(!admitted||(admitted.expiresAt!==null&&admitted.expiresAt<=now)){
          return reject('SEAT_EXPIRED','席位已失效，请返回大厅重新加入。');
        }
        if(requested.pending.delete(admitted.token)){
          pruneGuests(requested,now);
          if(browserPhase(requested)==='playing')return reject('MATCH_STARTED','房间已开始对局。');
          if(browserPhase(requested)==='finished')return reject('MATCH_FINISHED','房间正在结算，请等待下一局。');
          const preferred=admitted.role-1;
          const actual=requested.players[preferred]===null?preferred:requested.players.indexOf(null);
          if(actual===-1)return reject('ROOM_FULL','房间人数已满，请返回大厅。');
          admitted.role=actual+1;
          requested.players[actual]=admitted;
        }
        room=requested;
        player=admitted;
        const previous=player.socket;
        player.socket=socket;
        previous?.close(4001,'Replaced by a newer connection');
        player.expiresAt=null;
        player.paused=false;
        room.activity=now;
        clearTimeout(timer);
        broadcast(room);
        attachLocalPlayer(room,player,socket,{frameAck:packet.frame_ack===true,compactFrames:packet.compact_frames===true});
        return;
      }
      if(player.socket!==socket||room.ended)return;
      if(packet.op==='leave'){leave(room,player);return;}
      if(room.sync.receive(player.role,packet)&&['input','lobby_update','settings_update','map_vote','rematch'].includes(packet.op))room.activity=now;
    });
    socket.once('close',()=>{
      clearTimeout(timer);
      if(!player||player.socket!==socket)return;
      player.socket=null;
      if(room.ended)return;
      player.expiresAt=Date.now()+reconnectWait;
      player.paused=true;
      room.sync?.detach(player.role);
      broadcast(room);
    });
  }

  function handleUpgrade(req,socket,head){
    if(!acceptsOrigin(req)||req.method!=='GET'){
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    if(closing||hub.clients.size>=maxSockets){
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    hub.handleUpgrade(req,socket,head,connect);
  }

  return {listRooms,hasRoomName,handleHttp,handleUpgrade,close(){
    if(closing)return;
    closing=true;
    clearInterval(expiry);
    for(const room of rooms.values())removeRoom(room);
    for(const socket of hub.clients)socket.terminate();
    hub.close();
  }};
}
