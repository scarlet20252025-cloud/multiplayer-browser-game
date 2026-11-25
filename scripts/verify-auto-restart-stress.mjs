#!/usr/bin/env node
/**
 * Loopback stress acceptance for the automatic death restart path.
 * It exercises the real native death handler and native retry repeatedly with
 * two authenticated spectator sockets. No video, no votes, ephemeral ports.
 */
import {WebSocket} from 'ws';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';
import {loadGameCatalog,gameFor} from '../server/game-catalog.mjs';

const root='E:/肥鱼不乐园/flash-archive/02-fireboy-watergirl/html5-online/games';
const rounds=6;
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const log=(...args)=>console.log('[auto-restart]',...args);

function connect(url,label){
  const ws=new WebSocket(url);const inbox=[];
  ws.on('message',buffer=>{
    const message=JSON.parse(buffer.toString());inbox.push(message);
    if(['lifecycle','round-reset','error'].includes(message.type))
      log(label,'<-',message.type,message.reason??message.code??message.action??'');
  });
  return {ws,label,inbox};
}
async function waitFor(client,predicate,timeout=30000,label='message'){
  const deadline=Date.now()+timeout;
  while(Date.now()<deadline){
    const found=client.inbox.find(predicate);
    if(found)return found;
    await sleep(40);
  }
  throw Error(client.label+' timed out waiting for '+label+' :: '+
    JSON.stringify(client.inbox.slice(-5)));
}
async function ready(room,clients,roundNumber){
  for(const client of clients)client.ws.send(JSON.stringify({type:'ready',roundNumber}));
  const deadline=Date.now()+20000;
  while(!room.room.running&&Date.now()<deadline)await sleep(40);
  if(!room.room.running)throw Error('room did not start at round '+roundNumber);
}

async function main(){
  const catalog=await loadGameCatalog({root});
  const game=gameFor(catalog,'forest');
  const room=await startHtml5ResearchRoom({root,script:game.script,requireScript:game.requireScript,
    entryPath:game.entryPath,levelId:1,templeId:game.templeId,storagePrefix:game.storagePrefix,
    gameId:game.id,port:0});
  const clients=[];
  try{
    const url=room.url.replace('http','ws')+'/ws';
    for(const label of ['A','B']){
      const client=connect(url,label);clients.push(client);
      client.welcome=await waitFor(client,m=>m.type==='welcome',20000,'welcome');
    }
    await ready(room,clients,0);
    log('both seats ready');
    for(let round=0;round<rounds;round++){
      for(const client of clients)client.inbox.length=0;
      const killed=await room.invokeNativeDeathForResearch();
      if(!killed?.dying)throw Error('native kill failed at round '+round);
      const life=await waitFor(clients[0],m=>m.type==='lifecycle',20000,'lifecycle');
      if(!['CHARACTER_DYING','CHARACTER_DEAD'].includes(life.reason))
        throw Error('unexpected lifecycle '+life.reason);
      const resetA=await waitFor(clients[0],m=>m.type==='round-reset',60000,'round-reset A');
      const resetB=await waitFor(clients[1],m=>m.type==='round-reset',60000,'round-reset B');
      if(resetA.roundNumber!==round+1||resetB.roundNumber!==round+1)
        throw Error('round reset number mismatch A='+resetA.roundNumber+' B='+resetB.roundNumber+
          ' expected='+(round+1)+' room='+room.room.roundNumber);
      if(resetA.action!=='restart'||resetB.action!=='restart')
        throw Error('unexpected reset action');
      if(resetA.snapshot?.coverage?.playableCore!==true)
        throw Error('reset baseline is not playable');
      const scene=await room.observeNativeSceneForResearch();
      if(!scene.levelStarted||scene.inputStale!==false)
        throw Error('native scene not healthy after round '+round);
      log('round complete',{round:round+1,levelEpoch:resetA.levelEpoch,
        characters:resetA.snapshot.characters.length,scene:scene.sceneName});
      await ready(room,clients,round+1);
    }
    const live=await room.readAuthority();
    console.log(JSON.stringify({ok:true,rounds,roundNumber:room.room.roundNumber,
      characters:live.snapshot?.characters?.length??0,
      diamonds:live.snapshot?.diamonds?.length??0,
      mechanisms:live.snapshot?.mechanisms?.length??0},null,2));
  }finally{
    for(const client of clients)client.ws.close();
    await room.close().catch(()=>{});
  }
}
main().catch(error=>{console.error('AUTO_RESTART_STRESS_FAILED:',error.message);process.exitCode=1;});
