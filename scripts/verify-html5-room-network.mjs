#!/usr/bin/env node
/** Two actual websocket players, one real HTML5 Box2D authority; no video. */
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {WebSocket} from 'ws';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';
const {values}=parseArgs({options:{root:{type:'string'},script:{type:'string'},
  'require-script':{type:'string'},'entry-path':{type:'string'},
  'expected-sha256':{type:'string'},out:{type:'string'}}});
const report={schemaVersion:1,startedAt:new Date().toISOString(),status:'blocked',
  scope:'two WebSocket control clients -> one real HTML5 game -> shared structured snapshots',
  completeClientRenderingVerified:false,originalPackageBaseline:false,publicNetworkVerified:false,
  checks:[],errors:[]};
const out=path.resolve(values.out||'local/html5-room-results');
await mkdir(out,{recursive:true});
let room;const peers=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function waitFor(predicate,timeout=12000){
  const until=Date.now()+timeout;
  while(Date.now()<until){const value=predicate();if(value)return value;await sleep(30);}
  throw Error('Timed out waiting for real game/network event');
}
function connect(url){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url.replace(/^http/,'ws')+'/ws');
    const player={ws,messages:[],send:obj=>ws.send(JSON.stringify(obj)),
      first:match=>player.messages.find(match)};
    ws.on('message',buffer=>{try{player.messages.push(JSON.parse(buffer.toString()));}catch{}});
    ws.once('error',reject);ws.once('open',()=>{peers.push(player);resolve(player);});
  });
}
const input=(seq,moveX,buttons=0)=>({type:'input',seq,moveX,moveY:0,buttons});
const px=(message,slot)=>message?.snapshot?.characters?.find(x=>x.slot===slot)?.position?.x;
const pass=(name,value)=>report.checks.push({name,status:'passed',value});
try{
  if(!values.root||!values.script)throw Error('Private --root and --script required');
  room=await startHtml5ResearchRoom({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path']});
  report.gameSha256=room.sourceSha256;report.level=room.level;
  if(values['expected-sha256'])assert.equal(room.sourceSha256,values['expected-sha256']);
  const a=await connect(room.url),b=await connect(room.url);
  const wa=await waitFor(()=>a.first(x=>x.type==='welcome'));
  const wb=await waitFor(()=>b.first(x=>x.type==='welcome'));
  assert.equal(wa.slot,0);assert.equal(wb.slot,1);
  a.send({type:'ready'});b.send({type:'ready'});
  await waitFor(()=>a.first(x=>x.type==='room'&&x.room?.bothReady&&!x.room.effectivePaused));
  const base=await waitFor(()=>a.first(x=>x.type==='state'));
  const fireX=px(base,0),waterX=px(base,1);
  assert.ok(Number.isFinite(fireX)&&Number.isFinite(waterX));
  pass('seat-and-baseline',{fireX,waterX});
  b.send(input(0,1));
  const water=await waitFor(()=>b.first(x=>x.type==='state'&&x.ack?.[1]>=0&&px(x,1)>waterX+15));
  assert.ok(Math.abs(px(water,0)-fireX)<2,'Fire moved under Water-only input');
  const same=await waitFor(()=>a.first(x=>x.type==='state'&&x.broadcastSeq===water.broadcastSeq));
  assert.deepEqual(same.snapshot,water.snapshot);
  pass('water-input-isolated',{waterDeltaX:px(water,1)-waterX});
  pass('identical-authority-broadcast',{seq:same.broadcastSeq,counts:same.snapshot.counts});
  b.send(input(1,0));
  await waitFor(()=>b.first(x=>x.type==='state'&&x.ack?.[1]>=1));
  a.send(input(0,1));
  const fire=await waitFor(()=>a.first(x=>x.type==='state'&&x.ack?.[0]>=0&&px(x,0)>fireX+15));
  pass('fire-input-isolated',{fireDeltaX:px(fire,0)-fireX});
  a.send(input(1,0));
  await waitFor(()=>a.first(x=>x.type==='state'&&x.ack?.[0]>=1));
  const epoch=wa.room.roomEpoch;
  a.send({type:'room-command',command:'pause.set',roomEpoch:epoch,commandId:'pause',
    baseRevision:0,desiredPaused:true});
  await waitFor(()=>a.first(x=>x.type==='pause-receipt'&&x.accepted&&x.commandId==='pause'));
  const frozen=await room.readAuthority();
  assert.equal(frozen.gamePaused,true);
  assert.equal(frozen.physicsPaused,false);
  b.send(input(2,1));
  await waitFor(()=>b.first(x=>x.type==='error'&&x.code==='NOT_RUNNING'));
  pass('room-pause-with-engine-gate',{revision:room.room.pauseRevision});
  b.send({type:'room-command',command:'pause.set',roomEpoch:epoch,commandId:'resume',
    baseRevision:1,desiredPaused:false});
  await waitFor(()=>b.first(x=>x.type==='pause-receipt'&&x.accepted&&x.commandId==='resume'));
  await waitFor(()=>a.first(x=>x.type==='room'&&x.room?.pauseRevision===2&&!x.room.effectivePaused));
  assert.equal((await room.readAuthority()).gamePaused,false);
  pass('room-resume',{revision:room.room.pauseRevision});
  b.send(input(3,0,1));b.send(input(4,0));
  await waitFor(()=>b.first(x=>x.type==='state'&&x.ack?.[1]>=4));
  pass('short-jump-ACK-after-update',{ack:4});
  a.send({...input(2,0),slot:1});
  await waitFor(()=>a.first(x=>x.type==='error'&&x.code==='INVALID_INPUT_FIELDS'));
  pass('spoofed-seat-rejected',{code:'INVALID_INPUT_FIELDS'});
  const messageBoundary=a.messages.length;
  b.ws.close();
  await waitFor(()=>a.messages.slice(messageBoundary).find(x=>
    x.type==='room'&&x.room?.connected?.[1]===false&&!x.room.bothReady));
  await waitFor(()=>room.room.effectivePaused);
  assert.equal(room.room.effectivePaused,true);
  pass('disconnect-pauses-room',{effectivePaused:true});
  report.status='passed';
}catch(error){report.status='failed';report.errors.push(String(error.stack||error));}
finally{
  for(const peer of peers){try{peer.ws.terminate();}catch{}}
  if(room)await room.close().catch(error=>report.errors.push(String(error)));
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(out,'room-network-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,gameSha256:report.gameSha256,
    checks:report.checks.map(x=>x.name),errors:report.errors}));
  if(report.status!=='passed')process.exitCode=1;
}
