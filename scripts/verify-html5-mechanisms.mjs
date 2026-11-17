#!/usr/bin/env node
/**
 * Real HTML5 mechanism contact trial.
 * Controls are ordinary WebSocket player inputs, never teleports or device writes.
 * A failed attempt is not counted as mechanism activation.
 */
import {parseArgs} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {WebSocket} from 'ws';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';

const {values}=parseArgs({options:{root:{type:'string'},script:{type:'string'},
  'require-script':{type:'string'},'entry-path':{type:'string'},
  'level-id':{type:'string'},'expected-sha256':{type:'string'},
  seat:{type:'string'},direction:{type:'string'},out:{type:'string'}}});
const levelId=Number(values['level-id']??27);
const seat=Number(values.seat??0);
const direction=Number(values.direction??-1);
const out=path.resolve(values.out??'local/mechanism-trial');
await mkdir(out,{recursive:true});
const result={schemaVersion:1,status:'blocked',startedAt:new Date().toISOString(),levelId,
  sourceSha256:null,checks:[],trace:[],errors:[],originalPackageBaseline:false,
  controls:'ordinary network moveX and buttons only; no position or mechanism mutation'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let app;const wsList=[];
function connect(url){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url.replace(/^http/,'ws')+'/ws');
    const peer={ws,events:[]};
    ws.on('message',buffer=>{try{peer.events.push(JSON.parse(buffer.toString('utf8')))}catch{}});
    ws.once('error',reject);ws.once('open',()=>{wsList.push(peer);resolve(peer)});
  });
}
async function waitFor(check,timeout=12000){
  const limit=Date.now()+timeout;
  while(Date.now()<limit){const found=check();if(found)return found;await sleep(40);}
  throw Error('Timeout waiting for actual network/game event');
}
function pick(snapshot,leverId,platformId){
  const actor=snapshot.snapshot.characters.find(x=>x.slot===seat);
  const lever=snapshot.snapshot.mechanisms.find(x=>x.id===leverId);
  const platform=snapshot.snapshot.mechanisms.find(x=>x.id===platformId);
  return {at:Date.now(),actor:{x:actor?.position?.x,y:actor?.position?.y,
    dead:actor?.gameplay?.dead},
    ack:snapshot.input.slots[seat].ackSeq,
    gamePaused:snapshot.gamePaused,
    lever:lever?{x:lever.position?.x,y:lever.position?.y,
      angle:lever.rotation,state:lever.state,group:lever.group}:null,
    platform:platform?{x:platform.position?.x,y:platform.position?.y,
      state:platform.state,group:platform.group}:null};
}
try{
  if(!values.root||!values.script||!Number.isInteger(levelId)||![0,1].includes(seat)||
      ![-1,1].includes(direction))throw Error('Invalid required runtime or test parameters');
  app=await startHtml5ResearchRoom({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path'],levelId});
  result.sourceSha256=app.sourceSha256;result.level=app.level;
  if(values['expected-sha256']&&app.sourceSha256!==values['expected-sha256'])
    throw Error('Source script SHA differs from pinned experiment');
  const clients=await Promise.all([connect(app.url),connect(app.url)]);
  await waitFor(()=>clients.every((p,i)=>p.events.find(e=>e.type==='welcome'&&e.slot===i)));
  clients.forEach(p=>p.ws.send('{"type":"ready"}'));
  await waitFor(()=>clients[0].events.find(e=>e.type==='room'&&e.room?.bothReady&&!e.room.effectivePaused));
  const before=await app.readAuthority();
  result.runtimeMechanisms=await app.inspectMechanisms();
  result.snapshotUnsupported=before.snapshot.unsupported;
  result.allMechanisms=before.snapshot.mechanisms.map(x=>({id:x.id,kind:x.kind,sourcePaths:x.sourcePaths,
    group:x.group,mapObjectId:x.mapObjectId,position:x.position}));
  const actor=before.snapshot.characters.find(c=>c.slot===seat);
  const levers=before.snapshot.mechanisms.filter(x=>x.kind==='lever'&&
    Number.isFinite(x.position?.x)&&Number.isFinite(x.position?.y));
  const platforms=before.snapshot.mechanisms.filter(x=>x.kind==='platform');
  const candidates=levers.map(lever=>({lever,
    related:platforms.filter(platform=>platform.group===lever.group)}));
  // Do not choose a remote lever just because its linked platform happened to
  // have the same group. Preserve the entire runtime-discovered candidate set.
  result.discovery={
    actor:actor.position,
    levers:candidates.map(x=>({id:x.lever.id,position:x.lever.position,
      state:x.lever.state,group:x.lever.group,linkedPlatforms:x.related.map(p=>p.id)})),
    platforms:platforms.map(x=>({id:x.id,position:x.position,group:x.group,state:x.state}))
  };
  if(!candidates.length)throw Error('Selected level has no runtime-observed lever');
  const distance=x=>Math.hypot(x.lever.position.x-actor.position.x,
    x.lever.position.y-actor.position.y);
  candidates.sort((a,b)=>distance(a)-distance(b));
  const target=candidates[0];
  if(!target.related.length)throw Error('Nearest reachable lever has no mapped platform: capture the discrepancy, do not choose a distant actuator');
  const leverId=target.lever.id,platformId=target.related[0].id;
  result.target={seat,direction,lever:{id:leverId,position:target.lever.position,
    group:target.lever.group,state:target.lever.state},
    platform:{id:platformId,position:target.related[0].position},
    actorSpawn:actor.position};
  result.trace.push(pick(before,leverId,platformId));
  let seq=0,leverChanged=false,platformChanged=false;
  const first=result.trace[0];
  const peer=clients[seat];
  for(let t=0;t<125;t++){
    // A short real jump helps reach an elevated lever; the normal game
    // consumes the jump latch and decides whether physical contact occurs.
    const buttons=t>=4&&t<14?1:0;
    peer.ws.send(JSON.stringify({type:'input',seq:seq++,moveX:direction,
      moveY:0,buttons,pressed:0,released:0}));
    await sleep(65);
    if(t%2!==0)continue;
    const current=pick(await app.readAuthority(),leverId,platformId);
    result.trace.push(current);
    if(current.lever?.state!==first.lever?.state)leverChanged=true;
    if(current.platform&&first.platform&&Math.hypot(
      current.platform.x-first.platform.x,current.platform.y-first.platform.y)>3)platformChanged=true;
    if(leverChanged&&platformChanged)break;
    if(current.actor?.dead)break;
  }
  peer.ws.send(JSON.stringify({type:'input',seq:seq++,moveX:0,
    moveY:0,buttons:0,pressed:0,released:0}));
  await sleep(120);
  const after=pick(await app.readAuthority(),leverId,platformId);
  result.last=after;
  result.observation={leverChanged,platformChanged,
    actorTravelX:after.actor.x-first.actor.x,
    lastAppliedInputSeq:after.ack,packets:seq};
  if(after.ack>=0)result.checks.push('real-character-consumed-input');
  if(leverChanged)result.checks.push('lever-physically-changed-state');
  if(platformChanged)result.checks.push('linked-platform-physically-moved');
  if(after.ack<0)throw Error('Input never reached real character update');
  if(!leverChanged||!platformChanged)
    throw Error('No verified lever AND platform activation via this ordinary-control route');
  result.status='passed';
}catch(error){result.status='blocked';result.errors.push(String(error.stack||error));}
finally{
  for(const p of wsList)try{p.ws.terminate()}catch{}
  await app?.close().catch(error=>result.errors.push(String(error)));
  result.finishedAt=new Date().toISOString();
  await writeFile(path.join(out,'mechanism-trace.json'),JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify({status:result.status,level:result.level,
    target:result.target,observation:result.observation,checks:result.checks,
    errors:result.errors}));
  if(result.status!=='passed')process.exitCode=1;
}
