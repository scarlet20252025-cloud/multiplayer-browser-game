import {randomBytes, randomInt} from 'node:crypto';
import {WebSocket} from 'ws';
import {COUNTDOWN, DEFAULT_MODE, MAX_PLAYERS, MIN_PLAYERS, MODES, ROUND_GAP, TICK_RATE} from '../public/tank-arena/rules.mjs';
import {
  advanceArena, advanceLaserEffects, createArena, enterArenaSeat, forfeitArenaSeat, neutralInput, normalizeInput,
  reserveArenaSeat, setArenaAvailability,
} from './tank-arena-sim.mjs';

const STEP=1/TICK_RATE;
const JOIN_TIMEOUT=60_000;
const READY_GRACE=5_000;
const RECONNECT_TIMEOUT=45_000;
const SWITCH_SECONDS=1.8;
const FINISH_SECONDS=4;
const RESULT_SECONDS=1.25;
const PING_INTERVAL=1_000;
const PONG_TIMEOUT=12_000;
const MAX_BUFFERED=96*1024;
const SNAPSHOT_QUEUE_LIMIT=32*1024;

const emptyStats=()=>({score:0,kills:0,deaths:0,wins:0});

export function mineConfirmationsFor(mines,seat){
  return mines.filter(mine=>!mine.armed&&mine.owner===seat)
    .map(({id,x,y,owner,armed})=>({id,x,y,owner,armed}));
}

export function createTankArenaMatch({playerNames=[],playerCount=playerNames.length,onEnd,onSeatDropped,levelId}){
  if(!Number.isInteger(playerCount)||playerCount<MIN_PLAYERS||playerCount>MAX_PLAYERS)
    throw new RangeError('Invalid arena player count');
  let mode=DEFAULT_MODE,nextMode=null,mapSeed=randomInt(0x100000000);
  let mapPlayerCount=playerCount,arena=createArena(mapSeed,playerCount,mode),phase='waiting',round=1;
  for(const tank of arena.tanks)tank.available=false;
  let series=1,scores=Array(playerCount).fill(0),winner=null,winnerName=null,reason=null,remaining=0,tick=0;
  let seriesWon=false;
  let lastStep=performance.now(),lastBroadcast=0,accumulator=0,ended=false;
  let readyUntil=null;
  const peers=Array(playerCount).fill(null);
  const modeVotes=Array(playerCount).fill(null),dropped=Array(playerCount).fill(false);
  const seatExpiry=Array(playerCount).fill(lastStep+JOIN_TIMEOUT);
  const joined=Array(playerCount).fill(false);
  const admitted=Array(playerCount).fill(false),queued=Array(playerCount).fill(false);
  const names=Array.from({length:playerCount},(_,seat)=>playerNames[seat]||`P${seat+1}`);
  const stats=Array.from({length:playerCount},emptyStats);
  const activeCount=()=>peers.filter(Boolean).length;
  const eligibleCount=()=>dropped.filter(value=>!value).length;
  const seatAvailable=seat=>!ended&&Number.isInteger(seat)&&seat>=0&&seat<peers.length&&!dropped[seat];
  const canAdmitPlayer=()=>!ended&&eligibleCount()<MAX_PLAYERS;
  const send=(ws,payload,bufferLimit=MAX_BUFFERED)=>{
    if(ws?.readyState===WebSocket.OPEN&&ws.bufferedAmount<bufferLimit)ws.send(payload);
  };

  function broadcast(message,bufferLimit){
    const payload=JSON.stringify(message);
    for(const peer of peers)send(peer?.ws,payload,bufferLimit);
  }

  function probePeer(peer,now){
    if(!peer||peer.ws.readyState!==WebSocket.OPEN)return;
    if(peer.probe){
      if(now-peer.probe.sent>=PONG_TIMEOUT)peer.ws.terminate();
      return;
    }
    const nonce=randomBytes(8);
    peer.probe={nonce,sent:now};
    peer.ws.ping(nonce);
  }

  function snapshot(){
    const pulseOwners=new Set(arena.shots.filter(shot=>shot.kind==='pulse').map(shot=>shot.owner));
    const message={type:'arena',tick,phase,series,round,mapSeed,levelId,remaining:arena.remaining,
      phaseRemaining:remaining,connected:peers.map(Boolean),names,scores,stats,winner,winnerName,reason,
      playerCount:peers.length,mapPlayerCount,width:arena.width,height:arena.height,mode,nextMode,modeVotes,dropped,queued,
      paused:phase!=='waiting'&&phase!=='result'&&phase!=='settling'&&activeCount()<MIN_PLAYERS,
      capture:arena.capture,beacon:arena.beacon,beaconMoveRemaining:arena.beaconMoveRemaining,
      blasts:arena.blasts,effects:arena.effects,pickups:arena.pickups,
      tanks:arena.tanks.map(({x,y,hull,armor,damage,shield,weapon,respawnRemaining,spawnGrace,available,
        gatlingAmmo,gatlingSpin,doubleAmmo,doubleSide,boostRemaining,aimerRemaining,pulseCharge},seat)=>
        ({x,y,hull,armor:available?armor:0,damage,shield,weapon,respawnRemaining,spawnGrace,
          gatlingAmmo,gatlingSpin,doubleAmmo,doubleSide,boostRemaining,aimerRemaining,
          pulseCharge,pulseFiring:pulseOwners.has(seat)})),
      shots:arena.shots.map(({id,x,y,vx,vy,owner,bounces,ricochets,kind,path,target,front,tail,length,width,life})=>
        ({id,x,y,vx,vy,owner,bounces,ricochets,kind,path,target,front,tail,length,width,
          lifeRemaining:kind==='pulse'?life:undefined})),
      mines:[]};
    if(!arena.mines.some(mine=>!mine.armed)){broadcast(message,SNAPSHOT_QUEUE_LIMIT);return;}
    const publicPayload=JSON.stringify(message);
    for(const [seat,peer] of peers.entries()){
      if(!peer)continue;
      const mines=mineConfirmationsFor(arena.mines,seat);
      send(peer.ws,mines.length?JSON.stringify({...message,mines}):publicPayload,SNAPSHOT_QUEUE_LIMIT);
    }
  }

  function stop(code,notify=true){
    if(ended)return;
    ended=true;
    clearInterval(loop);clearInterval(heartbeat);
    broadcast({type:'ended',code});
    for(const peer of peers)peer?.ws.close(1000);
    if(notify)onEnd?.(code);
  }

  function resetInputs(){
    for(const peer of peers){
      if(!peer)continue;
      peer.input=neutralInput();peer.firePulse=false;
    }
  }

  function prepareRound({newMaze=false}={}){
    if(newMaze){
      const oldSeed=mapSeed;
      while(mapSeed===oldSeed)mapSeed=randomInt(0x100000000);
    }
    mapPlayerCount=peers.length;
    arena=createArena(mapSeed,mapPlayerCount,mode,arena.supplyBag);phase='countdown';remaining=COUNTDOWN;
    for(const [seat,tank] of arena.tanks.entries()){
      if(dropped[seat])forfeitArenaSeat(arena,seat);
      else tank.available=Boolean(peers[seat]);
    }
    queued.fill(false);
    winner=null;winnerName=null;reason=null;seriesWon=false;resetInputs();
  }

  function startSeries(selectedMode){
    mode=selectedMode;nextMode=null;series++;round=1;
    modeVotes.fill(null);scores=Array(peers.length).fill(0);
    prepareRound({newMaze:true});
  }

  function winningModeVote(){
    const active=activeCount();
    if(active<MIN_PLAYERS)return null;
    return Object.keys(MODES).find(candidate=>candidate!==mode&&
      modeVotes.filter(vote=>vote===candidate).length>active/2);
  }

  function checkModeVotes(){
    if(['waiting','switching','settling','result'].includes(phase))return;
    const elected=winningModeVote();
    if(!elected)return;
    nextMode=elected;phase='switching';remaining=SWITCH_SECONDS;resetInputs();
  }

  function completeRound(){
    resetInputs();
    if(seriesWon){phase='result';remaining=RESULT_SECONDS;}
    else{phase='between';remaining=ROUND_GAP;}
    checkModeVotes();
  }

  function activeInputs(now){
    return peers.map(peer=>{
      if(!peer)return neutralInput();
      const value={...peer.input,fire:peer.input.fire||peer.firePulse};
      peer.firePulse=false;
      return now-peer.lastInput>450?neutralInput():value;
    });
  }

  function recordBlastStats(lastBlast){
    if(arena.nextBlast===lastBlast)return false;
    for(const {id,seat,owner} of arena.blasts){
      if(id<=lastBlast)continue;
      stats[seat].deaths++;
      if(seat!==owner)stats[owner].kills++;
    }
    return true;
  }

  function playTick(now){
    let outcome,destroyed=false;
    if(phase==='playing'||phase==='settling'){
      const lastBlast=arena.nextBlast;
      outcome=advanceArena(arena,activeInputs(now),STEP,{scoringLocked:phase==='settling'});
      destroyed=recordBlastStats(lastBlast);
    }
    if(['countdown','between','switching','settling','result'].includes(phase)){
      remaining=Math.max(0,remaining-STEP);
      if(remaining>0)return;
      if(phase==='switching')startSeries(nextMode);
      else if(phase==='between'){round++;prepareRound({newMaze:true});}
      else if(phase==='settling')completeRound();
      else if(phase==='result'){
        if(eligibleCount()<MIN_PLAYERS)stop('PLAYERS_LEFT');
        else startSeries(winningModeVote()??mode);
      }
      else{phase='playing';resetInputs();}
      return;
    }
    if(phase!=='playing')return;
    const modeScores=mode==='deathmatch'?arena.kills:mode==='relay'?arena.relayScore:null;
    if(modeScores){
      for(const [seat,score] of modeScores.entries()){
        stats[seat].score+=score-scores[seat];
        scores[seat]=score;
      }
    }
    if(!outcome)return;
    winner=outcome.winner;winnerName=winner===null?null:names[winner];reason=outcome.reason;
    if(!MODES[mode].respawns&&winner!==null){scores[winner]++;stats[winner].score++;}
    seriesWon=winner!==null&&scores[winner]>=MODES[mode].scoreToWin;
    if(seriesWon)stats[winner].wins++;
    if(destroyed){phase='settling';remaining=FINISH_SECONDS;}
    else completeRound();
  }

  function drop(seat){
    const peer=peers[seat];
    peers[seat]=null;modeVotes[seat]=null;seatExpiry[seat]=null;queued[seat]=false;
    dropped[seat]=true;forfeitArenaSeat(arena,seat);
    if(peer){
      send(peer.ws,JSON.stringify({type:'ended',code:'PLAYERS_LEFT'}));
      peer.ws.close(1000);
    }
    onSeatDropped?.(seat);
  }

  function checkSeats(now){
    for(const [seat,deadline] of seatExpiry.entries()){
      if(deadline!==null&&now>=deadline)drop(seat);
    }
    if(eligibleCount()<MIN_PLAYERS&&phase!=='settling'&&phase!=='result')stop('PLAYERS_LEFT');
  }

  const loop=setInterval(()=>{
    const now=performance.now();
    checkSeats(now);
    if(ended)return;
    setWaitingReady(now);
    accumulator+=Math.min((now-lastStep)/1000,STEP*5);
    lastStep=now;
    const enoughPlayers=activeCount()>=MIN_PLAYERS;
    while(accumulator>=STEP){
      accumulator-=STEP;tick++;
      const finishing=phase==='settling'||phase==='result';
      if(phase==='result'||phase==='between')advanceLaserEffects(arena,STEP);
      if(enoughPlayers||finishing)playTick(now);
      if(ended)return;
    }
    if(now-lastBroadcast>=(phase==='playing'||phase==='settling'||arena.shots.some(shot=>shot.kind==='beam'||shot.kind==='pulse')?33:100)){
      lastBroadcast=now;snapshot();
    }
  },12);
  loop.unref();
  const heartbeat=setInterval(()=>{
    const now=performance.now();
    for(const peer of peers)probePeer(peer,now);
  },PING_INTERVAL);
  heartbeat.unref();

  function setWaitingReady(now=performance.now()){
    if(phase!=='waiting')return;
    if(activeCount()<MIN_PLAYERS){readyUntil=null;return;}
    readyUntil??=now+READY_GRACE;
    if(now>=readyUntil||peers.every((peer,seat)=>peer||dropped[seat]))prepareRound();
  }

  function admitPlayer(displayName){
    if(!canAdmitPlayer())return null;
    const vacant=dropped.indexOf(true);
    const seat=vacant===-1?peers.length:vacant;
    peers[seat]=null;modeVotes[seat]=null;dropped[seat]=false;
    seatExpiry[seat]=performance.now()+JOIN_TIMEOUT;
    joined[seat]=false;admitted[seat]=true;queued[seat]=false;
    names[seat]=displayName||`P${seat+1}`;
    if(seat===winner)winner=null;
    reserveArenaSeat(arena,seat);
    scores[seat]=0;
    stats[seat]=emptyStats();
    snapshot();
    return seat;
  }

  function leaveSeat(seat){
    if(!seatAvailable(seat))return;
    drop(seat);checkSeats(performance.now());
    if(!ended){setWaitingReady();checkModeVotes();snapshot();}
  }

  function detach(peer,seat){
    if(ended||peers[seat]!==peer)return;
    peers[seat]=null;modeVotes[seat]=null;
    setArenaAvailability(arena,seat,false);
    seatExpiry[seat]=performance.now()+RECONNECT_TIMEOUT;
    setWaitingReady();
    if(phase!=='settling'&&activeCount()<MIN_PLAYERS)resetInputs();
    checkModeVotes();snapshot();
  }

  function receive(peer,seat,data,binary){
    if(ended||peers[seat]!==peer||binary)return;
    let message;
    try{message=JSON.parse(data.toString());}catch{return;}
    if(!message||typeof message!=='object'||Array.isArray(message))return;
    const now=performance.now();
    if(now-peer.rateStart>=1_000){peer.rateStart=now;peer.rateCount=0;}
    if(++peer.rateCount>125)return;
    if(message.type==='leave'){
      leaveSeat(seat);return;
    }
    if(message.type==='vote-mode'&&!['waiting','switching','settling'].includes(phase)){
      const choice=message.mode;
      if(choice!==null&&(typeof choice!=='string'||!Object.hasOwn(MODES,choice)))return;
      if(modeVotes[seat]===choice)return;
      modeVotes[seat]=choice;checkModeVotes();snapshot();
      return;
    }
    const canControl=phase==='settling'||(phase==='playing'&&activeCount()>=MIN_PLAYERS);
    if(message.type!=='input'||!canControl||
      !Number.isSafeInteger(message.seq)||message.seq<=peer.seq)return;
    const input=normalizeInput(message);
    if(!input)return;
    if(input.fire&&!peer.input.fire)peer.firePulse=true;
    peer.seq=message.seq;peer.input=input;peer.lastInput=now;
  }

  return {
    canAttach:seatAvailable,
    canAdmitPlayer,
    admitPlayer,
    leaveSeat,
    setPlayerName(seat,displayName){
      if(!seatAvailable(seat)||typeof displayName!=='string'||!displayName||names[seat]===displayName)return;
      names[seat]=displayName;snapshot();
    },
    attach(ws,seat){
      if(!seatAvailable(seat)){ws.close(1008,'seat-unavailable');return;}
      const previous=peers[seat];
      const peer={ws,input:neutralInput(),firePulse:false,seq:-1,lastInput:0,probe:null,rateStart:0,rateCount:0};
      const lateEntry=!joined[seat]&&phase!=='waiting';
      if(!joined[seat]&&(admitted[seat]||phase==='settling')){
        queued[seat]=!(phase==='waiting'||phase==='countdown'||(phase==='playing'&&MODES[mode].respawns));
        if(!queued[seat])enterArenaSeat(arena,seat);
      }
      peers[seat]=peer;seatExpiry[seat]=null;joined[seat]=true;
      if(!previous&&!queued[seat])setArenaAvailability(arena,seat,true,lateEntry);
      if(previous)previous.ws.close(4001,'replaced');
      ws.on('pong',nonce=>{
        if(ended||peers[seat]!==peer||!peer.probe||!Buffer.isBuffer(nonce)||!peer.probe.nonce.equals(nonce))return;
        const elapsed=performance.now()-peer.probe.sent;
        if(elapsed>=PONG_TIMEOUT)return;
        peer.probe=null;
        send(ws,JSON.stringify({type:'latency',ms:Math.round(elapsed)}));
      });
      ws.on('close',()=>detach(peer,seat));
      ws.on('error',()=>detach(peer,seat));
      ws.on('message',(data,binary)=>receive(peer,seat,data,binary));
      send(ws,JSON.stringify({type:'seat',seat}));
      setWaitingReady();snapshot();
      probePeer(peer,performance.now());
    },
    async close(){stop('SESSION_ENDED',false);},
  };
}
