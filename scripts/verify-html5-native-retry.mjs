#!/usr/bin/env node
// Real native retry() method, two authenticated WS seats, old-scene isolation.
import {parseArgs} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {WebSocket} from 'ws';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';

const {values}=parseArgs({options:{
  root:{type:'string'},script:{type:'string'},'expected-sha256':{type:'string'},
  'require-script':{type:'string'},'entry-path':{type:'string'},out:{type:'string'}
}});
const dest=path.resolve(values.out||'local/html5-native-retry');
await mkdir(dest,{recursive:true});
const report={schemaVersion:1,status:'blocked',restartNativeHandlerInvoked:false,
  fullRestartHandshakeVerified:false,deathOrVictoryVerified:false,
  originalPackageBaseline:false,checks:[],errors:[]};
let app;
const clients=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=16000){
  const end=Date.now()+timeout;
  while(Date.now()<end){
    const x=await predicate();
    if(x)return x;
    await delay(60);
  }
  throw Error('Timed out waiting for native retry/room event');
}
function connect(url){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url.replace(/^http/,'ws')+'/ws');
    const peer={ws,events:[],send:object=>ws.send(JSON.stringify(object))};
    ws.on('message',bytes=>{
      try{peer.events.push(JSON.parse(bytes.toString('utf8')))}catch{}
    });
    ws.once('error',reject);
    ws.once('open',()=>{clients.push(peer);resolve(peer)});
  });
}
try{
  if(!values.root||!values.script)throw Error('A private runtime is required');
  app=await startHtml5ResearchRoom({
    root:values.root,script:values.script,requireScript:values['require-script'],
    entryPath:values['entry-path'],levelId:1
  });
  report.sourceSha256=app.sourceSha256;
  if(values['expected-sha256']&&report.sourceSha256!==values['expected-sha256'])
    throw Error('Unexpected original game build');
  const a=await connect(app.url),b=await connect(app.url);
  await waitFor(()=>a.events.some(m=>m.type==='welcome')&&
    b.events.some(m=>m.type==='welcome'));
  a.send({type:'ready'});
  b.send({type:'ready'});
  await waitFor(()=>app.room.running&&a.events.some(m=>m.type==='state'));
  const before=await app.readAuthority();
  const native=await app.inspectLifecycle();
  if(!native.levelMethods.includes('retry'))throw Error('Native retry() not present');
  report.before={
    epoch:before.snapshot.levelEpoch,
    firstPlayerId:before.snapshot.characters[0].id,
    scene:native.stateName
  };
  await app.invokeNativeRetryForResearch();
  report.restartNativeHandlerInvoked=true;
  const changed=await waitFor(async()=>{
    const info=await app.observeNativeSceneForResearch();
    return info.epoch>report.before.epoch &&
      (info.rootChanged||info.fireChanged||info.waterChanged||info.levelChanged)
      ?info:null;
  },20000);
  report.after=changed;
  report.checks.push('native-retry-replaced-level-identity');
  await waitFor(()=>app.room.suspendedReason!==null);
  report.room=app.room.publicState();
  if(app.room.running||!app.room.effectivePaused)
    throw Error('Old room continued to run after level replacement');
  report.checks.push('old-room-suspended');
  const event=await waitFor(()=>a.events.find(m=>m.type==='lifecycle'));
  report.lifecycle=event;
  if(!['LEVEL_EPOCH_CHANGED','LEVEL_STOPPED','NATIVE_SCENE_CHANGED'].includes(event.reason))
    throw Error('Unexpected lifecycle reason '+event.reason);
  report.checks.push('original-lifecycle-notified');
  const afterIndex=a.events.length;
  a.send({type:'input',seq:10000,moveX:1,moveY:0,buttons:0,pressed:0,released:0});
  await waitFor(()=>a.events.slice(afterIndex).find(m=>
    m.type==='error'&&m.code==='ROOM_SUSPENDED'));
  report.checks.push('old-seat-input-rejected');
  report.status='passed';
}catch(error){
  report.errors.push(String(error.stack||error));
}finally{
  for(const client of clients){try{client.ws.terminate()}catch{}}
  if(app)await app.close().catch(error=>report.errors.push(String(error)));
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(dest,'native-retry-results.json'),
    JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({
    status:report.status,checks:report.checks,reason:report.room?.suspendedReason,
    fromEpoch:report.before?.epoch,toEpoch:report.after?.epoch,errors:report.errors
  }));
  if(report.status!=='passed')process.exitCode=1;
}
