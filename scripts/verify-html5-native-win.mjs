#!/usr/bin/env node
/** Genuine Forest Temple win trial, not a fabricated door or gameFinish call.
 * One original-game Chromium authority, two authenticated WS seats.
 */
import {parseArgs} from 'node:util';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {WebSocket} from 'ws';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';

const {values}=parseArgs({options:{
  root:{type:'string'},script:{type:'string'},out:{type:'string'},
  'entry-path':{type:'string'},'require-script':{type:'string'},
  'expected-sha256':{type:'string'},'level-id':{type:'string'}
}});
const dir=path.resolve(values.out??'local/html5-win-observations');
await mkdir(dir,{recursive:true});
const report={schemaVersion:1,status:'blocked',nativeVictoryObserved:false,
  genuineInputOnly:true,mutatedNativeGameplay:false,originalPackageBaseline:false,
  checks:[],trace:[],errors:[],startedAt:new Date().toISOString()};
let app;
const peers=[];
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function connect(url){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url.replace(/^http/,'ws')+'/ws');
    const client={ws,events:[],send:msg=>ws.send(JSON.stringify(msg))};
    ws.on('message',buf=>{try{client.events.push(JSON.parse(buf.toString('utf8')))}catch{}});
    ws.once('error',reject);ws.once('open',()=>{peers.push(client);resolve(client)});
  });
}
async function until(check,ms=12000){
  const deadline=Date.now()+ms;
  while(Date.now()<deadline){const data=check();if(data)return data;await delay(45);}
  throw Error('Timed out waiting for two clients or native authority');
}
const button=(seq,moveX)=>({type:'input',seq,moveX,moveY:0,buttons:0,pressed:0,released:0});
try{
  if(!values.root||!values.script)throw Error('Private game root/script required');
  const levelId=Number(values['level-id']??13);
  if(!Number.isSafeInteger(levelId)||levelId<1)throw Error('Invalid official level ID');
  app=await startHtml5ResearchRoom({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path'],levelId});
  report.sourceSha256=app.sourceSha256;report.level=app.level;
  if(values['expected-sha256']&&values['expected-sha256']!==app.sourceSha256)
    throw Error('Research game build hash differs from expected');
  const [fire,water]=await Promise.all([connect(app.url),connect(app.url)]);
  await until(()=>fire.events.some(x=>x.type==='welcome'&&x.slot===0)&&
    water.events.some(x=>x.type==='welcome'&&x.slot===1));
  fire.send({type:'ready',roundNumber:0});water.send({type:'ready',roundNumber:0});
  await until(()=>app.room.running);
  let seq=0,observed=null;
  const start=await app.readAuthority();
  report.initial={characters:start.snapshot.characters.map(x=>({slot:x.slot,position:x.position})),
    doors:start.snapshot.doors.map(x=>({char:x.character,isUp:x.isUp,position:x.position}))};
  // Read-only scene feedback: stage13 has an upper floor ending at x=928,
  // and a lower intermediary platform at y=768. Each character receives
  // *different* left/right/jump inputs via its authenticated socket.
  const goals=start.snapshot.doors.map(d=>({
    char:d.character,x:d.position.x,y:d.position.y
  }));
  const slots=start.snapshot.characters.map(c=>({
    slot:c.slot,x:c.position.x,y:c.position.y,
    phase:'approach-upper-gap',jumpHeld:false,
    barrierA:false,barrierB:false,previousButtons:0
  }));
  report.plan={levelId,source:'read-only original ground tile/door observations',
    upperGapStartX:928,turnBackAtX:1020,midPlatformY:768,
    goals,notes:'Independent per-seat feedback; only natural keyboard movement and jump packets'};
  const limit=Date.now()+39000;
  while(Date.now()<limit && app.room.running){
    const state=await app.readAuthority();
    for(const slot of slots){
      const actor=state.snapshot.characters.find(p=>p.slot===slot.slot);
      if(!actor)throw Error('A real native character disappeared');
      slot.x=actor.position.x;slot.y=actor.position.y;
      if(slot.phase==='approach-upper-gap'&&slot.x>=1015)
        slot.phase='return-on-descent';
      if(slot.phase==='return-on-descent'&&slot.y>675&&slot.x<935)
        slot.phase='cross-middle-platform';
      if(slot.y>815)slot.phase='bottom-failure';
    }
    if(state.snapshot.doors.length===2 &&
       state.snapshot.doors.every(d=>d.isUp===true) &&
       state.snapshot.level.ended===true){
      observed={phase:'native-door-win',seq,
        doors:state.snapshot.doors.map(d=>({isUp:d.isUp,char:d.character})),
        characters:state.snapshot.characters.map(c=>({slot:c.slot,x:c.position.x,y:c.position.y}))};
      report.trace.push(observed);
      break;
    }
    let commands=[];
    for(const slot of slots){
      const goal=goals.find(g=>g.char===(slot.slot===0?'fb':'wg'));
      if(!goal||!Number.isFinite(goal.x))throw Error('Native target door not mapped');
      let moveX=0,jump=0;
      if(slot.phase==='approach-upper-gap')moveX=1;
      else if(slot.phase==='return-on-descent'||slot.phase==='cross-middle-platform'){
        moveX=-1;
        if(slot.phase==='cross-middle-platform'){
          for(const wall of [736,288]){
            if(slot.x<wall+62&&slot.x>wall+17&&slot.y>685&&slot.y<795)
              jump=1;
          }
        }
        if(slot.x<=goal.x+10&&slot.phase==='cross-middle-platform')
          slot.phase='hold-at-original-exit';
      }else if(slot.phase==='hold-at-original-exit'){
        moveX=Math.abs(slot.x-goal.x)<12?0:(goal.x>slot.x?1:-1);
      }
      // A jump press/release is a native input edge, not direct physics state.
      const pressed=jump&&!slot.previousButtons?1:0;
      const released=!jump&&slot.previousButtons?1:0;
      slot.previousButtons=jump;
      const msg={type:'input',seq,moveX,moveY:0,buttons:jump,pressed,released};
      (slot.slot===0?fire:water).send(msg);
      commands.push({slot:slot.slot,phase:slot.phase,moveX,jump,x:slot.x,y:slot.y,
        targetX:goal.x});
    }
    seq++;
    await delay(85);
    if(seq%4===0){
      const sample=await app.readAuthority();
      report.trace.push({seq,commands,
        characters:sample.snapshot.characters.map(c=>({slot:c.slot,x:c.position.x,
          y:c.position.y,dying:c.gameplay?.dying})),
        doors:sample.snapshot.doors.map(d=>({char:d.character,isUp:d.isUp,
          currentFrac:d.currentFrac})),
        ended:sample.snapshot.level.ended,reason:app.room.suspendedReason});
      if(report.trace.length>175)report.trace.shift();
    }
    if(slots.every(s=>s.phase==='bottom-failure'))break;
  }
  report.nativeVictoryObserved=!!observed;
  report.roomReason=app.room.suspendedReason;
  report.last=observed??report.trace.at(-1);
  report.packetCount=seq;
  if(!observed)throw Error('Normal two-player input route did not reach both native exits');
  report.checks.push('native-two-doors-both-raised-and-original-ended');
  await until(()=>app.room.suspendedReason==='LEVEL_WON',15000);
  const a=await until(()=>fire.events.find(x=>x.type==='lifecycle'&&x.reason==='LEVEL_WON'));
  const b=await until(()=>water.events.find(x=>x.type==='lifecycle'&&x.reason==='LEVEL_WON'));
  report.lifecycleEvents=[a,b];
  report.checks.push('both-connected-seats-observed-authoritative-level-won');
  report.status='passed';
}catch(error){report.errors.push(String(error.stack??error));}
finally{
  for(const peer of peers)try{peer.ws.terminate()}catch{}
  await app?.close().catch(err=>report.errors.push(String(err)));
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(dir,'native-dual-door-win.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,level:report.level,reason:report.roomReason,
    observed:report.nativeVictoryObserved,checks:report.checks,
    last:report.last,errors:report.errors}));
  if(report.status!=='passed')process.exitCode=1;
}
