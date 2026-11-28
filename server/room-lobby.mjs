/**
 * Loopback room matching service. Persistent room names live in a JSON registry;
 * each room owns its own game session and connection lifecycle.
 */
import http from 'node:http';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {WebSocket,WebSocketServer} from 'ws';
import {normalizeRoomName,RoomRegistry} from './room-registry.mjs';
import {DEFAULT_SEATS,RoomLobbyCore} from './room-lobby-core.mjs';
import {gameFor,loadGameCatalog,nextCatalogLevel,publicCatalog} from './game-catalog.mjs';
import {startHtml5ResearchRoom} from './html5-research-room.mjs';
import {startShanyiMirrorRoom} from './shanyi-mirror-room.mjs';
import {startShanyiNativeRoom} from './shanyi-native-room.mjs';
import {makeRoomCode,probeExternalRoom} from './external-game-server.mjs';
import {createLockstepMatch} from './lockstep-match.mjs';
import {
  BOMB_IT_DEFAULT_SETTINGS, BOMB_IT_MAPS, BOMB_IT_MODES, isBombItSettings, LOCKSTEP_RUNTIME,
} from '../public/lockstep/protocol.mjs';
import {ARENA_RUNTIME, ARENA_SOCKET} from '../public/tank-arena/rules.mjs';
import {createTankArenaMatch} from './tank-arena-match.mjs';
import {BRAWL_RUNTIME, BRAWL_SOCKET} from '../public/platform-brawl/rules.mjs';
import {createPlatformBrawlMatch} from './platform-brawl-match.mjs';
import {BVN33_RUNTIME} from './bvn33-room-service.mjs';
import {createRoomExpiration,roomOccupiesName} from './room-expiration.mjs';

const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const DEFAULT_ROOMS_FILE=path.join(REPO_ROOT,'local','data','rooms.json');
const MAX_BODY=8192;
const SESSION_START_TIMEOUT_MS=150000;
const SESSION_CONNECT_TIMEOUT_MS=150000;
const SESSION_EMPTY_GRACE_MS=5_000;
const SESSION_PEER_GRACE_MS=15_000;
const SPECTATOR_STATUS_TTL_MS=2_500;
const BOMB_IT_GAME='bomb-it-7';
const DEFAULT_BOMB_IT_OUTFIT=Object.freeze({clothId:0,hatId:0,expId:0});
const BOMB_IT_ROBOT_COUNT=8;
const BOMB_IT_SEAT_GRACE_MS=20_000;
const DEFAULT_BOMB_IT_SETTINGS=Object.freeze({...BOMB_IT_DEFAULT_SETTINGS,revision:0});

function initializeBombItMember(room,member){
  if(room.gameId!==BOMB_IT_GAME||Number.isInteger(member.bombItOutfit?.robotId))return;
  room.bombItHost??=member;
  const claimed=new Set(room.members.map(candidate=>candidate?.bombItOutfit?.robotId));
  let robotId=member.seat;
  if(claimed.has(robotId)){
    robotId=0;
    while(claimed.has(robotId))robotId++;
  }
  member.bombItOutfit={...DEFAULT_BOMB_IT_OUTFIT,...member.bombItOutfit,robotId};
}

function bombItHost(room){
  const host=room.bombItHost;
  if(host&&room.members[host.seat]===host)return host;
  return room.bombItHost=room.members.find(member=>member?.connected)??room.members.find(Boolean)??null;
}

const json=(res,status,body,headers={})=>{
  const text=JSON.stringify(body);
  res.writeHead(status,{'content-type':'application/json; charset=utf-8',
    'cache-control':'no-store','content-length':Buffer.byteLength(text),...headers});
  res.end(text);
};
const readBody=req=>new Promise((resolve,reject)=>{
  let size=0;const chunks=[];
  req.on('data',chunk=>{
    size+=chunk.length;
    if(size>MAX_BODY){reject(Object.assign(Error('BODY_TOO_LARGE'),{code:'BODY_TOO_LARGE'}));req.destroy();return;}
    chunks.push(chunk);
  });
  req.on('end',()=>{
    try{
      const text=Buffer.concat(chunks).toString('utf8');
      const value=text?JSON.parse(text):{};
      if(!value||typeof value!=='object'||Array.isArray(value))
        throw Object.assign(Error('BAD_JSON'),{code:'BAD_JSON'});
      resolve(value);
    }catch(error){reject(Object.assign(Error('BAD_JSON'),{code:'BAD_JSON'}));}
  });
  req.on('error',reject);
});
const statusFor=code=>{
  if(['ROOM_NOT_FOUND'].includes(code))return 404;
  if(['ROOM_PASSWORD_WRONG','TOKEN_INVALID'].includes(code))return 403;
  if(['ROOM_NAME_TAKEN','ROOM_FULL','ROOM_STARTING','ROOM_PLAYING','ROOM_GAME_LOCKED'].includes(code))return 409;
  if(['INTERNAL'].includes(code))return 500;
  return 400;
};

export async function startRoomLobby({
  port=8788,host='127.0.0.1',publicHost=null,publicPort=null,viewerOrigin='http://127.0.0.1:8787',
  gamesRoot,roomsFile=DEFAULT_ROOMS_FILE,catalog=null,registry=null,
  authorityPort=0,authorityPublicPort=null,mirrorPort=0,mirrorPublicPort=null,
  authorityFactory=startHtml5ResearchRoom,
  // html5-external：自带权威服务的游戏（如 TankTrouble 的 Colyseus）。大厅不
  // 启动它们，只拿地址拼 URL；进程由 startGameLobby / local/serve.mjs 管理。
  externalGameServers={},
  bvn33Service=null,
  arenaOnViewer=false,
  listAdditionalRooms=()=>[],
  hasAdditionalRoomName=()=>false,
}={}){
  if(!Number.isInteger(port)||port<0||port>65535||(port>0&&port<1024))throw Error('Invalid lobby port');
  const bindHost=typeof host==='string'?host.trim():'';
  if(!['127.0.0.1','localhost','0.0.0.0','::'].includes(bindHost)&&
     !/^(?:\d{1,3}\.){3}\d{1,3}$/.test(bindHost))
    throw Error('Lobby host must be a loopback or LAN bind address');
  const displayHost=typeof publicHost==='string'&&publicHost.trim()?publicHost.trim():bindHost;
  if(publicPort!==null&&(!Number.isInteger(publicPort)||publicPort<1||publicPort>65535))
    throw Error('Invalid public lobby port');
  let actualPort=null,displayPort=publicPort;
  let origin;
  try{origin=new URL(viewerOrigin);}catch{throw Error('Invalid viewer origin');}
  if(origin.protocol!=='http:'||!origin.hostname||origin.origin!==viewerOrigin)
    throw Error('Viewer origin must be an explicit HTTP origin');
  const viewerSocketOrigin=viewerOrigin.replace(/^http/,'ws');
  // 同一服务可能被本机回环和局域网地址同时访问，两种来源都放行
  const viewerPort=origin.port||'80';
  const viewerOrigins=[...new Set([viewerOrigin,
    `http://127.0.0.1:${viewerPort}`,`http://localhost:${viewerPort}`])];
  if(!catalog){
    if(typeof gamesRoot!=='string'||!gamesRoot.trim())throw Error('gamesRoot required');
    catalog=await loadGameCatalog({root:gamesRoot});
  }
  if(!registry){
    registry=new RoomRegistry({file:roomsFile});
    await registry.load();
  }
  const catalogIds=catalog.map(game=>game.id);
  await registry.migrateGameBindings(catalogIds);
  const lobby=new RoomLobbyCore({catalogIds,
    seats:DEFAULT_SEATS,
    seatsFor:gameId=>gameFor(catalog,gameId)?.seats??DEFAULT_SEATS,
    minSeatsFor:gameId=>gameFor(catalog,gameId)?.minSeats,
    seatGraceMsFor:gameId=>gameId===BOMB_IT_GAME?BOMB_IT_SEAT_GRACE_MS:undefined});
  const clients=new Set();
  const sessions=new Map();
  const reservedPorts=new Set();
  let closed=false,lastError=null;
  let server,wss;
  const expiration=createRoomExpiration({registry,catalog,
    isOccupied:key=>roomOccupiesName(lobby.roomFor(key),sessions.has(key)),
    onExpire:key=>lobby.rooms.delete(key)});
  await expiration.sweep();
  const logMaintenanceError=error=>{lastError=error.message;};

  const roomPayload=(room,viewerSeat=null)=>{
    const state=lobby.publicState(room,{saves:registry.saves(room.key),viewerSeat});
    if(room.gameId===BOMB_IT_GAME){
      state.bombItSettings={...(room.bombItSettings??DEFAULT_BOMB_IT_SETTINGS),
        hostSeat:bombItHost(room)?.seat??null,availableMaps:BOMB_IT_MAPS,availableModes:BOMB_IT_MODES};
      state.canStart=state.canStart&&room.members.every(member=>!member||member.connected);
      for(const entry of state.seats){
        const member=room.members[entry.seat];
        if(member){
          entry.outfit=member.bombItOutfit;
          entry.ready=member.bombItReady===true;
        }
      }
    }
    return state;
  };
  const unlistedGames=new Set(catalog.filter(game=>game.listed===false).map(game=>game.id));
  const gameAvailableInRoom=(gameId,room)=>!unlistedGames.has(gameId)||room?.boundGameId===gameId;
  const unavailableGame=()=>Object.assign(Error('此游戏暂未在大厅开放'),{code:'GAME_UNLISTED'});
  const catalogPayload=room=>publicCatalog(catalog.filter(game=>gameAvailableInRoom(game.id,room)),
    room?registry.saves(room.key):{});
  const send=(ws,value)=>{
    if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(value));
  };
  const broadcastState=room=>{
    const message=JSON.stringify({type:'state',room:roomPayload(room)});
    for(const member of room.members){
      if(member?.ws?.readyState===WebSocket.OPEN&&member.ws.bufferedAmount<256*1024)
        member.ws.send(message);
    }
  };
  const sendError=(room,code,message)=>{
    for(const member of room.members)send(member?.ws,{type:'lobby-error',code,message});
  };
  const sendWelcome=(room,member)=>{
    // A player returning from the game can rejoin explicitly from this room.
    send(member.ws,{type:'welcome',seat:member.seat,room:roomPayload(room,member.seat),
      games:catalogPayload(room)});
  };
  const isArenaTicket=ticket=>ticket?.matchPath===ARENA_SOCKET;
  const isBrawlTicket=ticket=>ticket?.matchPath===BRAWL_SOCKET;
  const isParticipantMatch=ticket=>isArenaTicket(ticket)||isBrawlTicket(ticket);
  const participantSeat=(ticket,member)=>ticket.matchPlayers.findIndex(player=>player?.member===member);
  const canReplaceArenaMember=ticket=>member=>participantSeat(ticket,member)<0;
  function admitArenaMember(ticket,member){
    const existing=participantSeat(ticket,member);
    if(existing>=0&&ticket.match.canAttach(existing))return existing;
    const seat=ticket.match.admitPlayer(member.displayName);
    if(seat===null)throw Object.assign(Error('当前对局没有空位'),{code:'ROOM_FULL'});
    ticket.matchPlayers[seat]={member,token:randomBytes(24).toString('hex')};
    return seat;
  }
  const sessionPayload=(room,member)=>{
    const session=room.session;
    const ticket=sessions.get(room.key);
    if(ticket?.authority?.launchUrls)
      return {launchUrl:ticket.authority.launchUrls[member.seat],gameId:session.gameId};
    if(isParticipantMatch(ticket)){
      const player=ticket.matchPlayers[participantSeat(ticket,member)];
      const query=new URLSearchParams({room:room.name,match:ticket.token.slice(0,16)});
      const fragment=new URLSearchParams({seat:player.token,ws:session.wsUrl});
      return {launchUrl:`${session.entryPath}?${query}#${fragment}`,gameId:session.gameId};
    }
    const matchSeat=ticket?.matchSeats?.indexOf(member.seat)??member.seat;
    const entryPath=session.entryPaths?.[member.seat]??session.entryPath;
    const matchTokens=ticket?.matchTokens;
    return {
      wsUrl:session.wsUrl,token:matchTokens?matchTokens[matchSeat]:session.token,gameId:session.gameId,
      levelId:session.levelId,entryPath,
      gameSha256:session.gameSha256,roomName:room.name,seat:matchSeat,
      ...(matchTokens?{lockstep:true}:{}),
      // external 游戏（TankTrouble）需要房间码；其余运行时为 null。
      roomCode:session.roomCode??null,
    };
  };

  function allocatePorts(ticket,port,publicPort){
    const reservation=port||publicPort;
    if(!reservation)return {port:0,publicPort:null};
    if(reservedPorts.has(reservation)){
      ticket.proxy=publicPort!==null;
      return {port:0,publicPort:null};
    }
    ticket.reservedPort=reservation;
    reservedPorts.add(reservation);
    return {port,publicPort};
  }

  async function closeTicket(ticket){
    if(ticket.releasing)return ticket.releasing;
    ticket.releasing=(async()=>{
      try{
        const authority=ticket.authority??await ticket.startup?.catch(()=>null);
        await (ticket.match??authority)?.close();
      }
      finally{if(ticket.reservedPort)reservedPorts.delete(ticket.reservedPort);}
    })();
    return ticket.releasing;
  }

  /**
   * 按席位生成 external 游戏的进场地址：P1 负责建房（tank=create），其余席位
   * 用同一个房间码加入（tank=join）。房间码写在 URL 里，两端必须一致。
   */
  function externalEntryPaths(game,roomCode,wsUrl,seatCount=null){
    const base=game.entryPath;
    const seats=Number.isInteger(seatCount)&&seatCount>0?seatCount:(game.seats??DEFAULT_SEATS);
    const paths=[];
    for(let seat=0;seat<seats;seat++){
      const action=seat===0?'create':'join';
      paths.push(`${base}?${new URLSearchParams({tank:action,code:roomCode,ws:wsUrl})}`);
    }
    return paths;
  }

  /**
   * external 游戏的「ticket.authority」是个轻量对象：真正干活的服务进程是共享
   * 的，不能随单个会话关闭；这里只在服务不可达时报错，并负责挑一个未被占用的
   * 房间码。
   */
  async function startExternalTicket({game,ticket}){
    const server=externalGameServers[game.id];
    if(!server||typeof server.httpUrl!=='string')
      throw Object.assign(Error(`${game.title??game.id} 的游戏服务未配置`),
        {code:'EXTERNAL_SERVER_UNCONFIGURED'});
    if(server.start)return server.start({game,roomName:ticket.room.name});
    const localUrl=server.localUrl??server.httpUrl;
    const publicUrl=server.publicUrl??server.httpUrl;
    // 先确认服务活着：直接给玩家一个打不开的页面比报错更糟。
    let health;
    try{
      health=await fetch(localUrl.replace(/\/$/,'')+'/health',
        {signal:AbortSignal.timeout(3000)}).then(response=>response.json());
    }catch{
      throw Object.assign(Error(`${game.title??game.id} 的游戏服务没有运行（${publicUrl}）`),
        {code:'EXTERNAL_SERVER_UNAVAILABLE'});
    }
    if(health?.ok===false)
      throw Object.assign(Error(`${game.title??game.id} 的游戏服务状态异常`),
        {code:'EXTERNAL_SERVER_FAILED'});
    // 挑一个当前没被占用的房间码，避免和残留房间撞号。查询失败要单独报错，
    // 不能当成「房间不存在」一路试到「房间码耗尽」，那会把服务故障伪装成重试问题。
    let roomCode=null;
    for(let attempt=0;attempt<8&&!roomCode;attempt++){
      const candidate=makeRoomCode();
      let probe;
      try{probe=await probeExternalRoom(localUrl,candidate);}
      catch{
        throw Object.assign(Error(`${game.title??game.id} 的游戏服务无法查询房间（${publicUrl}）`),
          {code:'EXTERNAL_ROOM_PROBE_FAILED'});
      }
      if(!probe.found)roomCode=candidate;
    }
    if(!roomCode)
      throw Object.assign(Error('无法分配游戏房间码，请稍后重试'),
        {code:'EXTERNAL_ROOM_CODE_EXHAUSTED'});
    ticket.external=true;
    return Object.freeze({url:publicUrl,localUrl,publicUrl,roomCode,servedSha256:null,
      sourceSha256:null,close(){}});
  }

  async function startSession(room,proposal){
    const game=gameFor(catalog,proposal.gameId);
    if(!game)throw Object.assign(Error('未接入这个游戏'),{code:'GAME_UNKNOWN'});
    if(!game.levels.some(level=>level.id===proposal.levelId))
      throw Object.assign(Error('关卡无效'),{code:'LEVEL_INVALID'});
    if(closed||sessions.has(room.key))return;
    const participants=lobby.connectedMembers(room);
    if(!lobby.canStart(room,game.id))
      throw Object.assign(Error('在线玩家人数不足'),{code:'NEED_TWO_PLAYERS'});
    const token=randomBytes(24).toString('hex');
    const ticket={room,game,levelId:proposal.levelId,token,authority:null,
      startedAt:Date.now(),sawBoth:false,sawAny:false,wonSaved:null,
      roomCode:null,external:game.runtime==='html5-external',bvn33:game.runtime===BVN33_RUNTIME,
      participantCount:participants.length};
    sessions.set(room.key,ticket);
    broadcastState(room);
    if([LOCKSTEP_RUNTIME,ARENA_RUNTIME,BRAWL_RUNTIME].includes(game.runtime)){
      const tankArena=game.runtime===ARENA_RUNTIME;
      const brawl=game.runtime===BRAWL_RUNTIME;
      if(tankArena||brawl)ticket.matchPlayers=participants.map(member=>({member,token:randomBytes(24).toString('hex')}));
      else{
        ticket.matchSeats=participants.map(member=>member.seat);
        ticket.matchTokens=participants.map(()=>randomBytes(24).toString('hex'));
      }
      ticket.matchPath=brawl?BRAWL_SOCKET:tankArena?ARENA_SOCKET:'/lockstep';
      const createMatch=brawl?createPlatformBrawlMatch:tankArena?createTankArenaMatch:createLockstepMatch;
      try{
        ticket.match=createMatch({levelId:proposal.levelId,playerCount:participants.length,tickRate:game.tickRate,
          playerNames:participants.map(member=>member.displayName),onEnd:reason=>endSession(ticket,reason),
          ...(game.id===BOMB_IT_GAME&&game.runtime===LOCKSTEP_RUNTIME?{
            playerOutfits:participants.map(member=>member.bombItOutfit),
            bombItSettings:proposal.bombItSettings,
          }:{}),
          ...(ticket.matchPlayers?{onSeatDropped:seat=>{
            ticket.matchPlayers[seat]=null;
            if(sessions.get(room.key)===ticket)broadcastState(room);
          }}:{})});
        lobby.startSession(room,{gameId:game.id,levelId:proposal.levelId,
          wsUrl:brawl||game.runtime===LOCKSTEP_RUNTIME||(tankArena&&arenaOnViewer)?viewerSocketOrigin+ticket.matchPath:`ws://${displayHost}:${displayPort}${ticket.matchPath}`,
          token,entryPath:game.entryPath});
        for(const member of participants)
          send(member.ws,{type:'session-start',session:sessionPayload(room,member)});
        broadcastState(room);
      }catch(error){
        sessions.delete(room.key);
        await closeTicket(ticket);
        throw error;
      }
      return;
    }
    let startTimer;
    try{
      const startPromise=(ticket.bvn33
        ? (bvn33Service?.start({roomName:room.name,lobbyOrigin:viewerOrigin,
          playerNames:room.members.map(member=>member.displayName)})??
          Promise.reject(Error('BVN 3.3 服务未配置')))
        : game.runtime==='shanyi-native'
        ? startShanyiNativeRoom({
          levelPath: path.join(REPO_ROOT, 'public', 'shanyi-native', 'level-1.json'),
          ...allocatePorts(ticket, mirrorPort, mirrorPublicPort), bindHost,
        })
        : game.runtime==='flash-ruffle'
        ? startShanyiMirrorRoom({
          levelId:proposal.levelId,gameId:game.id,seats:game.seats??DEFAULT_SEATS,
          ...allocatePorts(ticket,mirrorPort,mirrorPublicPort),allowedViewerOrigins:viewerOrigins,wsToken:token,
          bindHost,publicHost:displayHost,
        })
        : game.runtime==='html5-external'
        ? startExternalTicket({game,ticket,proposal})
        : authorityFactory({
          root:gamesRoot,script:game.script,requireScript:game.requireScript,
          entryPath:game.entryPath,levelId:proposal.levelId,
          templeId:game.templeId,storagePrefix:game.storagePrefix,gameId:game.id,
          seats:game.seats??DEFAULT_SEATS,
          ...allocatePorts(ticket,authorityPort,authorityPublicPort),allowedViewerOrigins:viewerOrigins,wsToken:token,
          bindHost,publicHost:displayHost,
        }));
      ticket.startup=startPromise;
      const authority=await Promise.race([
        startPromise,
        new Promise((_,reject)=>{startTimer=setTimeout(()=>{
          reject(Object.assign(Error('游戏启动超时'),{code:'SESSION_START_TIMEOUT'}));
        },SESSION_START_TIMEOUT_MS);startTimer.unref();}),
      ]);
      ticket.authority=authority;
      if(closed||sessions.get(room.key)!==ticket){
        await closeTicket(ticket).catch(()=>{});
        return;
      }
      ticket.roomCode=authority.roomCode??null;
      // external 游戏自己管 ws 地址（TankTrouble 用 ?ws=），不能套 /ws 后缀。
      const wsUrl=ticket.bvn33?authority.wsUrl:ticket.external
        ?authority.publicUrl.replace(/^http/,'ws')
        :ticket.proxy?`ws://${displayHost}:${displayPort}/ws`
        :authority.url.replace(/^http/,'ws')+'/ws';
      const entryPaths=ticket.external&&!authority.launchUrls
        ?externalEntryPaths(game,authority.roomCode,wsUrl,room.members.length)
        :null;
      ticket.startedAt=Date.now();
      lobby.startSession(room,{gameId:game.id,levelId:proposal.levelId,
        wsUrl,token,entryPath:game.entryPath,
        ...(entryPaths?{entryPaths}:{}),
        ...(authority.roomCode?{roomCode:authority.roomCode}:{})});
      room.session.gameSha256=authority.servedSha256??authority.sourceSha256??null;
      if(game.capabilities?.save===true)
        await registry.setSave(room.key,game.id,{levelId:proposal.levelId});
      for(const member of room.members){
        if(member?.connected)
          send(member.ws,{type:'session-start',session:sessionPayload(room,member)});
      }
      broadcastState(room);
    }catch(error){
      if(sessions.get(room.key)!==ticket)return;
      lastError=error.message;
      sessions.delete(room.key);
      lobby.failStart(room);
      sendError(room,error.code??'SESSION_START_FAILED',error.message);
      broadcastState(room);
      void closeTicket(ticket).catch(()=>{});
    }finally{
      clearTimeout(startTimer);
    }
  }

  async function readSession(ticket){
    const authority=ticket.authority;
    if(authority.launchUrls){
      const info=await authority.status();
      return {count:info.players.filter(Boolean).length,failed:info.state==='error',
        watchable:ticket.bvn33&&info.watchable===true&&info.players.every(Boolean)};
    }
    const base=authority.localUrl??authority.url;
    if(ticket.external){
      const probe=await probeExternalRoom(base,ticket.roomCode);
      return {count:probe.playerCount,ended:ticket.sawAny&&!probe.found};
    }
    const response=await fetch(base+'/health',{signal:AbortSignal.timeout(2000)});
    if(!response.ok)throw Error('Authority health check failed');
    const health=await response.json();
    return {count:health.room?.connected?.filter(Boolean).length??0,
      failed:health.failed, won:health.room?.suspendedReason==='LEVEL_WON'};
  }

  async function checkSession(ticket){
    const {room,authority}=ticket;
    if(!authority||ticket.checking||!room.session)return;
    ticket.checking=true;
    try{
      let state;
      try{state=await readSession(ticket);}
      catch(error){
        ticket.watchableUntil=0;
        if(error.status===404)endSession(ticket,'SESSION_ENDED');
        else if((ticket.healthFailures=(ticket.healthFailures??0)+1)>=8)
          endSession(ticket,'AUTHORITY_UNREACHABLE');
        return;
      }
      if(sessions.get(room.key)!==ticket)return;
      ticket.healthFailures=0;
      if(state.ended){endSession(ticket,'PLAYERS_LEFT');return;}
      if(state.failed){endSession(ticket,'AUTHORITY_FAILED');return;}
      ticket.watchableUntil=state.watchable?performance.now()+SPECTATOR_STATUS_TTL_MS:0;
      const now=Date.now();
      if(state.count>0){ticket.sawAny=true;ticket.emptySince=null;}
      else ticket.emptySince??=now;
      if(state.count>=room.members.length){
        ticket.sawBoth=true;ticket.missingSince=null;lobby.markBothSeen(room);
      }else ticket.missingSince??=now;

      if((ticket.sawAny||ticket.returned)&&ticket.emptySince!==null&&
          now-ticket.emptySince>=SESSION_EMPTY_GRACE_MS){
        endSession(ticket,'PLAYERS_LEFT');return;
      }
      if(ticket.sawBoth&&ticket.missingSince!==null&&now-ticket.missingSince>=SESSION_PEER_GRACE_MS){
        endSession(ticket,'PLAYERS_LEFT');return;
      }
      if(!ticket.sawBoth&&now-ticket.startedAt>=(authority.connectTimeoutMs??SESSION_CONNECT_TIMEOUT_MS)){
        endSession(ticket,'SESSION_CONNECT_TIMEOUT');return;
      }
      if(ticket.game.capabilities?.save===true&&state.won&&ticket.wonSaved!==room.session.levelId){
        const levelId=room.session.levelId;
        const next=nextCatalogLevel(ticket.game,levelId);
        if(!next.complete&&next.next)await registry.setSave(room.key,ticket.game.id,{levelId:next.next.id});
        ticket.wonSaved=levelId;
      }
    }finally{ticket.checking=false;}
  }

  function endSession(ticket,reason){
    const {room}=ticket;
    if(sessions.get(room.key)!==ticket)return;
    sessions.delete(room.key);
    if(!lobby.stopSession(room,reason))lobby.failStart(room);
    broadcastState(room);
    for(const member of room.members)
      send(member?.ws,{type:'session-ended',reason});
    void closeTicket(ticket).catch(()=>{});
  }

  function startConfirmedSession(room,proposal){
    void startSession(room,proposal).catch(error=>{
      lastError=error.message;lobby.failStart(room);
      sendError(room,error.code??'SESSION_START_FAILED',error.message);
      broadcastState(room);
    });
  }

  function tryStartBombIt(room){
    if(room.gameId!==BOMB_IT_GAME||room.phase!=='select'||!lobby.canStart(room)||
        room.members.some(member=>member&&(!member.connected||!member.bombItReady)))return;
    const {mapId,modeId}=room.bombItSettings??DEFAULT_BOMB_IT_SETTINGS;
    room.phase='starting';
    for(const member of room.members)if(member)member.bombItReady=false;
    startConfirmedSession(room,{gameId:BOMB_IT_GAME,levelId:gameFor(catalog,BOMB_IT_GAME).levels[0].id,
      bombItSettings:{mapId,modeId}});
  }

  const monitor=setInterval(()=>{
    for(const ticket of sessions.values())void checkSession(ticket).catch(error=>{lastError=error.message;});
    for(const room of lobby.sweep()){
      broadcastState(room);
      tryStartBombIt(room);
    }
  },1000);
  monitor.unref();
  const sweeper=setInterval(()=>{
    void expiration.sweep().catch(logMaintenanceError);
  },5000);
  sweeper.unref();

  const corsBase={
    'access-control-allow-methods':'GET,POST,OPTIONS',
    'access-control-allow-headers':'content-type',
    'vary':'Origin',
  };
  const corsFor=req=>({...corsBase,'access-control-allow-origin':req.headers.origin??viewerOrigin});
  // A single lobby may be reached through loopback, a LAN address and a
  // reverse-proxy/FRP public address. CORS is not the credential boundary
  // (every mutating call still requires the room token), so accept any origin
  // whose host is this machine / a private address / the advertised host, or
  // whose port is the viewer port (local or published, which is lobby-1).
  const originAllowed=req=>{
    const value=req.headers.origin;
    if(!value)return true;
    try{
      const parsed=new URL(value);
      if(parsed.protocol!=='http:')return false;
      const hostname=parsed.hostname;
      const trustedHost=hostname===displayHost||hostname==='localhost'||
        hostname==='127.0.0.1'||/^10\./.test(hostname)||/^192\.168\./.test(hostname)||
        /^172\.(1[6-9]|2\d|3[01])\./.test(hostname);
      if(trustedHost)return true;
      // Viewer and lobby sit on adjacent ports (8787/8788, 10011/10012). The
      // browser sends the lobby Host header, so accept an Origin on the same
      // host whose port is the adjacent viewer port.
      const requestHost=String(req.headers.host??'').replace(/:\d+$/,'');
      const originPort=Number(parsed.port||'80');
      const requestPort=Number(String(req.headers.host??'').replace(/^[^:]+:/,''));
      if(hostname===requestHost&&Number.isInteger(requestPort)&&
         (originPort===requestPort||originPort===requestPort-1))
        return true;
      const port=parsed.port||'80';
      const allowedPorts=new Set([viewerPort,String(actualPort??''),String(displayPort??''),
        String(Number.isInteger(actualPort)?actualPort-1:''),
        String(Number.isInteger(displayPort)?displayPort-1:'')]);
      return allowedPorts.has(port);
    }catch{return false;}
  };

  function proxyGameSocket(ticket,req,socket,head){
    const target=new URL(req.url,ticket.authority.localUrl??ticket.authority.url);
    const request=http.request(target,{agent:false,headers:{...req.headers,host:target.host}});
    socket.pause();
    socket.on('error',()=>socket.destroy());
    socket.once('close',()=>request.destroy());
    request.setTimeout(5000,()=>request.destroy());
    request.once('error',()=>socket.destroy());
    request.once('response',response=>{
      response.resume();
      socket.end(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\nConnection: close\r\n\r\n`);
    });
    request.once('upgrade',(response,upstream,upstreamHead)=>{
      if(socket.destroyed){upstream.destroy();return;}
      upstream.setTimeout(0);
      upstream.on('error',()=>socket.destroy());
      upstream.once('close',()=>socket.destroy());
      socket.once('close',()=>upstream.destroy());
      const headers=[];
      for(let index=0;index<response.rawHeaders.length;index+=2)
        headers.push(`${response.rawHeaders[index]}: ${response.rawHeaders[index+1]}`);
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers.join('\r\n')}\r\n\r\n`);
      if(upstreamHead.length)socket.write(upstreamHead);
      if(head.length)upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    request.end();
  }

  const sessionSummaries=()=>[...sessions.values()].map(ticket=>({
    room:ticket.room.name,game:ticket.game.id,levelId:ticket.levelId,
  }));
  const canRequestSpectator=ticket=>!closed&&ticket?.bvn33&&ticket.room.phase==='playing'&&
    typeof ticket.authority?.watch==='function';

  async function handleHttp(req,res){
    const cors=corsFor(req);
    try{
      const pathname=new URL(req.url,'http://'+host).pathname;
      if(req.method==='OPTIONS'){
        res.writeHead(204,cors);res.end();return;
      }
      if(!originAllowed(req))return json(res,403,{error:'ORIGIN_FORBIDDEN'},cors);
      if(req.method==='GET'&&pathname==='/health'){
        const activeSessions=sessionSummaries();
        return json(res,200,{ok:true,kind:'loopback-room-lobby',rooms:lobby.rooms.size,
          activeSession:activeSessions[0]??null,activeSessions,lastError},cors);
      }
      if(req.method==='GET'&&pathname==='/api/games')
        return json(res,200,{games:catalogPayload()},cors);
      if(req.method==='GET'&&pathname==='/api/rooms'){
        const rooms=registry.list().map(info=>{
          const live=lobby.roomFor(info.key);
          const ticket=sessions.get(info.key);
          const members=live?.members??[];
          const gameId=info.gameId??live?.gameId??null;
          const capacity=live?.members.length??lobby.capacityForGame(gameId);
          const occupied=members.filter(Boolean).length;
          const connected=members.filter(member=>member?.connected===true).length;
          const midMatch=live?.phase==='playing'&&isArenaTicket(ticket);
          const available=midMatch
            ?ticket.match.canAdmitPlayer()&&lobby.nextMemberSeat(live,canReplaceArenaMember(ticket))>=0
            :!live||live.phase==='select'&&lobby.nextMemberSeat(live)>=0;
          const participants=ticket?.matchPlayers?.filter(Boolean).length??ticket?.participantCount??0;
          const spectatable=Boolean(canRequestSpectator(ticket)&&ticket.watchableUntil>performance.now());
          return {...info,gameId,...(unlistedGames.has(gameId)?{listed:false}:{}),
            occupied,connected,capacity,participants,available,midMatch,
            spectatable,phase:live?.phase??null};
        });
        return json(res,200,{rooms:[...rooms,...listAdditionalRooms()]},cors);
      }
      if(req.method==='POST'&&pathname==='/api/rooms/spectate'){
        const {name,password,nickname}=await readBody(req);
        const roomInfo=await registry.authenticate({name,password});
        if(!roomInfo)return json(res,404,{error:'ROOM_NOT_FOUND'},cors);
        const ticket=sessions.get(roomInfo.key);
        const unavailable=()=>json(res,409,{error:'ROOM_NOT_WATCHABLE',message:'当前对局暂不可观战'},cors);
        if(!canRequestSpectator(ticket))return unavailable();
        const origin=req.headers.origin;
        const lobbyOrigin=viewerOrigins.includes(origin)?origin:viewerOrigin;
        try{
          const {launchUrl}=await ticket.authority.watch({displayName:nickname,lobbyOrigin});
          if(sessions.get(roomInfo.key)!==ticket||!canRequestSpectator(ticket))return unavailable();
          return json(res,200,{launchUrl},cors);
        }catch(error){
          if(error.status===404||error.status===409){
            ticket.watchableUntil=0;
            return unavailable();
          }
          return json(res,503,{error:'SPECTATE_UNAVAILABLE',message:'观战服务暂不可用，请稍后重试'},cors);
        }
      }
      if(req.method==='POST'&&(pathname==='/api/rooms'||pathname==='/api/rooms/join')){
        const body=await readBody(req);
        const created=pathname==='/api/rooms';
        const requestedGame=body.gameId===undefined?null:gameFor(catalog,body.gameId);
        if(body.gameId!==undefined&&!requestedGame)
          throw Object.assign(Error('未接入这个游戏'),{code:'GAME_UNKNOWN'});
        if(created&&!gameAvailableInRoom(requestedGame?.id))throw unavailableGame();
        if(created&&hasAdditionalRoomName(normalizeRoomName(body.name).key))
          throw Object.assign(Error('这个房间名已被使用，请换一个'),{code:'ROOM_NAME_TAKEN'});
        const roomInfo=created
          ?await registry.create({name:body.name,password:body.password,gameId:requestedGame?.id})
          :await registry.authenticate({name:body.name,password:body.password});
        if(!roomInfo){return json(res,404,{error:'ROOM_NOT_FOUND'},cors);}
        const room=lobby.ensureRoom(roomInfo.key,{name:roomInfo.name,boundGameId:roomInfo.gameId});
        if(requestedGame)lobby.requireGame(room,requestedGame.id);
        const ticket=sessions.get(room.key);
        const activeArena=room.phase==='playing'&&isArenaTicket(ticket);
        const member=lobby.addMember(roomInfo.key,{name:roomInfo.name,
          canReplaceActiveMember:activeArena?canReplaceArenaMember(ticket):undefined});
        initializeBombItMember(room,member);
        let session;
        if(activeArena){
          try{
            lobby.setProfile(member.token,body.profile??{});
            admitArenaMember(ticket,member);
            session=sessionPayload(room,member);
          }catch(error){
            lobby.leave(member.token,{releaseDuringPlay:true});
            const seat=participantSeat(ticket,member);
            if(seat>=0)ticket.match.leaveSeat(seat);
            throw error;
          }
        }
        if(activeArena||room.gameId===BOMB_IT_GAME)broadcastState(room);
        void expiration.sync(room.key).catch(logMaintenanceError);
        return json(res,created?201:200,{token:member.token,seat:member.seat,
          room:roomPayload(room,member.seat),games:catalogPayload(room),...(session?{session}:{})},cors);
      }
      return json(res,404,{error:'NOT_FOUND'},cors);
    }catch(error){
      const code=error.code??'REJECTED';
      json(res,statusFor(code),{error:code,message:error.message},cors);
    }
  }
  server=http.createServer(handleHttp);

  const wssLobby=new WebSocketServer({noServer:true,maxPayload:8192,perMessageDeflate:false});
  wss=wssLobby;

  function upgradeMatch(req,socket,head,pathname,token){
    const socketSeat=ticket=>isParticipantMatch(ticket)
      ?ticket.matchPlayers.findIndex(player=>player?.token===token):ticket.matchTokens.indexOf(token);
    const ticket=[...sessions.values()].find(ticket=>ticket.matchPath===pathname&&socketSeat(ticket)>=0);
    const seat=ticket?socketSeat(ticket):-1;
    if(closed||!ticket?.match?.canAttach(seat))return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    wssLobby.handleUpgrade(req,socket,head,ws=>ticket.match.attach(ws,seat));
  }

  function handleArenaViewerUpgrade(req,socket,head){
    if(req.method!=='GET'||req.headers.host!==origin.host||req.headers.origin!==viewerOrigin||
       closed)
      return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    const url=new URL(req.url,viewerOrigin);
    if(url.pathname==='/lobby')return upgradeLobby(req,socket,head,url);
    if(url.pathname===ARENA_SOCKET&&!arenaOnViewer)
      return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    if(![ARENA_SOCKET,BRAWL_SOCKET,'/lockstep'].includes(url.pathname))return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    upgradeMatch(req,socket,head,url.pathname,url.searchParams.get('token'));
  }

  function upgradeLobby(req,socket,head,url){
    const token=url.searchParams.get('token');
    const chatOnly=url.searchParams.get('presence')==='chat';
    wssLobby.handleUpgrade(req,socket,head,ws=>wssLobby.emit('connection',ws,{token,chatOnly}));
  }

  server.on('upgrade',(req,socket,head)=>{
    let url;
    try{url=new URL(req.url,'http://'+host);}catch{return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');}
    const h=String(req.headers.host??''),hostname=h.replace(/:\d+$/,'');
    const hostOkay=[displayHost,'127.0.0.1','localhost'].includes(hostname)&&
      h.endsWith(':'+(displayPort??actualPort));
    const token=url.searchParams.get('token');
    if(url.pathname==='/ws'){
      const ticket=[...sessions.values()].find(ticket=>ticket.proxy&&ticket.token===token);
      if(!hostOkay||closed||!originAllowed(req)||!ticket?.authority)
        return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      proxyGameSocket(ticket,req,socket,head);
      return;
    }
    if(['/lockstep',ARENA_SOCKET,BRAWL_SOCKET].includes(url.pathname)){
      if(!hostOkay||!viewerOrigins.includes(req.headers.origin))
        return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      upgradeMatch(req,socket,head,url.pathname,token);
      return;
    }
    if(url.pathname!=='/lobby'||!hostOkay||!originAllowed(req)||closed)
      return socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    upgradeLobby(req,socket,head,url);
  });
  wssLobby.on('connection',(ws,{token,chatOnly})=>{
    ws.on('error',()=>{});
    let attached;
    try{attached=lobby.attach(token,ws);}
    catch(error){
      // A failed HTTP upgrade hides the reason from the browser. Report seat
      // rejection before closing so it can stop retrying a stale credential.
      send(ws,{type:'lobby-error',code:error.code??'LOBBY_TOKEN_INVALID',message:error.message});
      ws.close(4003,'token-rejected');
      return;
    }
    clients.add(ws);ws.alive=true;ws.on('pong',()=>{ws.alive=true;});
    const {room,member}=attached;
    ws.room=room;ws.member=member;
    void expiration.sync(room.key).catch(logMaintenanceError);
    const ticket=sessions.get(room.key);
    // The game opens its chat socket before the players finish loading.
    if(ticket&&room.phase==='playing'&&!chatOnly)ticket.returned=true;
    sendWelcome(room,member);broadcastState(room);
    if(!chatOnly&&room.gameId===BOMB_IT_GAME&&ticket?.matchPath==='/lockstep'&&
        ticket.match.canAttach(ticket.matchSeats.indexOf(member.seat)))
      send(ws,{type:'session-start',session:sessionPayload(room,member)});
    else if(!chatOnly)tryStartBombIt(room);
    ws.on('close',()=>{
      clients.delete(ws);
      const result=lobby.detach(ws);
      if(result)broadcastState(result.room);
    });
    ws.on('message',async buffer=>{
      if(member.ws!==ws)return;
      let msg;
      try{msg=JSON.parse(buffer.toString());}
      catch{return send(ws,{type:'lobby-error',code:'BAD_JSON'});}
      if(!msg||typeof msg!=='object'||Array.isArray(msg))return send(ws,{type:'lobby-error',code:'BAD_MESSAGE'});
      try{
        if(msg.type==='select-game'){
          if(!gameAvailableInRoom(msg.gameId,room))throw unavailableGame();
          const result=lobby.selectGame(token,msg.gameId,{bind:true});
          if(room.gameId===BOMB_IT_GAME)
            for(const seated of room.members)if(seated)initializeBombItMember(room,seated);
          await registry.bindGame(result.room.key,msg.gameId);
          broadcastState(result.room);return;
        }
        if(msg.type==='propose-level'){
          if(!gameAvailableInRoom(msg.gameId,room))throw unavailableGame();
          if(msg.gameId===BOMB_IT_GAME)
            return send(ws,{type:'lobby-error',code:'BOMB_IT_USE_READY',message:'请刷新页面后使用准备按钮开局。'});
          const game=gameFor(catalog,msg.gameId);
          if(!game||!game.levels.some(level=>level.id===msg.levelId))
            return send(ws,{type:'lobby-error',code:'LEVEL_INVALID',message:'关卡无效'});
          const result=lobby.propose(token,{gameId:msg.gameId,levelId:msg.levelId});
          broadcastState(result.room);return;
        }
        if(msg.type==='cancel-proposal'){
          const result=lobby.cancel(token,msg.proposalId);
          broadcastState(result.room);return;
        }
        if(msg.type==='confirm-level'){
          const result=lobby.confirm(token,msg.proposalId);
          broadcastState(result.room);
          if(!result.ready)return;
          startConfirmedSession(result.room,result.proposal);
          return;
        }
        if(msg.type==='profile'){
          const result=lobby.setProfile(token,{name:msg.name,avatar:msg.avatar});
          const active=sessions.get(room.key);
          const matchSeat=isParticipantMatch(active)?participantSeat(active,member):-1;
          if(matchSeat>=0)active.match.setPlayerName?.(matchSeat,member.displayName);
          broadcastState(result.room);return;
        }
        if(msg.type==='set-outfit'){
          if(chatOnly||room.gameId!==BOMB_IT_GAME||room.phase!=='select'||room.proposal)
            return send(ws,{type:'lobby-error',code:'OUTFIT_UNAVAILABLE',message:'可在开局前更换角色和装扮。'});
          const {part,value}=msg;
          const character=part==='robotId';
          if(typeof part!=='string'||(!character&&!Object.hasOwn(DEFAULT_BOMB_IT_OUTFIT,part))||!Number.isInteger(value)||value<0||
              value>=(character?BOMB_IT_ROBOT_COUNT:4))
            return send(ws,{type:'lobby-error',code:'OUTFIT_INVALID',message:'装扮选项无效。'});
          const outfit=member.bombItOutfit;
          if(outfit[part]===value)return;
          if(character&&room.members.some(seated=>seated!==member&&seated?.bombItOutfit?.robotId===value))
            return send(ws,{type:'lobby-error',code:'BOMB_IT_CHARACTER_TAKEN',message:'这个角色已被选用，请选择其他角色。'});
          member.bombItOutfit={...outfit,[part]:value};
          member.bombItReady=false;
          broadcastState(room);return;
        }
        if(msg.type==='set-bomb-it-settings'||msg.type==='set-bomb-it-ready'){
          if(chatOnly||room.gameId!==BOMB_IT_GAME||room.phase!=='select')return;
          const settings=room.bombItSettings??DEFAULT_BOMB_IT_SETTINGS;
          if(msg.revision!==settings.revision)
            return send(ws,{type:'lobby-error',code:'BOMB_IT_SETTINGS_STALE',message:'房间规则已更新，请确认当前设置。'});
          if(msg.type==='set-bomb-it-settings'){
            if(bombItHost(room)!==member)
              return send(ws,{type:'lobby-error',code:'BOMB_IT_HOST_ONLY',message:'只有房主可以选择地图和模式。'});
            if(!isBombItSettings(msg))
              return send(ws,{type:'lobby-error',code:'BOMB_IT_SETTINGS_INVALID',message:'地图或模式不可用。'});
            if(msg.mapId===settings.mapId&&msg.modeId===settings.modeId)return;
            room.bombItSettings={mapId:msg.mapId,modeId:msg.modeId,revision:settings.revision+1};
            for(const seated of room.members)if(seated)seated.bombItReady=false;
          }else{
            if(typeof msg.ready!=='boolean')
              return send(ws,{type:'lobby-error',code:'BOMB_IT_READY_INVALID',message:'准备状态无效。'});
            member.bombItReady=msg.ready;
          }
          broadcastState(room);
          tryStartBombIt(room);return;
        }
        if(msg.type==='chat'){
          const result=lobby.chat(token,msg);
          broadcastState(result.room);return;
        }
        if(msg.type==='join-active'){
          const active=sessions.get(room.key);
          const resumedBvn=active?.bvn33&&active.authority?.launchUrls?.[member.seat];
          const resumedBrawl=isBrawlTicket(active)&&active.match.canAttach(participantSeat(active,member));
          if(chatOnly||room.phase!=='playing'||(!resumedBvn&&!resumedBrawl&&!isArenaTicket(active)))
            return send(ws,{type:'lobby-error',code:'SESSION_ENDED',message:'这场对局已结束，可在房间重新开局'});
          if(isArenaTicket(active))admitArenaMember(active,member);
          send(ws,{type:'session-start',session:sessionPayload(room,member)});
          return;
        }
        if(msg.type==='leave'){
          const ticket=sessions.get(room.key);
          const arena=isParticipantMatch(ticket);
          if(ticket&&!arena)endSession(ticket,'PLAYERS_LEFT');
          const result=lobby.leave(token,{releaseDuringPlay:arena});
          if(arena){
            const matchSeat=participantSeat(ticket,member);
            if(matchSeat>=0)ticket.match.leaveSeat(matchSeat);
          }
          void expiration.sync(room.key).catch(logMaintenanceError);
          ws.close();broadcastState(result.room);tryStartBombIt(result.room);return;
        }
        if(msg.type==='ping'){send(ws,{type:'pong',id:msg.id});return;}
        send(ws,{type:'lobby-error',code:'UNKNOWN_MESSAGE'});
      }catch(error){
        send(ws,{type:'lobby-error',code:error.code??'LOBBY_REJECTED',message:error.message});
      }
    });
  });
  const heartbeat=setInterval(()=>{
    for(const ws of clients){
      if(!ws.alive){ws.terminate();continue;}
      ws.alive=false;ws.ping();
    }
  },10000);heartbeat.unref();

  await new Promise((resolve,reject)=>{
    server.once('error',reject);
    server.listen(port,bindHost,()=>{server.off('error',reject);actualPort=server.address().port;displayPort=publicPort??actualPort;resolve();});
  });
  let closing;
  return {
    url:`http://${displayHost}:${displayPort}`,lobbyWsUrl:`ws://${displayHost}:${displayPort}/lobby`,
    registry,lobby,catalog,handleHttp,handleArenaViewerUpgrade,
    get activeSession(){return sessionSummaries()[0]??null;},
    get activeSessions(){return sessionSummaries();},
    close(){
      closing??=(async()=>{
        closed=true;clearInterval(monitor);clearInterval(sweeper);clearInterval(heartbeat);
        const tickets=[...sessions.values()];
        sessions.clear();
        await Promise.allSettled(tickets.map(closeTicket));
        for(const ws of wssLobby.clients)ws.terminate();
        await new Promise(resolve=>wssLobby.close(resolve));
        // HTTP keep-alive 连接会让 server.close() 一直等，先强制断开。
        server.closeAllConnections?.();
        await new Promise(resolve=>server.close(resolve));
        await registry.queue?.catch(logMaintenanceError);
      })();
      return closing;
    },
  };
}
