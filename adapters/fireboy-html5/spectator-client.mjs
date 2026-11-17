/**
 * Local research browser client: game artwork is loaded privately into each
 * browser, while authoritative rules execute only in the room's browser.
 * The viewing game stays paused; incoming snapshots drive visual sprites.
 * Does NOT establish complete gameplay/render synchronization.
 */
import {installHtml5Spectator} from './spectator-projection.mjs';

export function connectHtml5Spectator({game,wsUrl,devices=globalThis.Devices}={}){
  if(!game?.level||typeof wsUrl!=='string'||!/^wss?:\/\//.test(wsUrl))
    throw new TypeError('Loaded game and WebSocket URL required');
  let projection=installHtml5Spectator(game,{devices});
  const ws=new WebSocket(wsUrl);
  const keys=new Set();
  let seq=0,commandSeq=0,closed=false,seat=null,room=null,roomEpoch=null,
    initial=false,latestState=null,lastApply=null,lastError=null,frames=0,
    lifecycle=null,roundNumber=0,resetting=false;
  let jumpHeld=false,edgePressed=0,edgeReleased=0,latestBuildSha256=null;
  const statusListeners=new Set();
  const notify=()=>{
    const current=status();
    for(const callback of statusListeners)callback(current);
  };
  const send=value=>{
    if(ws.readyState!==WebSocket.OPEN||closed)return false;
    ws.send(JSON.stringify(value));return true;
  };
  const allowedKeys=new Set(['ArrowLeft','ArrowRight','ArrowUp','KeyA','KeyD','KeyW','Space','KeyP','KeyR']);
  function moveDirection(){
    const left=keys.has('ArrowLeft')||keys.has('KeyA');
    const right=keys.has('ArrowRight')||keys.has('KeyD');
    return Number(right)-Number(left);
  }
  const jumpDown=()=>keys.has('ArrowUp')||keys.has('KeyW')||keys.has('Space');
  function reconcileEdges(){
    const down=jumpDown();
    if(down&&!jumpHeld)edgePressed|=1;
    if(!down&&jumpHeld)edgeReleased|=1;
    jumpHeld=down;
  }
  function sendInput(){
    if(closed||resetting||lifecycle||seat===null||!room?.bothReady||room.effectivePaused)return false;
    reconcileEdges();
    const packet={type:'input',seq:seq++,moveX:moveDirection(),moveY:0,
      buttons:jumpHeld?1:0,pressed:edgePressed,released:edgeReleased};
    if(!send(packet))return false;
    edgePressed=0;edgeReleased=0;
    return true;
  }
  function issuePause(){
    if(!room?.bothReady||roomEpoch===null||closed||lifecycle||resetting)return;
    // The authoritative room toggles its most current pause state in the
    // serialized command queue. Another tab may not yet have the new revision.
    send({type:'room-command',command:'pause.toggle',
      roomEpoch,commandId:'view-'+seat+'-'+(++commandSeq)});
  }
  function requestRestart(){
    if(closed||resetting||roomEpoch===null||seat===null||
       (!lifecycle&&!room?.suspendedReason))return false;
    return send({type:'room-command',command:'round.restart.vote',
      roomEpoch,roundNumber,commandId:'view-'+seat+'-restart-'+(++commandSeq)});
  }
  function keyDown(event){
    if(!allowedKeys.has(event.code))return;
    event.preventDefault();
    if(event.code==='KeyR'){
      if(!event.repeat)requestRestart();
      return;
    }
    if(event.code==='KeyP'){
      if(!event.repeat)issuePause();
      return;
    }
    keys.add(event.code);reconcileEdges();
    if(!event.repeat)sendInput();
  }
  function keyUp(event){
    if(!allowedKeys.has(event.code))return;
    event.preventDefault();keys.delete(event.code);reconcileEdges();sendInput();
  }
  function blur(){
    keys.clear();reconcileEdges();sendInput();
  }
  function status(){
    return {seat,room,initial,frames,lastError,lifecycle,roundNumber,resetting,
      latestSeq:latestState?.snapshot?.snapshotSeq??null,
      lastApply,readyState:ws.readyState,viewerGamePaused:game.paused};
  }
  async function applyRoundReset(message){
    if(message.roomEpoch!==roomEpoch ||
       !Number.isSafeInteger(message.roundNumber) ||
       message.roundNumber!==roundNumber+1 ||
       message.snapshot?.schemaVersion!==1 ||
       message.snapshot?.sessionEpoch!==roomEpoch ||
       !Number.isSafeInteger(message.levelEpoch) ||
       message.levelEpoch!==message.snapshot.levelEpoch ||
       typeof message.gameSha256!=='string' ||
       message.gameSha256!==latestBuildSha256)
      throw Error('Wrong restart round, session, or source build');
    if(resetting)throw Error('Concurrent restart refused');
    resetting=true;
    keys.clear();jumpHeld=false;edgePressed=0;edgeReleased=0;
    const oldLevel=game.level;
    const oldRoot=oldLevel?.root,oldFire=oldLevel?.pers1,oldWater=oldLevel?.pers2;
    try{
      projection.uninstall();
      // The existing native retry() must run its own Phaser scene transition.
      // No character location, physics body or gameplay status is fabricated.
      game.paused=false;
      if(typeof oldLevel?.retry!=='function')throw Error('Native retry missing from spectator');
      oldLevel.retry.call(oldLevel);
      const deadline=Date.now()+45000;
      while(Date.now()<deadline){
        if(game.state?.current==='level'&&!game.state.fading &&
           game.level?.levelStarted && game.level?.pers1?.body &&
           game.level?.pers2?.body &&
           (game.level!==oldLevel || game.level.pers1!==oldFire ||
            game.level.pers2!==oldWater || game.level.root!==oldRoot))break;
        await new Promise(resolve=>setTimeout(resolve,40));
      }
      if(!(game.state?.current==='level'&&game.level?.levelStarted&&
           game.level?.pers1?.body&&game.level?.pers2?.body&&
           (game.level!==oldLevel || game.level.pers1!==oldFire ||
            game.level.pers2!==oldWater || game.level.root!==oldRoot)))
        throw Error('Native viewer retry did not rebuild scene within deadline');
      projection=installHtml5Spectator(game,{devices});
      lastApply=projection.initialize(message.snapshot);
      initial=true;
      latestState={snapshot:message.snapshot};
      frames++;
      roundNumber=message.roundNumber;
      seq=0;
      resetting=false;
      lifecycle=null;
      room=message.room;
      lastError=null;
      if(!send({type:'ready',roundNumber}))
        throw Error('Could not acknowledge restarted viewer round');
      notify();
    }catch(err){
      resetting=false;
      lifecycle={reason:'ROUND_RESET_FAILED',message:err.message,
        levelEpoch:message.levelEpoch};
      lastError='ROUND_RESET_FAILED: '+err.message;
      notify();
      throw err;
    }
  }
  ws.onmessage=event=>{
    let message;
    try{message=JSON.parse(event.data);}catch{lastError='BAD_JSON';notify();return;}
    if(message.type==='welcome'){
      seat=message.slot;roomEpoch=message.room?.roomEpoch;
      latestBuildSha256=message.gameSha256;
      if(seat!==0&&seat!==1){lastError='INVALID_SEAT';notify();return;}
      room=message.room;roundNumber=room.roundNumber??0;
      send({type:'ready',roundNumber});notify();return;
    }
    if(message.type==='room'){room=message.room;notify();return;}
    if(message.type==='round-reset'){
      void applyRoundReset(message).catch(error=>{
        lastError='ROUND_RESET_FAILED: '+error.message;
        notify();
      });
      return;
    }
    if(message.type==='lifecycle'){
      if(message.roomEpoch!==roomEpoch||
        typeof message.reason!=='string'||!/^[-A-Z_]{3,64}$/.test(message.reason)){
        lastError='BAD_LIFECYCLE_EVENT';notify();return;
      }
      // Do not send obsolete key states after the native authority has rebuilt
      // its level. A future re-arm handshake must reinstall this projection.
      lifecycle={reason:message.reason,levelEpoch:message.levelEpoch??null,
        snapshotSeq:message.snapshotSeq??null,restartSupported:false};
      keys.clear();jumpHeld=false;edgePressed=0;edgeReleased=0;
      notify();return;
    }
    if(message.type==='state'){
      try{
        if(!initial){lastApply=projection.initialize(message.snapshot);initial=true;}
        else lastApply=projection.apply(message.snapshot);
        latestState=message;frames++;lastError=null;
      }catch(error){lastError='PROJECTION: '+error.message;}
      notify();return;
    }
    if(message.type==='error'){lastError=message.code;notify();return;}
    if(message.type==='pause-receipt'){notify();}
  };
  ws.onerror=()=>{lastError='WEBSOCKET_ERROR';notify();};
  ws.onclose=()=>{if(!closed)lastError='WEBSOCKET_CLOSED';notify();};
  document.addEventListener('keydown',keyDown,true);
  document.addEventListener('keyup',keyUp,true);
  window.addEventListener('blur',blur);
  const heartbeat=setInterval(sendInput,40);
  function onStatus(callback){
    if(typeof callback!=='function')throw new TypeError('callback is required');
    statusListeners.add(callback);
    return ()=>statusListeners.delete(callback);
  }
  function close(){
    if(closed)return;
    // Send the explicit leave before setting closed: send() rejects closed clients.
    if(ws.readyState===WebSocket.OPEN)send({type:'leave'});
    closed=true;clearInterval(heartbeat);keys.clear();
    document.removeEventListener('keydown',keyDown,true);
    document.removeEventListener('keyup',keyUp,true);
    window.removeEventListener('blur',blur);
    ws.close();projection.uninstall();notify();
  }
  return Object.freeze({status,onStatus,close,sendInput,requestRestart,
    get projection(){return projection;},lastSnapshot:()=>latestState?.snapshot??null});
}
