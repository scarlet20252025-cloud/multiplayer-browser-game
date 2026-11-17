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
  // Actual input plan: move toward the right-hand floor opening and return
  // toward the exits. Native Box2D decides whether this is a valid solution.
  const plan=[
    {name:'approach-upper-right-opening',moveX:1,maxMs:9500},
    {name:'return-toward-lower-left-exits',moveX:-1,maxMs:10500},
    {name:'observe-native-doors',moveX:0,maxMs:2500}
  ];
  report.plan=plan;
  for(const phase of plan){
    const started=Date.now();
    while(Date.now()-started<phase.maxMs){
      if(!app.room.running)break;
      fire.send(button(seq,phase.moveX));
      water.send(button(seq,phase.moveX));
      seq++;
      await delay(80);
      if(seq%3===0){
        const state=await app.readAuthority();
        const line={phase:phase.name,seq,
          characters:state.snapshot.characters.map(x=>({slot:x.slot,x:x.position.x,
            y:x.position.y,dead:x.gameplay?.dead,dying:x.gameplay?.dying})),
          doors:state.snapshot.doors.map(x=>({char:x.character,isUp:x.isUp,
            currentFrac:x.currentFrac})),
          ended:state.snapshot.level.ended??null,
          scene:state.snapshot.level.sceneName,
          reason:app.room.suspendedReason};
        if(report.trace.length<250)report.trace.push(line);
        if(state.snapshot.doors.length===2&&
           state.snapshot.doors.every(x=>x.isUp===true)&&
           state.snapshot.level.ended===true){
          observed=line;break;
        }
      }
    }
    if(observed||!app.room.running)break;
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
