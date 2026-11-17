#!/usr/bin/env node
// Native death, two browser restart votes, synchronized native retry and resumed input.
// No game position mutation, no screenshots/video, no private game files uploaded.
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright';
import {startHtml5ResearchHost} from './html5-research-host.mjs';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';
const {values}=parseArgs({options:{
  root:{type:'string'},script:{type:'string'},
  'require-script':{type:'string'},'entry-path':{type:'string'},
  'expected-sha256':{type:'string'},out:{type:'string'}
}});
const dir=path.resolve(values.out??'local/native-death-viewers');
await mkdir(dir,{recursive:true});
const report={schemaVersion:1,status:'blocked',
  nativeDeathFromInputVerified:false,viewerLifecycleVerified:false,
  fullRestartHandshakeVerified:false,
  originalPackageBaseline:false,checks:[],errors:[],diagnostics:[]};
let host,authority,browser;const pages=[];
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,limit=15000){
  const deadline=Date.now()+limit;
  while(Date.now()<deadline){const found=await fn();if(found)return found;await pause(100);}
  throw Error('Timed out waiting for native death and viewer event');
}
async function openViewer(){
  const page=await browser.newPage({viewport:{width:1280,height:960}});
  pages.push(page);
  page.on('pageerror',error=>{
    if(report.diagnostics.length<25)report.diagnostics.push(error.message);
  });
  await page.route('**/*',route=>{
    try{return new URL(route.request().url()).origin===host.url
      ?route.continue():route.abort();}catch{return route.abort();}
  });
  await page.addInitScript(()=>{
    localStorage.setItem('fb-forest:unlock','1');
    localStorage.removeItem('fb-forest:invulnerable');
  });
  await page.goto(host.entryUrl,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__game?.state?.current==='menu',
    null,{timeout:60000});
  await page.evaluate(()=>{
    const temple=__game.progress.get('temples').find(x=>x.id==='forest');
    if(!temple)throw Error('Forest temple missing');
    __game.state.states[__game.state.current].startTemple(temple);
  });
  await page.waitForFunction(()=>__game.state.current==='levelMenu'&&
    !__game.state.fading&&__game.state.states.levelMenu.buttons,
    null,{timeout:30000});
  await page.evaluate(()=>{
    const menu=__game.state.states.levelMenu;
    const level=menu.templeData.levels.find(x=>Number(x.id)===1);
    if(!level||!(level.state>0))throw Error('Tutorial 1 unavailable');
    menu.startLevel({data:level});
  });
  await page.waitForFunction(()=>__game.state.current==='level'&&
    __game.level?.levelStarted&&__game.level?.pers1?.body&&
    __game.level?.pers2?.body&&!__game.paused&&
    !__game.physics.box2d.paused&&!__game.state.fading,null,{timeout:45000});
  await page.evaluate(async wsUrl=>{
    window.__viewerPhysicsStepCount=0;
    const world=__game.physics.box2d.world;
    const native=world.Step;
    world.Step=function(...args){
      window.__viewerPhysicsStepCount++;
      return Reflect.apply(native,this,args);
    };
    const mod=await import('/adapters/fireboy-html5/spectator-client.mjs');
    window.__spec=mod.connectHtml5Spectator({game:__game,wsUrl,devices:window.Devices});
    window.__viewerPhysicsStepCount=0;
    // Ignore native physics frames occurring during the async module import.
    // The counter starts at the moment the spectator is frozen.
    window.__viewerPhysicsStepCount=0;
  },authority.url.replace(/^http/,'ws')+'/ws');
  await page.waitForFunction(()=>window.__spec?.status().seat!==null,
    null,{timeout:20000});
  return page;
}
async function state(page){
  return page.evaluate(()=>({
    status:window.__spec?.status()??null,
    physicsSteps:window.__viewerPhysicsStepCount,
    nativeGamePaused:window.__game?.paused??null,
    fireX:window.__game?.level?.pers1?.sprite?.x??null,
    waterX:window.__game?.level?.pers2?.sprite?.x??null,
    waterSnapshotX:window.__spec?.lastSnapshot?.()?.characters?.find(x=>x.slot===1)?.display?.x??null
  }));
}
try{
  if(!values.root||!values.script)throw Error('Private HTML5 runtime is required');
  host=await startHtml5ResearchHost({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path']});
  authority=await startHtml5ResearchRoom({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path'],
    allowedViewerOrigins:[host.url],levelId:1});
  report.sourceSha256=authority.sourceSha256;
  if(values['expected-sha256']&&report.sourceSha256!==values['expected-sha256'])
    throw Error('Unexpected candidate game.js version');
  browser=await chromium.launch({timeout:20000});
  const fire=await openViewer();
  const water=await openViewer();
  await Promise.all([fire,water].map(page=>page.waitForFunction(()=>
    window.__spec?.status().initial===true,null,{timeout:25000})));
  const [beforeFire,beforeWater]=await Promise.all([state(fire),state(water)]);
  report.initialViewers={fire:beforeFire,water:beforeWater};
  if(beforeFire.status.seat!==0||beforeWater.status.seat!==1||
    beforeFire.physicsSteps!==0||beforeWater.physicsSteps!==0)
    throw Error('Two native frozen viewer seats not initialized');
  report.checks.push('two-real-frozen-native-viewers');
  await fire.keyboard.down('ArrowRight');
  try{
    const suspended=await until(()=>authority.room.suspendedReason,16000);
    report.suspendedReason=suspended;
  }finally{
    await fire.keyboard.up('ArrowRight').catch(()=>{});
  }
  if(!['CHARACTER_DYING','CHARACTER_DEAD'].includes(report.suspendedReason))
    throw Error('Normal Fireboy motion did not prove native dying/dead state: '+
      report.suspendedReason);
  report.nativeDeathFromInputVerified=true;
  report.checks.push('actual-native-death-suspended-the-authority');
  const final=await until(async()=>{
    const [a,b]=await Promise.all([state(fire),state(water)]);
    if(!a.status.lifecycle||!b.status.lifecycle)return null;
    return {a,b};
  },10000);
  report.viewers={fire:final.a,water:final.b};
  if(final.a.status.lifecycle.reason!==report.suspendedReason||
    final.b.status.lifecycle.reason!==report.suspendedReason)
    throw Error('Two viewers disagreed about native death lifecycle');
  if(final.a.physicsSteps!==0||final.b.physicsSteps!==0||
    !final.a.nativeGamePaused||!final.b.nativeGamePaused)
    throw Error('A frozen spectator unexpectedly resumed its local physics');
  report.checks.push('both-browsers-received-the-same-native-death');
  const [fireInput,waterInput]=await Promise.all([
    fire.evaluate(()=>window.__spec.sendInput()),
    water.evaluate(()=>window.__spec.sendInput())
  ]);
  if(fireInput!==false||waterInput!==false)
    throw Error('Obsolete native input was still enabled after death');
  report.checks.push('both-browsers-refused-old-scene-controls');
  report.viewerLifecycleVerified=true;
  const beforeRound=(await authority.readAuthority()).snapshot;
  report.restartBefore={levelEpoch:beforeRound.levelEpoch,
    roundNumber:authority.room.roundNumber};
  // The same two authenticated browser players vote, not the research API.
  await fire.keyboard.press('KeyR');
  await until(()=>authority.room.restartVotes.size===1,5000);
  report.checks.push('first-vote-does-not-restart-unilaterally');
  await water.keyboard.press('KeyR');
  const afterRound=await until(async()=>{
    const [a,b]=await Promise.all([state(fire),state(water)]);
    report.restartLastSeen={fire:a.status,water:b.status,
      room:authority.room.publicState()};
    const errors=[a.status?.lastError,b.status?.lastError].filter(Boolean);
    if(errors.some(x=>x.startsWith('ROUND_RESET_FAILED')))
      throw Error('Native spectator restart failed: '+errors.join('; '));
    if(a.status?.roundNumber!==1||b.status?.roundNumber!==1||
       a.status.resetting||b.status.resetting||
       a.status.lifecycle||b.status.lifecycle||!a.status.initial||!b.status.initial||
       !authority.room.running)return null;
    return {a,b};
  },60000);
  report.restartAfter={viewerRounds:[
    afterRound.a.status.roundNumber,afterRound.b.status.roundNumber
  ],room:authority.room.publicState()};
  const renewed=await authority.readAuthority();
  report.restartAfter.levelEpoch=renewed.snapshot.levelEpoch;
  report.restartAfter.gamePaused=renewed.gamePaused;
  report.restartAfter.physicsPaused=renewed.physicsPaused;
  report.restartAfter.inputSlots=renewed.input?.slots;
  if(renewed.snapshot.levelEpoch<=beforeRound.levelEpoch||
     renewed.snapshot.characters.length!==2||renewed.snapshot.diamonds.length!==7)
    throw Error('Native restarted authority was not reset to the expected first level');
  report.checks.push('both-voted-and-reloaded-same-native-round');
  // New player input must control the native actor and appear in both viewers,
  // without letting the display clients simulate Box2D after projection.
  const initialWater=afterRound.b.waterX;
  const viewerSteps=[afterRound.a.physicsSteps,afterRound.b.physicsSteps];
  await water.keyboard.down('KeyD');
  await pause(700);
  await water.keyboard.up('KeyD');
  const moved=await until(async()=>{
    const [a,b,server]=await Promise.all([state(fire),state(water),authority.readAuthority()]);
    report.restartInputDiagnostic={room:authority.room.publicState(),
      authority:{gamePaused:server.gamePaused,physicsPaused:server.physicsPaused,
        slots:server.input?.slots,waterX:server.snapshot?.characters?.find(x=>x.slot===1)?.display?.x},
      viewers:[{waterX:a.waterX,status:a.status},{waterX:b.waterX,status:b.status}]};
    if(!Number.isFinite(a.waterX)||!Number.isFinite(b.waterX)||
       a.waterX<=initialWater+15||b.waterX<=initialWater+15 ||
       Math.abs(a.waterX-b.waterX)>4)return null;
    return {a,b};
  },18000);
  await pause(500);
  const [stableA,stableB]=await Promise.all([state(fire),state(water)]);
  if(stableA.physicsSteps!==viewerSteps[0]||
     stableB.physicsSteps!==viewerSteps[1])
    throw Error('Viewer physics advanced after native restarted projection');
  const authorityNow=(await authority.readAuthority()).snapshot;
  const expectedX=authorityNow.characters.find(x=>x.slot===1)?.display?.x;
  if(!Number.isFinite(expectedX)||
     expectedX<=initialWater+15 ||
     !Number.isFinite(stableA.waterSnapshotX) ||
     !Number.isFinite(stableB.waterSnapshotX) ||
     Math.abs(stableA.waterX-stableA.waterSnapshotX)>1 ||
     Math.abs(stableB.waterX-stableB.waterSnapshotX)>1 ||
     Math.abs(stableA.waterX-stableB.waterX)>4)
    throw Error('Rearmed viewers do not match their own authority frames');
  report.restartMotion={initialWater,viewerX:[stableA.waterX,stableB.waterX],
    viewerSnapshotX:[stableA.waterSnapshotX,stableB.waterSnapshotX],
    latestAuthorityX:expectedX,viewerSteps};
  report.checks.push('new-round-seat-input-controls-original-watergirl');
  report.checks.push('reloaded-viewers-render-new-authority-without-local-physics');
  report.fullRestartHandshakeVerified=true;
  report.status='passed';
}catch(error){report.errors.push(String(error.stack??error));}
finally{
  for(const page of pages)await page.close().catch(()=>{});
  await browser?.close().catch(()=>{});
  await authority?.close().catch(error=>report.errors.push(String(error)));
  await host?.close().catch(error=>report.errors.push(String(error)));
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(dir,'native-round-restart-report.json'),
    JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,reason:report.suspendedReason,
    checks:report.checks,
    restartAfter:report.status==='blocked'?report.restartAfter:undefined,
    restartInputDiagnostic:report.status==='blocked'?report.restartInputDiagnostic:undefined,
    errors:report.errors}));
  if(report.status!=='passed')process.exitCode=1;
}
