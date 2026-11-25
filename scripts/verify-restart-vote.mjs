#!/usr/bin/env node
/**
 * Loopback research acceptance: real native death handler -> scene-guard
 * lifecycle -> automatic retry -> round-reset baseline. No death vote is
 * required; LEVEL_WON still keeps its separate player confirmation flow.
 * Uses an ephemeral port and never touches the live lobby.
 */
import {WebSocket} from 'ws';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';
import {loadGameCatalog,gameFor} from '../server/game-catalog.mjs';

const root='E:/肥鱼不乐园/flash-archive/02-fireboy-watergirl/html5-online/games';
const log=(...args)=>console.log('[vote]',...args);
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function assert(condition,message){if(!condition)throw Error(message);}

function connect(url,label,logical){
  const ws=new WebSocket(url);
  const inbox=[];
  ws.on('message',buffer=>{
    const message=JSON.parse(buffer.toString());
    inbox.push(message);
    log(label,'<-',message.type,message.type==='welcome'?{seat:message.slot}:message.reason??message.code??'');
  });
  return {ws,inbox,label,logical};
}
async function waitFor(client,predicate,timeout=20000,label='message'){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const found=client.inbox.find(predicate);
    if(found)return found;
    await sleep(50);
  }
  throw Error(client.label+' timed out waiting for '+label+' :: '+JSON.stringify(client.inbox.slice(-6)));
}

async function main(){
  const catalog=await loadGameCatalog({root});
  const game=gameFor(catalog,'forest');
  const room=await startHtml5ResearchRoom({root,script:game.script,requireScript:game.requireScript,
    entryPath:game.entryPath,levelId:1,templeId:game.templeId,storagePrefix:game.storagePrefix,
    gameId:game.id,port:0});
  const clients=[];
  try{
    const wsUrl=room.url.replace('http','ws')+'/ws';
    log('room',room.level,room.url);
    for(const [label,logical] of [['A',true],['B',false]]){
      const client=connect(wsUrl,label,logical);
      clients.push(client);
      client.welcome=await waitFor(client,m=>m.type==='welcome',20000,'welcome');
      if(logical)assert(client.welcome.slot===0,'first client did not receive seat 0');
    }
    const roomEpoch=clients[0].welcome.room.roomEpoch;
    assert(roomEpoch===clients[1].welcome.room.roomEpoch,'room epochs differ');
    for(const client of clients)client.ws.send(JSON.stringify({type:'ready',roundNumber:0}));
    const deadline=Date.now()+15000;
    while(!room.room.running&&Date.now()<deadline)await sleep(50);
    assert(room.room.running,'room did not start after both ready');
    log('both ready; invoking native kill()');

    const killed=await room.invokeNativeDeathForResearch();
    assert(killed?.dying===true,'native kill() did not set dying');
    const lifeA=await waitFor(clients[0],m=>m.type==='lifecycle',20000,'lifecycle');
    const lifeB=await waitFor(clients[1],m=>m.type==='lifecycle',20000,'lifecycle');
    assert(['CHARACTER_DYING','CHARACTER_DEAD'].includes(lifeA.reason),'unexpected lifecycle '+lifeA.reason);
    assert(lifeA.reason===lifeB.reason,'lifecycle reasons differ');
    assert(room.room.suspendedReason===lifeA.reason,'room did not latch the lifecycle reason');
    log('suspended',lifeA.reason);

    // The authority schedules a single automatic retry after the death
    // lifecycle. No vote is sent by either seat.
    const resetA=await waitFor(clients[0],m=>m.type==='round-reset',60000,'round-reset');
    const resetB=await waitFor(clients[1],m=>m.type==='round-reset',60000,'round-reset');
    assert(resetA.roundNumber===1&&resetB.roundNumber===1,'round number not advanced');
    assert(resetA.action==='restart'&&resetB.action==='restart','unexpected round action');
    assert(resetA.snapshot?.coverage?.playableCore===true,'restart baseline is not playable');
    assert(resetA.levelEpoch===resetA.snapshot?.levelEpoch,'round epoch does not match its baseline');
    assert(room.room.roundNumber===1&&!room.room.restartPending,'room did not commit the new round');
    log('round-reset received',{levelEpoch:resetA.levelEpoch,chars:resetA.snapshot.characters.length,
      diamonds:resetA.snapshot.diamonds.length,mech:resetA.snapshot.mechanisms.length});
    const scene=await room.observeNativeSceneForResearch();
    assert(scene.levelChanged||scene.rootChanged||scene.fireChanged||scene.waterChanged,
      'native retry did not rebuild the scene');
    assert(scene.inputStale===false,'authority input bridge was not reinstalled');
    log('native scene rebuilt',scene);

    for(const client of clients)client.ws.send(JSON.stringify({type:'ready',roundNumber:1}));
    const readyDeadline=Date.now()+15000;
    while(!room.room.running&&Date.now()<readyDeadline)await sleep(50);
    assert(room.room.running,'room did not resume after restart acknowledgements');
    const live=await room.readAuthority();
    assert(live.snapshot?.coverage?.playableCore===true,'live authority snapshot regressed');
    console.log(JSON.stringify({ok:true,reason:lifeA.reason,round:room.room.roundNumber,
      levelEpoch:resetA.levelEpoch,characters:live.snapshot.characters.length,
      diamonds:live.snapshot.diamonds.length,mechanisms:live.snapshot.mechanisms.length},null,2));
  }finally{
    for(const client of clients)client.ws.close();
    await room.close().catch(()=>{});
  }
}
main().catch(error=>{console.error('VOTE_E2E_FAILED:',error.message);process.exitCode=1;});
