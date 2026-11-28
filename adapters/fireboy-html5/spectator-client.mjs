/**
 * Local research browser client: game artwork is loaded privately into each
 * browser, while authoritative rules execute only in the room's browser.
 * The viewing game stays paused; incoming snapshots drive visual sprites.
 * Does NOT establish complete gameplay/render synchronization.
 */
import {installHtml5Spectator} from './spectator-projection.mjs';

export function connectHtml5Spectator({game,wsUrl,devices=globalThis.Devices,smooth=false,smoothingMs=45,
  expectedSeat=null,expectedServedSha256=null,expectedLevelId=null,resumeKey=null}={}){
  if(!game?.level||typeof wsUrl!=='string'||!/^wss?:\/\//.test(wsUrl))
    throw new TypeError('Loaded game and WebSocket URL required');
  if(typeof smooth!=='boolean')throw new TypeError('smooth must be boolean');
  if(!Number.isFinite(smoothingMs)||smoothingMs<5||smoothingMs>500)
    throw new RangeError('smoothingMs must be between 5 and 500');
  if(expectedSeat!==null&&(!Number.isInteger(expectedSeat)||expectedSeat<0||expectedSeat>3))
    throw new RangeError('expectedSeat must be 0..3');
  if(expectedServedSha256!==null&&!/^[a-f0-9]{64}$/.test(expectedServedSha256))
    throw new TypeError('expectedServedSha256 must be a SHA-256');
  if(expectedLevelId!==null&&!Number.isInteger(expectedLevelId))
    throw new TypeError('expectedLevelId must be an integer');
  let projection=installHtml5Spectator(game,{devices,smooth,smoothingMs,localSeat:expectedSeat});
  const ws=new WebSocket(wsUrl);
  const keys=new Set();
  let touchKeys=new Set();
  let seq=0,commandSeq=0,closed=false,seat=null,room=null,roomEpoch=null,
    initial=false,latestState=null,lastApply=null,lastError=null,frames=0,
    lifecycle=null,roundNumber=0,resetting=false,returning=false;
  let jumpHeld=false,edgePressed=0,edgeReleased=0,latestBuildSha256=null,sessionTempleId='forest';
  let roundResets=0,recoveryScheduled=false;
  const scheduleCleanReload=delay=>{
    if(recoveryScheduled||typeof location==='undefined')return;
    recoveryScheduled=true;
    setTimeout(()=>location.reload(),delay);
  };
  if(typeof window!=='undefined'&&typeof window.addEventListener==='function')
    window.addEventListener('webglcontextlost',event=>{
      // A lost WebGL context is the usual cause of a black Phaser canvas after
      // repeated scene rebuilds. A fresh page reconnects to the same authority
      // session instead of leaving a frozen black canvas.
      event.preventDefault();
      scheduleCleanReload(800);
    },true);
  const statusListeners=new Set();
  const notify=()=>{
    const current=status();
    for(const callback of statusListeners)callback(current);
  };
  const send=value=>{
    if(ws.readyState!==WebSocket.OPEN||closed)return false;
    ws.send(JSON.stringify(value));return true;
  };
  const allowedKeys=new Set(['ArrowLeft','ArrowRight','ArrowUp','KeyA','KeyD','KeyW','Space','KeyP','KeyR','KeyN']);
  const keyHeld=code=>keys.has(code)||touchKeys.has(code);
  function moveDirection(){
    const left=keyHeld('ArrowLeft')||keyHeld('KeyA');
    const right=keyHeld('ArrowRight')||keyHeld('KeyD');
    return Number(right)-Number(left);
  }
  const jumpDown=()=>keyHeld('ArrowUp')||keyHeld('KeyW')||keyHeld('Space');
  function reconcileEdges(){
    const down=jumpDown();
    if(down&&!jumpHeld)edgePressed|=1;
    if(!down&&jumpHeld)edgeReleased|=1;
    jumpHeld=down;
  }
  const acceptsInput=()=>!closed&&!resetting&&!lifecycle&&seat!==null&&room?.bothReady&&!room.effectivePaused;
  function sendInput(){
    if(!acceptsInput())return false;
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
  function requestAdvance(){
    if(closed||resetting||roomEpoch===null||seat===null||
       (room?.suspendedReason??lifecycle?.reason)!=='LEVEL_WON')return false;
    return send({type:'room-command',command:'round.advance.vote',
      roomEpoch,roundNumber,commandId:'view-'+seat+'-advance-'+(++commandSeq)});
  }
  function returnCommand(command){
    if(closed||resetting||returning||roomEpoch===null||seat===null)return false;
    return send({type:'room-command',command,roomEpoch,roundNumber,
      commandId:'view-'+seat+'-'+command+'-'+(++commandSeq)});
  }
  function requestReturn(){return returnCommand('return.request');}
  function confirmReturn(){return returnCommand('return.confirm');}
  function cancelReturn(){return returnCommand('return.cancel');}
  function syncLocalInput(){
    projection?.setLocalInput?.({moveX:moveDirection()});
  }
  function setTouchInput(next){
    if(closed||(next.size&&!acceptsInput()))return;
    touchKeys=new Set(next);reconcileEdges();syncLocalInput();sendInput();
  }
  function keyDown(event){
    if(!allowedKeys.has(event.code))return;
    event.preventDefault();
    // The viewer's native game must never receive the local player's keys;
    // only the authoritative room is allowed to apply them.
    event.stopImmediatePropagation?.();
    if(event.code==='KeyN'){
      if(!event.repeat)requestAdvance();
      return;
    }
    if(event.code==='KeyR'){
      if(!event.repeat && !['CHARACTER_DEAD','CHARACTER_DYING'].includes(lifecycle?.reason))requestRestart();
      return;
    }
    if(event.code==='KeyP'){
      if(!event.repeat)issuePause();
      return;
    }
    keys.add(event.code);reconcileEdges();syncLocalInput();
    if(!event.repeat)sendInput();
  }
  function keyUp(event){
    if(!allowedKeys.has(event.code))return;
    event.preventDefault();event.stopImmediatePropagation?.();
    keys.delete(event.code);reconcileEdges();syncLocalInput();sendInput();
  }
  function blur(){
    keys.clear();touchKeys.clear();reconcileEdges();syncLocalInput();sendInput();
  }
  function status(){
    return {seat,room,initial,frames,lastError,lifecycle,roundNumber,resetting,returning,
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
    if(!['restart','advance'].includes(message.action))
      throw Error('Unrecognized native scene action');
    resetting=true;
    keys.clear();touchKeys.clear();jumpHeld=false;edgePressed=0;edgeReleased=0;
    const oldLevel=game.level;
    const oldRoot=oldLevel?.root,oldFire=oldLevel?.pers1,oldWater=oldLevel?.pers2;
    try{
      projection.uninstall();
      // The existing native retry() must run its own Phaser scene transition.
      // No character location, physics body or gameplay status is fabricated.
      game.paused=false;
      if(message.action==='advance'){
        if(!(Number.isSafeInteger(message.level?.id)&&message.level.id>=0))
          throw Error('Unexpected native next-level progression');
        const menu=game.state?.states?.levelMenu;
        const temple=game.progress.get('temples').find(t=>t.id===sessionTempleId);
        const selected=temple?.levels?.find(x=>x.id===message.level.id);
        if(!menu||typeof menu.startLevel!=='function'||
           !selected||selected.filename!==message.level.filename)
          throw Error('Original native next-level menu is unavailable');
        menu.startLevel({data:selected});
      }else{
        if(typeof oldLevel?.retry!=='function')throw Error('Native retry missing from spectator');
        oldLevel.retry.call(oldLevel);
      }
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
      projection=installHtml5Spectator(game,{devices,smooth,smoothingMs,localSeat:seat});
      syncLocalInput();
      lastApply=projection.initialize(message.snapshot);
      initial=true;
      latestState={snapshot:message.snapshot};
      frames++;
      roundNumber=message.roundNumber;
      seq=0;
      resetting=false;
      roundResets++;
      // Keep the address bar in step with an advanced level. Without this a
      // refresh always requests the original level and silently rewinds the
      // player even though the authority is already in the next temple room.
      if(typeof history!=='undefined'&&typeof location!=='undefined'&&
         Number.isInteger(message.level?.id)){
        const nextUrl=new URL(location.href);
        nextUrl.searchParams.set('level',String(message.level.id));
        history.replaceState(null,'',nextUrl);
      }
      // Phaser/WebGL can survive a few scene rebuilds but eventually loses its
      // drawable after repeated rapid deaths. Reconnect before that happens.
      if(roundResets>=4)scheduleCleanReload(1200);
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
      // Native scene rebuilds can exhaust a viewer's graphics context after
      // several rapid rounds. A fresh page reconnects to the same authority
      // session and installs a clean projection instead of staying black.
      if(typeof location!=='undefined')
        setTimeout(()=>location.reload(),2000);
      throw err;
    }
  }
  ws.onmessage=event=>{
    let message;
    try{message=JSON.parse(event.data);}catch{lastError='BAD_JSON';notify();return;}
    if(message.type==='welcome'){
      seat=message.slot;roomEpoch=message.room?.roomEpoch;
      latestBuildSha256=message.gameSha256;
      if(expectedSeat!==null&&seat!==expectedSeat){
        lastError='SEAT_MISMATCH';notify();return;
      }
      if(expectedServedSha256!==null&&message.servedSha256!==expectedServedSha256){
        lastError='GAME_BUILD_MISMATCH';notify();return;
      }
      if(expectedLevelId!==null&&message.level?.id!==expectedLevelId){
        lastError='LEVEL_MISMATCH';notify();return;
      }
      if(typeof message.templeId==='string'&&/^[a-z][a-z-]{1,31}$/.test(message.templeId))
        sessionTempleId=message.templeId;
      const seatCapacity=Number.isInteger(message.room?.capacity)?message.room.capacity:2;
      if(!Number.isInteger(seat)||seat<0||seat>=Math.min(4,seatCapacity))
        {lastError='INVALID_SEAT';notify();return;}
      // 席位续租票：刷新或短暂掉线后带回去坐回原位。
      if(resumeKey&&typeof message.resumeToken==='string'){
        try{sessionStorage.setItem(resumeKey,message.resumeToken);}catch{}
      }
      if(message.resumed&&typeof console!=='undefined')
        console.info('HTML5 spectator resumed seat '+seat);
      if(expectedSeat===null)projection.setLocalSeat?.(seat);
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
    if(message.type==='return-to-lobby'){
      if(message.roomEpoch!==roomEpoch||!Number.isSafeInteger(message.roundNumber)){
        lastError='BAD_RETURN_EVENT';notify();return;
      }
      returning=true;keys.clear();touchKeys.clear();jumpHeld=false;edgePressed=0;edgeReleased=0;
      notify();return;
    }
    if(message.type==='return-vote-receipt'){notify();return;}
    if(message.type==='lifecycle'){
      if(message.roomEpoch!==roomEpoch||
        typeof message.reason!=='string'||!/^[-A-Z_]{3,64}$/.test(message.reason)){
        lastError='BAD_LIFECYCLE_EVENT';notify();return;
      }
      // Do not send obsolete key states after the native authority has rebuilt
      // its level. A future re-arm handshake must reinstall this projection.
      lifecycle={reason:message.reason,levelEpoch:message.levelEpoch??null,
        snapshotSeq:message.snapshotSeq??null,restartSupported:false};
      keys.clear();touchKeys.clear();jumpHeld=false;edgePressed=0;edgeReleased=0;
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
  let reconnectNotice=null;
  ws.onclose=(event)=>{
    if(closed)return;
    // Keep a more specific authority/projection error if one was already set;
    // otherwise record the close code so WEBSOCKET_CLOSED is not mistaken for
    // the root cause in user reports.
    if(!lastError)lastError='WEBSOCKET_CLOSED ('+(event?.code??'?')+')';
    notify();
    // A refresh can briefly close both viewer sockets while the authority is
    // still rebuilding a round. Give the server's empty-session grace time,
    // then return to the room instead of leaving a dead game page on screen.
    if(!returning&&typeof location!=='undefined'&&!reconnectNotice){
      reconnectNotice=setTimeout(()=>{
        const roomName=new URLSearchParams(location.search).get('room');
        location.href='/'+(roomName?'?room='+encodeURIComponent(roomName):'');
      },5000);
    }
  };
  document.addEventListener('keydown',keyDown,true);
  document.addEventListener('keyup',keyUp,true);
  window.addEventListener('blur',blur);
  const heartbeat=setInterval(sendInput,20);
  function onStatus(callback){
    if(typeof callback!=='function')throw new TypeError('callback is required');
    statusListeners.add(callback);
    return ()=>statusListeners.delete(callback);
  }
  function close(){
    if(closed)return;
    // Send the explicit leave before setting closed: send() rejects closed clients.
    if(ws.readyState===WebSocket.OPEN)send({type:'leave'});
    closed=true;clearInterval(heartbeat);keys.clear();touchKeys.clear();
    document.removeEventListener('keydown',keyDown,true);
    document.removeEventListener('keyup',keyUp,true);
    window.removeEventListener('blur',blur);
    ws.close();projection.uninstall();notify();
  }
  return Object.freeze({status,onStatus,close,sendInput,setTouchInput,requestRestart,requestAdvance,
    requestReturn,confirmReturn,cancelReturn,
    get projection(){return projection;},lastSnapshot:()=>latestState?.snapshot??null});
}
