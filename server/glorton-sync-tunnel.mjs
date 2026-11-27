import {randomBytes} from 'node:crypto';
import {setTimeout as sleep} from 'node:timers/promises';
import {WebSocket} from 'ws';
import {encodeGlortonFrame,glortonControlFields} from '../public/glorton-online/frame-wire.mjs';

const roomCode=/^[A-HJ-NP-Z2-9]{6}$/;
const seatToken=/^[A-Za-z0-9_-]{32}$/;
const maxAuthorityPacket=2_000_000;
const snapshotInterval=400;
const handshakeTimeout=6000;
const disconnectTimeout=900;
const minFrameCredit=12;
const maxFrameCredit=40;
const maxQueuedFrames=8;
const ackRemainder=3; // The browser acknowledges every four frames.
const stages=new Set(['Rooftop','Mogadishu','B52','Space']);

function isObject(value){
  return value!==null&&typeof value==='object'&&!Array.isArray(value);
}

function losslessFields(data){
  // Python hashes 0.0, -0.0 and 0 differently. Keep the original number literals
  // while forwarding a checkpoint to the same Python engine in WebAssembly.
  return JSON.parse(data,(_key,value,context)=>
    typeof value==='number'?JSON.rawJSON(context.source):value);
}

function makeSeat(role){
  return {role,send:null,link:null,token:null,guestToken:null,releasing:false,sequence:0,lastBrowserSequence:-1,
    bootstrap:false,catchingUp:false,snapshotRequestedAt:0,detachedAt:null,
    pacing:null,canSend:null,compactFrames:false};
}

function validMatchSlots(slots,capacity){
  return Array.isArray(slots)&&slots.length>=2&&slots.length<=capacity&&slots[0]===0&&
    slots.every((slot,index)=>Number.isInteger(slot)&&slot<capacity&&(index===0||slot>slots[index-1]));
}

function safeLobbyState(packet,capacity,automaticRoster){
  const slots=Array.isArray(packet.slots)?packet.slots.map(slot=>({
    index:slot.index,kind:slot.kind,name:slot.name,fighter:slot.fighter,color:slot.color,
    level:slot.level,enabled:slot.enabled,ready:slot.ready,connected:slot.connected,
  })):[];
  return {op:'room_state',protocol:1,capacity,phase:packet.phase,host_slot:packet.host_slot,
    settings:packet.settings,slots,server_tick:packet.server_tick,paused_for_reconnect:packet.paused_for_reconnect===true,
    ...(automaticRoster?{automaticRoster:true,minimumPlayers:2}:{}),
    ...(automaticRoster&&validMatchSlots(packet.match_slots,capacity)?{match_slots:packet.match_slots}:{}),
    ...(Number.isSafeInteger(packet.round)?{round:packet.round}:{}),
    map_votes:Array.from({length:capacity},(_,index)=>stages.has(packet.map_votes?.[index])?packet.map_votes[index]:null),
    rematch_votes:Array.from({length:capacity},(_,index)=>packet.rematch_votes?.[index]===true),
    result:packet.result?.reason==='game_set'?{
      reason:'game_set',winner:typeof packet.result.winner==='string'?packet.result.winner:null,
      winner_slot:Number.isInteger(packet.result.winner_slot)?packet.result.winner_slot:null,
    }:null};
}

export function createGlortonSyncMatch({serviceUrl,capacity=2,automaticRoster=false,
  onState=()=>{},onEnd=()=>{},onError=()=>{},onSeatError=()=>{}}={}){
  const authority=new URL(serviceUrl);
  if(authority.protocol!=='ws:'||authority.hostname!=='127.0.0.1'||authority.pathname!=='/ws'||
    authority.username||authority.password||authority.search||authority.hash)throw Error('Expected a loopback Glorton authority');
  if(!Number.isInteger(capacity)||capacity<2||capacity>4)throw RangeError('Expected two to four players');
  const releaseUrl=new URL('/release-seat',authority);
  releaseUrl.protocol='http:';
  const players=Array.from({length:capacity},(_,index)=>makeSeat(index+1));
  const find=role=>Number.isInteger(role)?players[role-1]:null;
  let nativeRoom=null,lobby=null,matchStart=null,serverTick=0,round=0,finished=false,closed=false;

  const matchSlot=player=>matchStart?.match_slots?.indexOf(player.role-1)??-1;
  const isParticipant=player=>!automaticRoster||matchSlot(player)>=0;

  function deliver(player,packet){
    return player.send!==null&&player.send(packet)!==false;
  }

  function emitState(){
    if(closed)return;
    const connected=players.map(player=>player.send!==null&&openLink(player)!==null);
    const occupied=players.flatMap((_,index)=>lobby?.slots[index]?.enabled===true?[index]:[]);
    const enoughSeats=automaticRoster?occupied.length>=2:occupied.length===capacity;
    const allSeatsConnected=enoughSeats&&occupied.every(index=>connected[index]);
    const playing=matchStart!==null&&!finished;
    onState({phase:finished?'finished':playing?'playing':allSeatsConnected?'lobby':'waiting',
      ready:players.map((player,index)=>!player.releasing&&lobby?.slots[index]?.ready===true),
      connected,
      matchSeats:matchStart?.match_slots,
      paused:lobby?.paused_for_reconnect===true||(playing&&players.some(player=>isParticipant(player)&&player.detachedAt!==null))});
  }

  function advanceRound(next){
    round=next;
    lobby=null;
    matchStart=null;
    finished=false;
    serverTick=0;
    for(const player of players){
      player.bootstrap=false;
      player.catchingUp=false;
      player.snapshotRequestedAt=0;
      if(player.pacing){
        player.pacing.frames.length=0;
        resetPacing(player,0);
      }
    }
  }

  function openLink(player){
    const link=player.link;
    return link?.welcomed&&!link.intentional&&link.socket.readyState===WebSocket.OPEN?link:null;
  }

  function sendUpstream(link,packet){
    if(!link||link.socket.readyState!==WebSocket.OPEN)return false;
    if(link.socket.bufferedAmount>64*1024){link.socket.terminate();return false;}
    link.socket.send(JSON.stringify(packet),error=>{if(error)link.socket.terminate();});
    return true;
  }

  function requestSnapshot(player){
    const now=Date.now(),link=openLink(player);
    if(!link||!matchStart||finished||now-player.snapshotRequestedAt<snapshotInterval)return false;
    if(!sendUpstream(link,{op:'desync'}))return false;
    player.snapshotRequestedAt=now;
    return true;
  }

  function resetPacing(player,tick){
    if(!player.pacing)return;
    player.pacing.sent=player.pacing.ack=tick;
    player.pacing.frames=player.pacing.frames.filter(frame=>frame.tick>tick);
  }

  function recoverDelivery(player){
    if(player.send===null||player.canSend?.()===false)return;
    const pacing=player.pacing;
    if(!player.bootstrap&&pacing&&pacing.sent-pacing.ack>ackRemainder)return;
    requestSnapshot(player);
  }

  function flushFrames(player){
    const pacing=player.pacing;
    while(pacing.frames.length&&pacing.sent-pacing.ack<pacing.credit){
      const frame=pacing.frames[0];
      if(!deliver(player,frame))break;
      pacing.sent=frame.tick;
      pacing.frames.shift();
    }
    if(pacing.frames.length<=maxQueuedFrames)return;
    pacing.frames.length=0;
    player.catchingUp=true;
    recoverDelivery(player);
  }

  function sendInput(player,tick,held){
    const link=openLink(player);
    if(!link)return false;
    const input=Object.fromEntries(glortonControlFields.map(key=>[key,held[key]===true]));
    return sendUpstream(link,{op:'input',seq:++player.sequence,tick,controls:input});
  }

  function neutralize(player){
    if(!matchStart||finished)return;
    const link=openLink(player);
    if(!link)return;
    sendUpstream(link,{op:'input',seq:++player.sequence,tick:serverTick,clear:true,controls:{shield_released:true}});
  }

  function closeLink(link,force=false){
    if(!link||link.intentional)return;
    link.intentional=true;
    clearTimeout(link.boot);
    if(force||link.socket.readyState===WebSocket.CONNECTING){link.socket.terminate();return;}
    if(link.socket.readyState===WebSocket.CLOSED)return;
    link.socket.close(1000);
    link.stop=setTimeout(()=>link.socket.terminate(),disconnectTimeout);
    link.stop.unref();
  }

  function close(){
    if(closed)return;
    closed=true;
    for(const player of players){
      player.send=null;
      closeLink(player.link,true);
    }
  }

  function fail(message='游戏同步服务暂时中断，请重新建房。'){
    if(closed)return;
    const error={op:'error',code:'authority_unavailable',message,fatal:true};
    for(const player of players)deliver(player,error);
    close();
    onError(error);
    onEnd(message);
  }

  function failSeat(player,code='AUTHORITY_UNAVAILABLE',message='游戏连接失败，席位已释放。请返回大厅重试。'){
    if(player.role===1||(matchStart&&isParticipant(player)))return fail();
    const error={op:'error',code,message,fatal:true};
    deliver(player,error);
    onSeatError(player.role);
  }

  function welcome(player){
    deliver(player,{op:'welcome',protocol:1,slot:player.role-1,capacity,reconnect_seconds:22,
      ...(automaticRoster?{automaticRoster:true,minimumPlayers:2}:{}),
      ...(player.pacing?{frame_ack:true}:{}),...(player.compactFrames?{compact_frames:true}:{})});
  }

  function forwardState(player,packet){
    if(!Number.isSafeInteger(packet.server_tick)||packet.server_tick<0)return;
    serverTick=Math.max(serverTick,packet.server_tick);
    const state=safeLobbyState(packet,capacity,automaticRoster);
    if(player.role===1||!lobby||!openLink(players[0]))lobby=state;
    if(state.phase==='finished'&&state.result)finished=true;
    deliver(player,state);
    emitState();
  }

  function synchronize(player,packet,exactSnapshot){
    if(!isObject(packet.snapshot)||!Number.isSafeInteger(packet.snapshot.tick)||packet.snapshot.tick<0)return;
    const tick=packet.snapshot.tick;
    serverTick=Math.max(serverTick,packet.snapshot.tick);
    if(!player.bootstrap&&player.pacing&&tick<player.pacing.sent)return;
    if(player.detachedAt!==null){
      player.detachedAt=null;
      neutralize(player);
      emitState();
    }
    if(player.bootstrap){
      if(!matchStart)return fail('对局配置丢失，请重新建房。');
      if(!deliver(player,{...matchStart,initial_snapshot:exactSnapshot,
        ...(automaticRoster?{match_slot:matchSlot(player)}:{})}))return;
      player.bootstrap=false;
    }else if(!deliver(player,{...packet,snapshot:exactSnapshot}))return;
    resetPacing(player,tick);
    player.catchingUp=false;
    if(player.pacing)flushFrames(player);
  }

  function receiveAuthority(player,link,data,binary){
    if(closed||player.link!==link||link.intentional)return;
    if(binary)return fail();
    const message=data.toString();
    let packet;
    try{packet=JSON.parse(message);}catch{return fail();}
    if(!isObject(packet))return fail();
    if(!link.welcomed){
      if(automaticRoster&&packet.op==='error'&&packet.code==='match_already_started')
        return failSeat(player,'MATCH_STARTED','对局已经开始，可以等下一局再加入。');
      if(packet.op!=='welcome'||packet.protocol!==1||packet.slot!==player.role-1||
        !roomCode.test(packet.room)||!seatToken.test(packet.token)||(nativeRoom&&nativeRoom!==packet.room))return failSeat(player);
      nativeRoom=packet.room;
      player.token=packet.token;
      link.welcomed=true;
      clearTimeout(link.boot);
      if(!matchStart)player.detachedAt=null;
      welcome(player);
      emitState();
      if(player.role===1)for(const guest of players.slice(1))start(guest);
      return;
    }
    if(Number.isSafeInteger(packet.round)){
      if(packet.round<round)return;
      if(packet.round>round)advanceRound(packet.round);
    }
    if(packet.op==='room_state')return forwardState(player,packet);
    if(packet.op==='match_start'){
      const exact=losslessFields(message);
      const startPacket={op:'match_start',seed:packet.seed,tick_ms:packet.tick_ms,input_delay_ticks:packet.input_delay_ticks,
        match_config:exact.match_config,initial_snapshot:exact.initial_snapshot,
        ...(Number.isSafeInteger(packet.round)?{round:packet.round}:{}),
        ...(automaticRoster?{match_slots:packet.match_slots}:{})};
      if(!Number.isSafeInteger(startPacket.seed)||startPacket.tick_ms!==25||!isObject(startPacket.match_config)||
        !isObject(startPacket.initial_snapshot)||!Number.isSafeInteger(packet.initial_snapshot.tick)||
        (automaticRoster&&!validMatchSlots(packet.match_slots,capacity)))return fail();
      matchStart=startPacket;
      if(!isParticipant(player))return failSeat(player,'MATCH_STARTED','对局已经开始，可以等下一局再加入。');
      player.bootstrap=!deliver(player,{...startPacket,...(automaticRoster?{match_slot:matchSlot(player)}:{})});
      if(!player.bootstrap)resetPacing(player,packet.initial_snapshot.tick);
      emitState();
      return;
    }
    if(packet.op==='frame'){
      if(!Number.isSafeInteger(packet.tick)||packet.tick<1||!Array.isArray(packet.controls))return fail();
      serverTick=Math.max(serverTick,packet.tick);
      if(player.bootstrap||player.catchingUp){recoverDelivery(player);return;}
      const fullFrame={op:'frame',tick:packet.tick,controls:packet.controls,acks:packet.acks,
        ...(Number.isSafeInteger(packet.round)?{round:packet.round}:{}),
        ...(typeof packet.digest==='string'?{digest:packet.digest}:{})};
      const frame=player.compactFrames?encodeGlortonFrame(fullFrame):fullFrame;
      if(player.pacing){
        if(player.send===null)return;
        player.pacing.frames.push(frame);
        flushFrames(player);
        return;
      }
      if(!deliver(player,frame)){
        player.catchingUp=true;
        recoverDelivery(player);
      }
      return;
    }
    if(packet.op==='snapshot')return synchronize(player,packet,losslessFields(message).snapshot);
    if(packet.op==='match_end'){
      const end={...packet,snapshot:losslessFields(message).snapshot};
      if(packet.reason==='game_set'&&Number.isSafeInteger(packet.round)){
        finished=true;
        player.bootstrap=false;
        player.catchingUp=false;
        if(player.pacing)player.pacing.frames.length=0;
        deliver(player,end);
        emitState();
        return;
      }
      for(const seat of players)deliver(seat,end);
      close();
      onEnd(packet.reason==='reconnect_timeout'?'玩家离线超过保留时间，房间已关闭。':'对局已结束，可以返回大厅再次开战。');
      return;
    }
    if(packet.op==='pong'||packet.op==='error')deliver(player,packet);
  }

  function start(player){
    if(closed||player.send===null||player.link||player.releasing||(player.role!==1&&!nativeRoom))return;
    const socket=new WebSocket(authority,{handshakeTimeout,maxPayload:maxAuthorityPacket,perMessageDeflate:false});
    const link={socket,welcomed:false,intentional:false,boot:null,stop:null,
      closed:new Promise(resolve=>socket.once('close',resolve))};
    player.link=link;
    player.bootstrap=Boolean(matchStart&&!finished);
    player.catchingUp=false;
    player.snapshotRequestedAt=0;
    link.boot=setTimeout(()=>{if(player.link===link)failSeat(player);},handshakeTimeout);
    link.boot.unref();
    socket.once('open',()=>{
      if(closed||link.intentional)return;
      if(player.role!==1)player.guestToken??=randomBytes(24).toString('base64url');
      const hello=player.token?{op:'resume',room:nativeRoom,token:player.token}
        :player.role===1?{op:'create',name:player.name,capacity,...(automaticRoster?{automatic_roster:true}:{})}
          :{op:'join',room:nativeRoom,name:player.name,slot:player.role-1,seat_token:player.guestToken};
      sendUpstream(link,{...hello,protocol:1});
    });
    socket.on('error',()=>socket.terminate());
    socket.on('message',(data,binary)=>receiveAuthority(player,link,data,binary));
    socket.once('close',()=>{
      clearTimeout(link.boot);
      clearTimeout(link.stop);
      if(player.link!==link)return;
      player.link=null;
      if(closed)return;
      if(!link.intentional)return failSeat(player);
      start(player);
    });
  }

  function attach(role,{name,send,canSend,frameAck=false,compactFrames=false}){
    const player=find(role);
    if(closed||!player||typeof send!=='function')return false;
    if(matchStart&&!finished&&!isParticipant(player))return false;
    player.name=name;
    player.send=send;
    player.canSend=canSend;
    player.compactFrames=compactFrames;
    player.pacing=frameAck?{sent:0,ack:0,credit:minFrameCredit,frames:[]}:null;
    player.lastBrowserSequence=-1;
    if(!player.releasing&&openLink(player)){
      welcome(player);
      if(lobby)deliver(player,lobby);
      player.bootstrap=Boolean(matchStart&&!finished);
      neutralize(player);
      requestSnapshot(player);
      emitState();
    }else start(player);
    return true;
  }

  function setRoundTrip(role,milliseconds){
    const pacing=find(role)?.pacing;
    if(!pacing||!Number.isFinite(milliseconds)||milliseconds<0)return;
    // Leave enough credit for the measured round trip, four-frame acknowledgments and jitter.
    pacing.credit=Math.max(minFrameCredit,Math.min(maxFrameCredit,Math.ceil(milliseconds/25)+7));
  }

  function receive(role,packet){
    const player=find(role),link=player&&openLink(player);
    if(closed||!link||player.send===null||!isObject(packet))return false;
    if(packet.round!==undefined&&packet.round!==round)return false;
    if(packet.op==='frame_ack'){
      const pacing=player.pacing;
      if(!pacing||!Number.isSafeInteger(packet.tick)||packet.tick<=pacing.ack||packet.tick>pacing.sent)return false;
      pacing.ack=packet.tick;
      if(player.catchingUp)recoverDelivery(player);
      else if(!player.bootstrap)flushFrames(player);
      return true;
    }
    if(packet.op==='input'){
      if(!matchStart||finished||player.bootstrap||!Number.isSafeInteger(packet.seq)||packet.seq<=player.lastBrowserSequence||
        !Number.isSafeInteger(packet.tick)||!isObject(packet.controls))return false;
      player.lastBrowserSequence=packet.seq;
      return sendInput(player,packet.tick,packet.controls);
    }
    if(packet.op==='clear'){neutralize(player);return true;}
    if(packet.op==='ping'&&Number.isSafeInteger(packet.id)&&Number.isSafeInteger(packet.client_time_ms))
      return sendUpstream(link,{op:'ping',id:packet.id,client_time_ms:packet.client_time_ms});
    if(packet.op==='desync')return requestSnapshot(player);
    if(packet.op==='map_vote'&&!matchStart&&!finished&&stages.has(packet.stage))
      return sendUpstream(link,{op:'map_vote',stage:packet.stage,...(packet.round?{round}: {})});
    if(packet.op==='rematch'&&finished&&typeof packet.ready==='boolean')
      return sendUpstream(link,{op:'rematch',ready:packet.ready,...(packet.round?{round}: {})});
    if(packet.op==='lobby_update'&&!matchStart&&isObject(packet.patch)){
      const slot=packet.slot??role-1;
      const computerSlot=!automaticRoster&&role===1&&Number.isInteger(slot)&&slot>=capacity&&slot<4;
      if(slot!==role-1&&!computerSlot)return false;
      const patch={};
      if(typeof packet.patch.fighter==='string'&&packet.patch.fighter.length<=32)patch.fighter=packet.patch.fighter;
      for(const key of ['color','level'])if(Number.isSafeInteger(packet.patch[key]))patch[key]=packet.patch[key];
      for(const key of ['ready','enabled'])if(typeof packet.patch[key]==='boolean')patch[key]=packet.patch[key];
      if(!Object.keys(patch).length)return false;
      return sendUpstream(link,{op:'lobby_update',slot,patch,...(packet.round?{round}:{})});
    }
    if(packet.op==='settings_update'&&role===1&&!matchStart&&isObject(packet.patch)){
      const patch={};
      if(typeof packet.patch.stage==='string'&&packet.patch.stage.length<=32)patch.stage=packet.patch.stage;
      if(Number.isSafeInteger(packet.patch.stock))patch.stock=packet.patch.stock;
      if(typeof packet.patch.items==='boolean')patch.items=packet.patch.items;
      if(!Object.keys(patch).length)return false;
      return sendUpstream(link,{op:'settings_update',patch,...(packet.round?{round}:{})});
    }
    return false;
  }

  function detach(role){
    const player=find(role);
    if(closed||!player||player.send===null)return;
    neutralize(player);
    player.send=null;
    player.canSend=null;
    player.pacing=null;
    player.compactFrames=false;
    player.detachedAt=Date.now();
    closeLink(player.link);
    emitState();
  }

  async function release(role){
    const player=find(role);
    if(closed||!player||player.role===1||(matchStart&&!finished&&isParticipant(player)))return;
    player.send=null;
    player.canSend=null;
    player.pacing=null;
    if(player.releasing)return;
    player.releasing=true;
    player.detachedAt=null;
    const link=player.link;
    const token=player.token??player.guestToken;
    player.token=null;
    player.guestToken=null;
    player.sequence=0;
    closeLink(link);
    emitState();
    try{
      if(link)await link.closed;
      if(token&&nativeRoom&&!closed&&(!matchStart||finished||isParticipant(player))){
        for(let attempt=0;attempt<2;attempt++){
          const response=await fetch(releaseUrl,{method:'POST',headers:{'content-type':'application/json'},
            body:JSON.stringify({room:nativeRoom,token}),signal:AbortSignal.timeout(1300)});
          if(!response.ok)throw Error('Authority rejected seat release');
          const result=await response.json();
          if(result.released)break;
          if(result.playing&&isParticipant(player))return fail('玩家已退出，对局已结束。');
          if(attempt===0)await sleep(100);
        }
      }
    }catch{return fail();}
    finally{player.releasing=false;start(player);}
  }

  return {attach,receive,setRoundTrip,detach,release,close};
}
