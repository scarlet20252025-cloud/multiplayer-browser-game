#!/usr/bin/env node
// Real native Fireboy hazard contact via regular WebSocket movement; no teleports.
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {WebSocket} from 'ws';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';
const {values}=parseArgs({options:{
  root:{type:'string'},script:{type:'string'},'expected-sha256':{type:'string'},
  'require-script':{type:'string'},'entry-path':{type:'string'},out:{type:'string'}
}});
const dest=path.resolve(values.out??'local/native-hazard-observation');
await mkdir(dest,{recursive:true});
const result={schemaVersion:1,status:'blocked',game:'HTML5 Forest Temple first tutorial',
  originalPackageBaseline:false,deathObserved:false,roomSuspended:false,
  controls:'ordinary Fireboy right motion only',trace:[],checks:[],errors:[]};
let app;const peers=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function connect(url){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url.replace(/^http/,'ws')+'/ws');
    const client={ws,events:[],send:obj=>ws.send(JSON.stringify(obj))};
    ws.on('message',buffer=>{
      try{client.events.push(JSON.parse(buffer.toString('utf8')))}catch{}
    });
    ws.once('error',reject);ws.once('open',()=>{peers.push(client);resolve(client)});
  });
}
async function until(predicate,timeout=12000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await predicate();if(value)return value;await delay(40);}
  throw Error('Timed out waiting for native game event');
}
try{
  if(!values.root||!values.script)throw Error('Private HTML5 directory and script required');
  app=await startHtml5ResearchRoom({
    root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path'],
    levelId:1
  });
  result.sourceSha256=app.sourceSha256;
  if(values['expected-sha256']&&values['expected-sha256']!==app.sourceSha256)
    throw Error('Wrong research build hash');
  const fire=await connect(app.url);
  const water=await connect(app.url);
  await until(()=>fire.events.some(m=>m.type==='welcome')&&
    water.events.some(m=>m.type==='welcome'));
  fire.send({type:'ready'});water.send({type:'ready'});
  await until(()=>app.room.running&&fire.events.some(m=>m.type==='state'));
  let sawNativeDeath=false,deadMarker=null;
  for(let i=0;i<160;i++){
    if(!app.room.running)break;
    fire.send({type:'input',seq:i,moveX:1,moveY:0,buttons:0,pressed:0,released:0});
    await delay(75);
    const s=await app.readAuthority();
    const player=s.snapshot.characters.find(c=>c.slot===0);
    const point={index:i,x:player?.position?.x??null,y:player?.position?.y??null,
      dead:player?.gameplay?.dead??null,dying:player?.gameplay?.dying??null,
      ended:s.snapshot.level.ended??null,epoch:s.snapshot.levelEpoch,
      roomSuspendedReason:app.room.suspendedReason};
    if(i%3===0||point.dead||point.dying||point.roomSuspendedReason)
      result.trace.push(point);
    if(point.dead===true||point.dying===true){
      sawNativeDeath=true;deadMarker=point;break;
    }
  }
  result.deathObserved=sawNativeDeath;
  result.deathMarker=deadMarker;
  result.roomSuspended=app.room.suspendedReason!==null;
  result.lifecycle=fire.events.find(e=>e.type==='lifecycle')??null;
  result.suspendedReason=app.room.suspendedReason;
  if(!sawNativeDeath)
    throw Error('No actual native character dead/dying flag observed on this input route');
  result.checks.push('original-character-entered-dead-or-dying');
  await until(()=>app.room.suspendedReason!==null,12000);
  if(!['CHARACTER_DEAD','CHARACTER_DYING','LEVEL_ENDED',
        'LEVEL_EPOCH_CHANGED','NATIVE_SCENE_CHANGED'].includes(app.room.suspendedReason))
    throw Error('Native death did not result in a recognized room lifecycle boundary');
  result.checks.push('real-room-suspended-on-native-death');
  const notice=await until(()=>fire.events.find(e=>e.type==='lifecycle'));
  result.lifecycle=notice;
  if(!water.events.some(e=>e.type==='lifecycle'))
    await until(()=>water.events.find(e=>e.type==='lifecycle'));
  result.checks.push('both-seats-notified');
  result.status='passed';
}catch(error){result.errors.push(String(error.stack||error));}
finally{
  for(const p of peers)try{p.ws.terminate()}catch{}
  await app?.close().catch(err=>result.errors.push(String(err)));
  result.finishedAt=new Date().toISOString();
  await writeFile(path.join(dest,'native-hazard-trace.json'),
    JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({
    status:result.status,death:result.deathObserved,reason:result.suspendedReason,
    marker:result.deathMarker,checks:result.checks,errors:result.errors
  }));
  if(result.status!=='passed')process.exitCode=1;
}
