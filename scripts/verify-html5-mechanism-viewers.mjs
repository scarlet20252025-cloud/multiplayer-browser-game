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
    const snap=window.__spec?.lastSnapshot?.();
    const delivered={
      pusher:snap?.mechanisms?.find(o=>o.kind==='pusher'&&o.group===2),
      platform:snap?.mechanisms?.find(o=>o.kind==='platform'&&o.group===2)
    };
    return {seat:window.__spec.status().seat,initial:window.__spec.status().initial,
      error:window.__spec.status().lastError,stepCount:window.__localPhysicsSteps,
      gamePaused:__game.paused,canvasCount:document.querySelectorAll('canvas').length,
      rendered:{pusher:pusher?{x:pusher.button?.x,y:pusher.button?.y}:null,
        platform:platform?{x:platform.sprite?.x,y:platform.sprite?.y}:null},
      delivered:delivered.pusher&&delivered.platform?{
        pusher:{state:delivered.pusher.state,
          x:delivered.pusher.display?.x,y:delivered.pusher.display?.y},
        platform:{state:delivered.platform.state,
          x:delivered.platform.display?.x,y:delivered.platform.display?.y}
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
  }finally{await second.keyboard.up('KeyA').catch(()=>{});}
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
