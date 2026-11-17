#!/usr/bin/env node
/** One native HTML5 authority + two frozen render clients, actual button/linked platform. */
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright';
import {startHtml5ResearchHost} from './html5-research-host.mjs';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';
const {values}=parseArgs({options:{root:{type:'string'},script:{type:'string'},
  'require-script':{type:'string'},'entry-path':{type:'string'},
  'expected-sha256':{type:'string'},out:{type:'string'}}});
const out=path.resolve(values.out??'local/html5-mechanism-viewers');
await mkdir(out,{recursive:true});
const report={schemaVersion:1,status:'blocked',startedAt:new Date().toISOString(),
  researchOnly:true,scope:'One real level-52 Box2D authority and two independent native browser viewers',
  noVideo:true,originalPackageBaseline:false,levelId:52,observations:[],checks:[],diagnostics:[],errors:[]};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let viewHost,authority,browser;
const pages=[];
async function until(fn,timeout=16000){
  const end=Date.now()+timeout;
  while(Date.now()<end){const value=await fn();if(value)return value;await sleep(75);}
  throw Error('Timed out waiting for native room or rendered mechanism');
}
async function openViewer(){
  const page=await browser.newPage({viewport:{width:1280,height:960}});
  pages.push(page);
  page.on('pageerror',error=>{if(report.diagnostics.length<40)
    report.diagnostics.push({type:'pageerror',message:error.message});});
  await page.route('**/*',route=>{
    try{return new URL(route.request().url()).origin===viewHost.url?route.continue():route.abort();}
    catch{return route.abort();}
  });
  await page.addInitScript(()=>{
    localStorage.setItem('fb-forest:unlock','1');
    localStorage.removeItem('fb-forest:invulnerable');
  });
  await page.goto(viewHost.entryUrl,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__game?.state?.current==='menu',null,{timeout:60000});
  await page.evaluate(()=>{
    const temple=__game.progress.get('temples').find(t=>t.id==='forest');
    if(!temple)throw Error('Forest temple absent in viewer');
    __game.state.states[__game.state.current].startTemple(temple);
  });
  await page.waitForFunction(()=>__game.state.current==='levelMenu'&&!__game.state.fading&&
    __game.state.states.levelMenu.buttons,null,{timeout:30000});
  await page.evaluate(()=>{
    const menu=__game.state.states.levelMenu;
    const chosen=menu.templeData.levels.find(item=>Number(item.id)===52);
    if(!chosen||!(chosen.state>0))throw Error('Official level 52 is not unlocked');
    menu.startLevel({data:chosen});
  });
  await page.waitForFunction(()=>__game.state.current==='level'&&__game.level?.levelStarted&&
    __game.level.pers1?.body&&__game.level.pers2?.body&&
    !__game.paused&&!__game.physics.box2d.paused&&!__game.state.fading,null,{timeout:45000});
  await page.evaluate(async wsUrl=>{
    const {connectHtml5Spectator}=await import('/adapters/fireboy-html5/spectator-client.mjs');
    window.__localPhysicsSteps=0;
    const world=__game.physics.box2d.world,native=world.Step;
    world.Step=function(...args){window.__localPhysicsSteps++;return Reflect.apply(native,this,args);};
    window.__spec=connectHtml5Spectator({game:__game,wsUrl,devices:window.Devices});
  },authority.url.replace(/^http/,'ws')+'/ws');
  await page.waitForFunction(()=>window.__spec?.status().seat!==null,null,{timeout:20000});
  return page;
}
async function view(page){
  return page.evaluate(()=>{
    const pusher=__game.level.objects.find(o=>o.options?.type==='pusher'&&
      o.options.properties?.group===2);
    const platform=__game.level.objects.find(o=>o.options?.type==='platform'&&
      o.options.properties?.group===2);
    const box=__game.level.objects.find(o=>o.options?.type==='box');
    const snap=window.__spec?.lastSnapshot?.();
    const delivered={
      pusher:snap?.mechanisms?.find(o=>o.kind==='pusher'&&o.group===2),
      platform:snap?.mechanisms?.find(o=>o.kind==='platform'&&o.group===2),
      box:snap?.mechanisms?.find(o=>o.kind==='box')
    };
    return {seat:window.__spec.status().seat,initial:window.__spec.status().initial,
      error:window.__spec.status().lastError,stepCount:window.__localPhysicsSteps,
      gamePaused:__game.paused,canvasCount:document.querySelectorAll('canvas').length,
      rendered:{pusher:pusher?{x:pusher.button?.x,y:pusher.button?.y}:null,
        platform:platform?{x:platform.sprite?.x,y:platform.sprite?.y}:null,
        box:box?{x:box.sprite?.x,y:box.sprite?.y}:null},
      delivered:delivered.pusher&&delivered.platform?{
        pusher:{state:delivered.pusher.state,
          x:delivered.pusher.display?.x,y:delivered.pusher.display?.y},
        platform:{state:delivered.platform.state,
          x:delivered.platform.display?.x,y:delivered.platform.display?.y},
        box:delivered.box?{x:delivered.box.display?.x,y:delivered.box.display?.y}:null
      }:null};
  });
}
const mechanism=snapshot=>{
  const p=snapshot.mechanisms.find(m=>m.kind==='pusher'&&m.group===2);
  const platform=snapshot.mechanisms.find(m=>m.kind==='platform'&&m.group===2);
  return p&&platform?{pusher:{state:p.state,x:p.display?.x,y:p.display?.y},
    platform:{state:platform.state,x:platform.display?.x,y:platform.display?.y}}:null;
};
function pass(name,value){report.checks.push({name,status:'passed',value});}
try{
  if(!values.root||!values.script)throw Error('Private --root and --script required');
  viewHost=await startHtml5ResearchHost({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path']});
  authority=await startHtml5ResearchRoom({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path'],
    levelId:52,allowedViewerOrigins:[viewHost.url]});
  report.sourceSha256=authority.sourceSha256;
  if(values['expected-sha256']&&report.sourceSha256!==values['expected-sha256'])
    throw Error('Actual source SHA differs from requested candidate');
  browser=await chromium.launch({timeout:20000});
  const first=await openViewer();
  const second=await openViewer();
  await Promise.all([first,second].map(p=>p.waitForFunction(()=>
    window.__spec?.status().initial===true,null,{timeout:25000})));
  const [v0,v1]=await Promise.all([view(first),view(second)]);
  if(v0.seat!==0||v1.seat!==1||!v0.gamePaused||!v1.gamePaused||
     v0.stepCount!==0||v1.stepCount!==0)throw Error('Spectators are not isolated and frozen');
  if(!v0.delivered||!v1.delivered||!v0.rendered.platform||!v1.rendered.platform)
    throw Error('Level 52 mechanism could not be mapped in both viewers');
  pass('two-frozen-native-viewers',{seats:[v0.seat,v1.seat],steps:[0,0]});
  const authorityBefore=mechanism((await authority.readAuthority()).snapshot);
  if(!authorityBefore||authorityBefore.pusher.state!==0)
    throw Error('Native button must be unpressed at the baseline');
  report.baseline=authorityBefore;
  const boxBaseline=(await authority.readAuthority()).snapshot.mechanisms.find(o=>o.kind==='box');
  report.boxProbe={status:'not-tested',boxFound:!!boxBaseline,baselineX:boxBaseline?.position?.x??null,
    baselineY:boxBaseline?.position?.y??null,trace:[]};
  await second.keyboard.down('KeyA');
  let triggered;
  try{
    triggered=await until(async()=>{
      const state=mechanism((await authority.readAuthority()).snapshot);
      if(!state)return null;
      report.observations.push({time:Date.now(),pusherState:state.pusher.state,
        platformY:state.platform.y});
      return state.pusher.state===1 &&
        Math.abs(state.platform.y-authorityBefore.platform.y)>8 ?state:null;
    },10000);
    const both=await until(async()=>{
      const [left,right]=await Promise.all([view(first),view(second)]);
      if(left.error||right.error)throw Error('Viewer projection failed');
      if(!left.delivered||!right.delivered)return null;
      if(left.delivered.pusher.state!==1||right.delivered.pusher.state!==1)return null;
      if([left,right].some(v=>
        Math.abs(v.delivered.platform.y-authorityBefore.platform.y)<=8||
        Math.abs(v.rendered.platform.y-v.delivered.platform.y)>1||
        Math.abs(v.rendered.pusher.y-v.delivered.pusher.y)>1))return null;
      return {left,right};
    },12000);
    if(Math.abs(both.left.rendered.platform.y-both.right.rendered.platform.y)>8)
      throw Error('Two native viewers show divergent linked-platform positions');
    if(both.left.stepCount!==0||both.right.stepCount!==0)
      throw Error('A viewer advanced gameplay physics');
    pass('button-state-observed-on-both-viewers',{
      states:[both.left.delivered.pusher.state,both.right.delivered.pusher.state]});
    pass('linked-platform-rendered-on-both-viewers',{
      authorityTriggerY:triggered.platform.y,
      viewerY:[both.left.rendered.platform.y,both.right.rendered.platform.y],
      baselinePlatformY:authorityBefore.platform.y});
    pass('local-physics-stays-frozen',{steps:[both.left.stepCount,both.right.stepCount]});
    report.triggered=triggered;
    report.viewersAtTrigger=both;
    // Optional next interaction: continue REAL water movement toward the
    // map's dynamic box. A lack of push does not invalidate the proven button test.
    if(boxBaseline&&Number.isFinite(boxBaseline.position?.x)){
      const trace=report.boxProbe.trace;
      let pushed=null;
      for(let sample=0;sample<26;sample++){
        await sleep(100);
        const snap=(await authority.readAuthority()).snapshot;
        const boxNow=snap.mechanisms.find(m=>m.id===boxBaseline.id);
        const water=snap.characters.find(m=>m.slot===1);
        const row={sample,waterX:water?.position?.x??null,
          boxX:boxNow?.position?.x??null,boxY:boxNow?.position?.y??null};
        trace.push(row);
        if(boxNow&&Number.isFinite(water?.position?.x)&&
          Math.abs(boxNow.position.x-boxBaseline.position.x)>8 &&
          Math.abs(water.position.x-boxNow.position.x)<80){
          pushed={boxX:boxNow.position.x,waterX:water.position.x,deltaX:boxNow.position.x-boxBaseline.position.x};
          break;
        }
      }
      if(pushed){
        try{
          const bothBox=await until(async()=>{
            const [left,right]=await Promise.all([view(first),view(second)]);
            if(left.error||right.error)throw Error('Viewer failed during box projection');
            if(!left.delivered?.box||!right.delivered?.box||
              !left.rendered.box||!right.rendered.box)return null;
            if([left,right].some(v=>Math.abs(v.rendered.box.x-v.delivered.box.x)>1 ||
              Math.abs(v.rendered.box.y-v.delivered.box.y)>1))return null;
            if([left,right].some(v=>Math.abs(v.rendered.box.x-boxBaseline.display.x)<8))return null;
            if(left.stepCount!==0||right.stepCount!==0)return null;
            return {left,right};
          },8000);
          report.boxProbe.status='passed';
          report.boxProbe.pushed=pushed;
          report.boxProbe.viewerBoxX=[bothBox.left.rendered.box.x,bothBox.right.rendered.box.x];
          pass('real-dynamic-box-moved-and-rendered-on-both-viewers',{
            deltaX:pushed.deltaX,viewerX:report.boxProbe.viewerBoxX});
        }catch(err){
          report.boxProbe.status='blocked';
          report.boxProbe.reason='Box changed in authority but both viewer projections were not verified: '+err.message;
        }
      }else{
        report.boxProbe.status='blocked';
        report.boxProbe.reason='No >8 px authoritative horizontal box displacement during normal movement';
      }
    }
  }finally{await second.keyboard.up('KeyA').catch(()=>{});}
  // Verify real native pusher unpress and linked platform return; no direct state writes.
  report.releaseProbe={status:'blocked',samples:[]};
  const released=await until(async()=>{
    const state=mechanism((await authority.readAuthority()).snapshot);
    if(!state)return null;
    if(report.releaseProbe.samples.length<100)report.releaseProbe.samples.push({
      at:Date.now(),buttonState:state.pusher.state,buttonY:state.pusher.y,
      platformY:state.platform.y
    });
    return state.pusher.state===0 &&
      Math.abs(state.pusher.y-authorityBefore.pusher.y)<3 &&
      Math.abs(state.platform.y-authorityBefore.platform.y)<3 ?state:null;
  },13000);
  report.releaseProbe.authority=released;
  const releasedViews=await until(async()=>{
    const [left,right]=await Promise.all([view(first),view(second)]);
    if(left.error||right.error)throw Error('Viewer projection errored during pusher release');
    if(!left.delivered||!right.delivered)return null;
    if(left.delivered.pusher.state!==0||right.delivered.pusher.state!==0)return null;
    if([left,right].some(v=>
      !Number.isFinite(v.rendered.pusher.y)||!Number.isFinite(v.rendered.platform.y)||
      Math.abs(v.rendered.platform.y-authorityBefore.platform.y)>=3||
      Math.abs(v.rendered.pusher.y-authorityBefore.pusher.y)>=3||
      Math.abs(v.rendered.platform.y-v.delivered.platform.y)>1||
      Math.abs(v.rendered.pusher.y-v.delivered.pusher.y)>1))return null;
    if(left.stepCount!==0||right.stepCount!==0)
      throw Error('A spectator resumed its own Box2D simulation');
    return {left,right};
  },12000);
  report.releaseProbe.status='passed';
  report.releaseProbe.viewerY=[
    releasedViews.left.rendered.platform.y,releasedViews.right.rendered.platform.y
  ];
  pass('native-button-release-and-two-viewer-platform-reset',{
    authorityButtonState:released.pusher.state,
    platformY:released.platform.y,
    viewerY:report.releaseProbe.viewerY,
    initialPlatformY:authorityBefore.platform.y
  });
  if(report.boxProbe?.status==='passed'){
    // Separate the two claims: (1) each renderer tracks its own received
    // frame, (2) both independent renderers eventually converge after motion.
    // Never compare an earlier authoritative box sample to a later client frame.
    report.boxConvergenceProbe={status:'blocked',samples:[]};
    const convergence=await until(async()=>{
      const [left,right,server]=await Promise.all([
        view(first),view(second),authority.readAuthority()]);
      const actual=server.snapshot.mechanisms.find(m=>m.kind==='box');
      const l=left.rendered?.box,r=right.rendered?.box;
      const serverX=actual?.display?.x,serverY=actual?.display?.y;
      if(!l||!r||!Number.isFinite(serverX)||!Number.isFinite(serverY))return null;
      const sample={
        time:Date.now(),leftX:l.x,rightX:r.x,serverX,
        leftY:l.y,rightY:r.y,serverY,
        leftStep:left.stepCount,rightStep:right.stepCount
      };
      if(report.boxConvergenceProbe.samples.length<70)
        report.boxConvergenceProbe.samples.push(sample);
      if([left,right].some(v=>v.error||!v.delivered?.box ||
        Math.abs(v.rendered.box.x-v.delivered.box.x)>1||
        Math.abs(v.rendered.box.y-v.delivered.box.y)>1))return null;
      if(Math.abs(l.x-r.x)>3||Math.abs(l.y-r.y)>3)return null;
      if(Math.abs(l.x-serverX)>8||Math.abs(r.x-serverX)>8||
         Math.abs(l.y-serverY)>8||Math.abs(r.y-serverY)>8)return null;
      if(left.stepCount!==0||right.stepCount!==0)
        throw Error('Spectator simulated Box2D during convergence');
      return sample;
    },14000);
    report.boxConvergenceProbe.status='passed';
    report.boxConvergenceProbe.converged=convergence;
    pass('both-viewers-eventually-converge-on-real-box-position',{
      serverX:convergence.serverX,viewerX:[convergence.leftX,convergence.rightX],
      serverY:convergence.serverY,viewerY:[convergence.leftY,convergence.rightY]
    });
  }
  const unknown=report.diagnostics.filter(x=>x.type==='pageerror'&&
    x.message!=='h5api is not defined');
  if(unknown.length)throw Error('Unexplained browser errors detected');
  report.status='passed';
}catch(error){report.status='blocked';report.errors.push(String(error.stack||error));}
finally{
  for(const page of pages)await page.close().catch(()=>{});
  await browser?.close().catch(()=>{});
  await authority?.close().catch(e=>report.errors.push(String(e)));
  await viewHost?.close().catch(e=>report.errors.push(String(e)));
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(out,'mechanism-viewers.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,sourceSha256:report.sourceSha256,
    checks:report.checks.map(x=>x.name),errors:report.errors}));
  if(report.status!=='passed')process.exitCode=1;
}
