import {randomBytes} from 'node:crypto';
import {WebSocket} from 'ws';
import {BRAWL_TICK_RATE, MAX_BRAWL_PLAYERS, MIN_BRAWL_PLAYERS, normalizeBrawlInput} from '../public/platform-brawl/rules.mjs';
import {brawlSnapshot, createBrawl, setBrawlerConnected, stepBrawl} from './platform-brawl-sim.mjs';

const STEP_MS=1000/BRAWL_TICK_RATE;
const ADMISSION_MS=60_000;
const RECONNECT_MS=45_000;
const START_GRACE_MS=3_000;
const INPUT_EXPIRY_MS=500;
const INPUT_LIMIT_PER_SECOND=100;
const ACTIONS=['jump','light','heavy'];
const MAX_PENDING_ACTIONS=3;
const RECENT_EVENT_TICKS=Math.ceil(BRAWL_TICK_RATE*.3);
const MAX_RECENT_EVENTS=24;
const SNAPSHOT_BUFFER_LIMIT=24*1024;
const MESSAGE_BUFFER_LIMIT=64*1024;
const HEARTBEAT_MS=1_000;
const PONG_TIMEOUT_MS=12_000;
const NEUTRAL={left:false,right:false,jump:false,light:false,heavy:false};

export function createPlatformBrawlMatch({
  playerNames=[],playerCount=playerNames.length,levelId,onEnd,onSeatDropped,
}={}){
  if(!Number.isInteger(playerCount)||playerCount<MIN_BRAWL_PLAYERS||playerCount>MAX_BRAWL_PLAYERS)
    throw new RangeError('Invalid brawl player count');

  const state=createBrawl({playerCount,names:playerNames});
  const peers=Array(playerCount).fill(null);
  const dropped=Array(playerCount).fill(false);
  const deadlines=Array(playerCount).fill(performance.now()+ADMISSION_MS);
  let recentEvents=[];
  let lastStep=performance.now(),accumulator=0,lastSnapshot=0;
  let startAt=null,started=false,ended=false;
  for(let seat=0;seat<playerCount;seat++)setBrawlerConnected(state,seat,false);

  const connectedCount=()=>peers.filter(Boolean).length;
  function validSeat(seat){
    return Number.isInteger(seat)&&seat>=0&&seat<playerCount&&!dropped[seat];
  }
  function canAttach(seat){
    return !ended&&validSeat(seat)&&(deadlines[seat]===null||deadlines[seat]>performance.now());
  }
  function send(ws,payload,limit=MESSAGE_BUFFER_LIMIT){
    if(ws?.readyState===WebSocket.OPEN&&ws.bufferedAmount<limit)ws.send(payload);
  }
  function snapshot(now=performance.now()){
    lastSnapshot=now;
    const payload=JSON.stringify({
      type:'brawl',...brawlSnapshot(state),levelId,
      phase:started?state.phase:'waiting',
      paused:started&&state.phase==='playing'&&connectedCount()<MIN_BRAWL_PLAYERS,
      events:recentEvents,
    });
    for(const peer of peers)send(peer?.ws,payload,SNAPSHOT_BUFFER_LIMIT);
  }
  function clearControls(peer){
    if(!peer)return;
    peer.input=NEUTRAL;
    peer.actions.length=0;
    peer.lastInput=-Infinity;
  }
  function resetControls(){for(const peer of peers)clearControls(peer);}

  function end(code,notify=true){
    if(ended)return;
    ended=true;
    clearInterval(loop);
    clearInterval(heartbeat);
    const payload=JSON.stringify({type:'ended',code});
    for(const peer of peers){
      if(!peer)continue;
      send(peer.ws,payload);
      peer.ws.close(1000);
    }
    if(notify)onEnd?.(code);
  }
  function drop(seat){
    const peer=peers[seat];
    peers[seat]=null;
    dropped[seat]=true;
    deadlines[seat]=null;
    setBrawlerConnected(state,seat,false);
    if(peer){
      send(peer.ws,JSON.stringify({type:'ended',code:'PLAYERS_LEFT'}));
      peer.ws.close(1000);
    }
    onSeatDropped?.(seat);
  }
  function hasEnoughReservations(){
    return dropped.filter(value=>!value).length>=MIN_BRAWL_PLAYERS;
  }
  function ready(now){
    if(started)return;
    if(connectedCount()<MIN_BRAWL_PLAYERS){startAt=null;return;}
    startAt??=now+START_GRACE_MS;
    if(now>=startAt||peers.every((peer,seat)=>peer||dropped[seat])){
      started=true;
      accumulator=0;
      resetControls();
    }
  }
  function controlsAt(peer,now){
    if(!peer||now-peer.lastInput>INPUT_EXPIRY_MS)return NEUTRAL;
    const actions=peer.actions.shift()??[];
    return {left:peer.input.left,right:peer.input.right,jump:actions.includes('jump'),
      light:actions.includes('light'),heavy:actions.includes('heavy')};
  }
  function probe(peer,now){
    if(!peer||peer.ws.readyState!==WebSocket.OPEN)return;
    if(peer.probe){
      if(now-peer.probe.sent>=PONG_TIMEOUT_MS)peer.ws.terminate();
      return;
    }
    const nonce=randomBytes(8);
    peer.probe={nonce,sent:now};
    peer.ws.ping(nonce);
  }
  const loop=setInterval(()=>{
    const now=performance.now();
    for(const [seat,deadline] of deadlines.entries()){
      if(deadline!==null&&now>=deadline)drop(seat);
    }
    if(!hasEnoughReservations()){end('PLAYERS_LEFT');return;}
    ready(now);
    if(started&&(connectedCount()>=MIN_BRAWL_PLAYERS||state.phase==='result')){
      accumulator+=Math.min(now-lastStep,5*STEP_MS);
      while(accumulator>=STEP_MS){
        accumulator-=STEP_MS;
        const phaseBefore=state.phase;
        stepBrawl(state,peers.map(peer=>controlsAt(peer,now)));
        recentEvents=recentEvents.filter(event=>state.tick-event.tick<RECENT_EVENT_TICKS);
        recentEvents.push(...state.events.map(event=>({...event,tick:state.tick})));
        if(recentEvents.length>MAX_RECENT_EVENTS)recentEvents=recentEvents.slice(-MAX_RECENT_EVENTS);
        if(phaseBefore!==state.phase){
          resetControls();
          if(state.phase==='playing')recentEvents=[];
        }
        if(state.phase==='playing'&&connectedCount()<MIN_BRAWL_PLAYERS){accumulator=0;break;}
      }
    }else accumulator=0;
    lastStep=now;
    if(now-lastSnapshot>=(started?40:100))snapshot(now);
  },12);
  loop.unref();
  const heartbeat=setInterval(()=>{
    const now=performance.now();
    for(const peer of peers)probe(peer,now);
  },HEARTBEAT_MS);
  heartbeat.unref();

  function leaveSeat(seat){
    if(ended||!validSeat(seat))return;
    drop(seat);
    if(!hasEnoughReservations()){end('PLAYERS_LEFT');return;}
    if(connectedCount()<MIN_BRAWL_PLAYERS)resetControls();
    ready(performance.now());
    snapshot();
  }
  function detach(peer,seat){
    if(ended||peers[seat]!==peer)return;
    peers[seat]=null;
    deadlines[seat]=performance.now()+RECONNECT_MS;
    setBrawlerConnected(state,seat,false);
    if(connectedCount()<MIN_BRAWL_PLAYERS)resetControls();
    ready(performance.now());
    snapshot();
  }
  function receive(peer,seat,data,binary){
    if(ended||peers[seat]!==peer||binary)return;
    const now=performance.now();
    if(now-peer.rateStart>=1_000){peer.rateStart=now;peer.rateCount=0;}
    if(++peer.rateCount>INPUT_LIMIT_PER_SECOND)return;
    let message;
    try{message=JSON.parse(data.toString());}catch{return;}
    if(!message||typeof message!=='object'||Array.isArray(message))return;
    if(message.type==='leave'){leaveSeat(seat);return;}
    if(message.type!=='input'||!started||state.phase!=='playing'||connectedCount()<MIN_BRAWL_PLAYERS||
      !Number.isSafeInteger(message.seq)||message.seq<=peer.seq)return;
    const input=normalizeBrawlInput(message);
    if(!input)return;
    const actions=ACTIONS.filter(action=>input[action]&&!peer.input[action]);
    if(actions.length&&peer.actions.length<MAX_PENDING_ACTIONS)peer.actions.push(actions);
    peer.seq=message.seq;
    peer.input=input;
    peer.lastInput=now;
  }

  return {
    canAttach,
    leaveSeat,
    setPlayerName(seat,name){
      if(!canAttach(seat)||typeof name!=='string'||!name.trim())return;
      state.players[seat].name=name.trim().slice(0,32);
      snapshot();
    },
    attach(ws,seat){
      if(!canAttach(seat)){ws.close(1008,'seat-unavailable');return;}
      const previous=peers[seat];
      const now=performance.now();
      const peer={ws,input:NEUTRAL,actions:[],seq:-1,lastInput:-Infinity,rateStart:now,rateCount:0,probe:null};
      peers[seat]=peer;
      deadlines[seat]=null;
      setBrawlerConnected(state,seat,true);
      if(previous)previous.ws.close(4001,'replaced');
      ws.on('close',()=>detach(peer,seat));
      ws.on('error',()=>detach(peer,seat));
      ws.on('message',(data,binary)=>receive(peer,seat,data,binary));
      ws.on('pong',nonce=>{
        if(ended||peers[seat]!==peer||!peer.probe||!Buffer.isBuffer(nonce)||!peer.probe.nonce.equals(nonce))return;
        const ms=Math.round(performance.now()-peer.probe.sent);
        if(ms>=PONG_TIMEOUT_MS)return;
        peer.probe=null;
        send(ws,JSON.stringify({type:'latency',ms}));
      });
      send(ws,JSON.stringify({type:'seat',seat}));
      ready(now);
      snapshot(now);
      probe(peer,now);
    },
    async close(){end('SESSION_ENDED',false);},
  };
}
