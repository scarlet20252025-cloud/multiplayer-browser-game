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
  const projection=installHtml5Spectator(game,{devices});
  const ws=new WebSocket(wsUrl);
  const keys=new Set();
  let seq=0,commandSeq=0,closed=false,seat=null,room=null,roomEpoch=null,
    initial=false,latestState=null,lastApply=null,lastError=null,frames=0,
    lifecycle=null;
  let jumpHeld=false,edgePressed=0,edgeReleased=0;
  const statusListeners=new Set();
  const notify=()=>{
    const current=status();
    for(const callback of statusListeners)callback(current);
  };
  const send=value=>{
    if(ws.readyState!==WebSocket.OPEN||closed)return false;
    ws.send(JSON.stringify(value));return true;
  };
  const allowedKeys=new Set(['ArrowLeft','ArrowRight','ArrowUp','KeyA','KeyD','KeyW','Space','KeyP']);
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
    if(closed||lifecycle||seat===null||!room?.bothReady||room.effectivePaused)return false;
    reconcileEdges();
    const packet={type:'input',seq:seq++,moveX:moveDirection(),moveY:0,
      buttons:jumpHeld?1:0,pressed:edgePressed,released:edgeReleased};
    if(!send(packet))return false;
    edgePressed=0;edgeReleased=0;
    return true;
  }
  function issuePause(){
    if(!room?.bothReady||roomEpoch===null||closed||lifecycle)return;
    send({type:'room-command',command:'pause.set',
      roomEpoch,commandId:'view-'+seat+'-'+(++commandSeq),
      baseRevision:room.pauseRevision,desiredPaused:!room.userPaused});
  }
  function keyDown(event){
    if(!allowedKeys.has(event.code))return;
    event.preventDefault();
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
    return {seat,room,initial,frames,lastError,lifecycle,
      latestSeq:latestState?.snapshot?.snapshotSeq??null,
      lastApply,readyState:ws.readyState,viewerGamePaused:game.paused};
  }
  ws.onmessage=event=>{
    let message;
    try{message=JSON.parse(event.data);}catch{lastError='BAD_JSON';notify();return;}
    if(message.type==='welcome'){
      seat=message.slot;roomEpoch=message.room?.roomEpoch;
      if(seat!==0&&seat!==1){lastError='INVALID_SEAT';notify();return;}
      room=message.room;send({type:'ready'});notify();return;
    }
    if(message.type==='room'){room=message.room;notify();return;}
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
  return Object.freeze({status,onStatus,close,sendInput,projection,
    lastSnapshot:()=>latestState?.snapshot??null});
}
