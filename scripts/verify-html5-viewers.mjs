#!/usr/bin/env node
/** Three actual Phaser game instances: authority + two frozen browser viewers.
 * Third-party assets remain in ignored research-only folder; JSON evidence only.
 */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright';
import {startHtml5ResearchHost} from './html5-research-host.mjs';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';

const {values}=parseArgs({options:{root:{type:'string'},script:{type:'string'},
  'require-script':{type:'string'},'entry-path':{type:'string'},
  'expected-sha256':{type:'string'},out:{type:'string'}}});
const report={schemaVersion:1,status:'blocked',startedAt:new Date().toISOString(),
  scope:'one real HTML5 authority + two independent browser-rendered frozen spectators; no video',
  originalPackageBaseline:false,completeGameStateVerified:false,publicDeploymentVerified:false,
  checks:[],errors:[],diagnostics:[]};
const out=path.resolve(values.out||'local/html5-viewer-results');
await mkdir(out,{recursive:true});
let viewHost,authority,browser;const viewers=[];
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(asyncPredicate,ms=15000){
  const end=Date.now()+ms;
  while(Date.now()<end){
    const result=await asyncPredicate();
    if(result)return result;
    await sleep(80);
  }
  throw Error('Timed out waiting for original viewer/authority synchronization');
}
function pass(name,value){report.checks.push({name,status:'passed',value});}
// Compare decoded screenshots; never save or upload copyrighted game pixels.
function pngSha(bytes){return createHash('sha256').update(bytes).digest('hex');}
async function pixelChange(page, before, after, regions=null){
  return page.evaluate(async ({a,b,regions})=>{
    async function pixels(base64){
      const bytes=Uint8Array.from(atob(base64),letter=>letter.charCodeAt(0));
      const bitmap=await createImageBitmap(new Blob([bytes],{type:'image/png'}));
      const canvas=document.createElement('canvas');
      canvas.width=bitmap.width;canvas.height=bitmap.height;
      const context=canvas.getContext('2d',{willReadFrequently:true});
      context.drawImage(bitmap,0,0);
      return context.getImageData(0,0,bitmap.width,bitmap.height);
    }
    const first=await pixels(a),second=await pixels(b);
    if(first.width!==second.width||first.height!==second.height)
      throw Error('Screenshot sizes changed');
    const d1=first.data,d2=second.data;
    let pixelsChanged=0,pixelsConsidered=0;
    for(let y=0;y<first.height;y++)for(let x=0;x<first.width;x++){
      if(regions && !regions.some(r=>x>=r.left&&x<r.right&&y>=r.top&&y<r.bottom))continue;
      const i=(y*first.width+x)*4;
      pixelsConsidered++;
      if(Math.max(Math.abs(d1[i]-d2[i]),Math.abs(d1[i+1]-d2[i+1]),
        Math.abs(d1[i+2]-d2[i+2]))>=16)pixelsChanged++;
    }
    return {pixelsChanged,pixelsConsidered,width:first.width,height:first.height};
  },{a:before.toString('base64'),b:after.toString('base64'),regions});
}
async function fireScreenRegion(page,aroundX=null){
  return page.evaluate(otherX=>{
    const game=window.__game,canvas=game.canvas;
    const rect=canvas.getBoundingClientRect(),sprite=game.level.pers1.sprite;
    const localX=sprite.worldTransform?.tx??sprite.x;
    const localY=sprite.worldTransform?.ty??sprite.y;
    const scaleX=rect.width/game.width,scaleY=rect.height/game.height;
    const x=rect.left+localX*scaleX, y=rect.top+localY*scaleY;
    if(!Number.isFinite(x)||!Number.isFinite(y)||rect.width<=0||rect.height<=0)
      throw Error('Cannot locate visible Fireboy sprite region');
    const x2=otherX===null?x:rect.left+otherX*scaleX;
    return {left:Math.floor(Math.min(x,x2)-90),top:Math.floor(y-110),
      right:Math.ceil(Math.max(x,x2)+90),bottom:Math.ceil(y+110)};
  },aroundX);
}
async function viewerState(page){
  return page.evaluate(()=>({
    state:window.__spec?.status()??null,
    adapter:window.__spec?.projection?.inspect()??null,
    gamePaused:window.__game?.paused??null,
    physicsPaused:window.__game?.physics?.box2d?.paused??null,
    worldSteps:window.__localPhysicsSteps??null,
    fire:{x:window.__game?.level?.pers1?.sprite?.x,y:window.__game?.level?.pers1?.sprite?.y},
    water:{x:window.__game?.level?.pers2?.sprite?.x,y:window.__game?.level?.pers2?.sprite?.y},
    visibleDiamonds:(()=>{
      const proto=window.Devices?.Diamond?.prototype;
      return proto?window.__game?.layers?.underGround?.children?.filter(child=>
        Object.prototype.isPrototypeOf.call(proto,child)&&child.visible!==false).length:null;
    })(),
    visibleDiamondPositions:(()=>{
      const proto=window.Devices?.Diamond?.prototype;
      return proto?window.__game?.layers?.underGround?.children?.filter(child=>
        Object.prototype.isPrototypeOf.call(proto,child)&&child.visible!==false)
        .map(child=>({x:child.x,y:child.y,char:child.data?.char})):null;
    })(),
    crate:(()=>{const box=window.__game?.level?.objects?.find(x=>x?.options?.type==='box');
      return box?{x:box.sprite?.x,y:box.sprite?.y,rotation:box.sprite?.rotation}:null;})(),
    activeCanvas:document.querySelectorAll('canvas').length,
  }));
}
async function openViewer(){
  const page=await browser.newPage({viewport:{width:1280,height:960}});
  viewers.push(page);
  page.on('pageerror',error=>{if(report.diagnostics.length<40)
    report.diagnostics.push({type:'viewer-pageerror',message:error.message});});
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
    const temple=__game.progress.get('temples').find(x=>x.id==='forest');
    if(!temple)throw Error('Forest temple missing in viewer');
    __game.state.states[__game.state.current].startTemple(temple);
  });
  await page.waitForFunction(()=>__game.state.current==='levelMenu'&&!__game.state.fading&&
    __game.state.states.levelMenu.buttons,null,{timeout:30000});
  await page.evaluate(()=>{
    const menu=__game.state.states.levelMenu;
    const level=menu.templeData.levels.find(x=>Number(x.id)===1);
    if(!level||!(level.state>0))throw Error('Viewer level 1 unavailable');
    menu.startLevel({data:level});
  });
  await page.waitForFunction(()=>__game.state.current==='level'&&__game.level?.levelStarted&&
    __game.level.pers1?.body&&__game.level.pers2?.body&&
    !__game.paused&&!__game.physics.box2d.paused&&!__game.state.fading,null,{timeout:45000});
  await page.evaluate(async wsUrl=>{
    const {connectHtml5Spectator}=await import('/adapters/fireboy-html5/spectator-client.mjs');
    const world=__game.physics.box2d.world;
    window.__localPhysicsSteps=0;
    const native=world.Step;
    world.Step=function(...args){window.__localPhysicsSteps++;return Reflect.apply(native,this,args);};
    window.__spec=connectHtml5Spectator({game:__game,wsUrl,devices:window.Devices});
  },authority.url.replace(/^http/,'ws')+'/ws');
  await page.waitForFunction(()=>window.__spec?.status().seat!==null,null,{timeout:20000});
  return page;
}
try{
  if(!values.root||!values.script)throw Error('Private --root and --script required');
  viewHost=await startHtml5ResearchHost({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path']});
  authority=await startHtml5ResearchRoom({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path'],
    allowedViewerOrigins:[viewHost.url]});
  report.gameSha256=authority.sourceSha256;
  if(values['expected-sha256'])assert.equal(authority.sourceSha256,values['expected-sha256']);
  browser=await chromium.launch({timeout:20000});
  const first=await openViewer();
  const second=await openViewer();
  await Promise.all([first,second].map(page=>
    page.waitForFunction(()=>window.__spec?.status().initial===true,null,{timeout:20000})));
  const [a,b]=await Promise.all([viewerState(first),viewerState(second)]);
  assert.equal(a.state.seat,0);assert.equal(b.state.seat,1);
  assert.equal(a.state.initial,true);assert.equal(b.state.initial,true);
  assert.equal(a.gamePaused,true);assert.equal(b.gamePaused,true);
  assert.equal(a.adapter.entityCount,17);assert.equal(b.adapter.entityCount,17);
  assert.ok(a.activeCanvas>=1&&b.activeCanvas>=1);
  pass('two-real-browser-spectators',{aSeat:a.state.seat,bSeat:b.state.seat,
    mappedEntities:[a.adapter.entityCount,b.adapter.entityCount]});
  const initialPhysics=[a.worldSteps,b.worldSteps];
  await sleep(500);
  const [aIdle,bIdle]=await Promise.all([viewerState(first),viewerState(second)]);
  assert.equal(aIdle.worldSteps,initialPhysics[0]);
  assert.equal(bIdle.worldSteps,initialPhysics[1]);
  pass('viewer-physics-remains-frozen',{steps:initialPhysics});
  const initialFire=aIdle.fire.x,initialWater=bIdle.water.x;
  const fireRegionBefore=await fireScreenRegion(first);
  const beforePixels=await first.screenshot({animations:'disabled'});
  await sleep(350);
  const idlePixels=await first.screenshot({animations:'disabled'});
  await first.keyboard.down('ArrowRight');
  await sleep(700);
  await first.keyboard.up('ArrowRight');
  const fireMoved=await until(async()=>{
    const f=await viewerState(second);
    return f.fire.x>initialFire+15?f:null;
  });
  const waterDuringFire=await viewerState(second);
  assert.ok(Math.abs(waterDuringFire.water.x-initialWater)<2);
  pass('keyboard-from-viewer-zero-controls-fire',{fireDeltaX:fireMoved.fire.x-initialFire});
  await sleep(300);
  const fireRegionAfter=await fireScreenRegion(first);
  const movedPixels=await first.screenshot({animations:'disabled'});
  const combinedRegion={left:Math.min(fireRegionBefore.left,fireRegionAfter.left),
    top:Math.min(fireRegionBefore.top,fireRegionAfter.top),
    right:Math.max(fireRegionBefore.right,fireRegionAfter.right),
    bottom:Math.max(fireRegionBefore.bottom,fireRegionAfter.bottom)};
  const idleDelta=await pixelChange(first,beforePixels,idlePixels,[combinedRegion]);
  const movedDelta=await pixelChange(first,idlePixels,movedPixels,[combinedRegion]);
  const screenshotEvidence={idleDelta,movedDelta,region:combinedRegion,
    sha256:{before:pngSha(beforePixels),idle:pngSha(idlePixels),moved:pngSha(movedPixels)}};
  report.visualPixels=screenshotEvidence;
  assert.ok(movedDelta.pixelsChanged>=Math.max(100,idleDelta.pixelsChanged+80),
    'Sprite positions changed but rendered Fireboy region did not show additional pixel changes');
  pass('rendered-fireboy-pixels-change',{idlePixelsChanged:idleDelta.pixelsChanged,
    movementPixelsChanged:movedDelta.pixelsChanged});
  await second.keyboard.down('KeyD');
  await sleep(700);
  await second.keyboard.up('KeyD');
  const waterMoved=await until(async()=>{
    const f=await viewerState(first);
    return f.water.x>initialWater+15?f:null;
  });
  pass('keyboard-from-viewer-one-controls-water',{waterDeltaX:waterMoved.water.x-initialWater});
  await sleep(700);
  const matched=await until(async()=>{
    const [v0,v1]=await Promise.all([viewerState(first),viewerState(second)]);
    if(Math.abs(v0.fire.x-v1.fire.x)>2||Math.abs(v0.water.x-v1.water.x)>2)return null;
    const server=(await authority.readAuthority()).snapshot;
    const sfire=server.characters.find(c=>c.slot===0)?.display?.x;
    const swater=server.characters.find(c=>c.slot===1)?.display?.x;
    if(!Number.isFinite(sfire)||!Number.isFinite(swater))return null;
    if(Math.abs(v0.fire.x-sfire)>3||Math.abs(v0.water.x-swater)>3)return null;
    const crate=server.mechanisms.find(x=>x.kind==='box');
    if(!crate||!Number.isFinite(crate.display?.x)||!Number.isFinite(crate.display?.y))
      throw Error('Real authority did not export the movable Box');
    if(!v0.crate||!v1.crate)return null;
    if([v0,v1].some(v=>Math.abs(v.crate.x-crate.display.x)>3||
      Math.abs(v.crate.y-crate.display.y)>3))return null;
    return {v0,v1,sfire,swater,crate,counts:server.counts};
  });
  assert.equal(matched.counts.diamonds,7);
  assert.equal(matched.counts.doors,2);
  assert.equal(matched.counts.mechanisms,6);
  pass('both-sprites-follow-one-authority',{fire:matched.sfire,water:matched.swater,
    counts:matched.counts,frames:[matched.v0.state.frames,matched.v1.state.frames]});
  pass('movable-box-present-and-position-matches',{x:matched.crate.display.x,
    y:matched.crate.display.y,kind:matched.crate.kind});
  assert.equal((await viewerState(first)).worldSteps,initialPhysics[0]);
  assert.equal((await viewerState(second)).worldSteps,initialPhysics[1]);
  pass('no-client-physics-resumed',{steps:initialPhysics});
  // Gameplay interaction: collect a real Fireboy diamond by ordinary keyboard
  // input only. Do NOT directly change body position, contact callbacks, or
  // diamond counters; the original Box2D sensor must perform the collection.
  const collectionBefore=(await authority.readAuthority()).snapshot;
  const fireBefore=collectionBefore.characters.find(c=>c.slot===0);
  const choices=collectionBefore.diamonds.filter(d=>
    ['fb','fbwg','silver'].includes(d.character) &&
    Number.isFinite(d.position?.x)&&Number.isFinite(d.position?.y) &&
    d.position.x > fireBefore.position.x+40 && d.position.y > 800)
    .sort((a,b)=>a.position.x-b.position.x);
  if(!choices.length)throw Error('No suitable Fireboy diamond on the lower route; do not guess a path');
  const targetDiamond=choices[0];
  const collectionTrace=[];
  let collected=null;
  await first.keyboard.down('ArrowRight');
  try{
    for(let sample=0;sample<68;sample++){
      await sleep(140);
      const current=(await authority.readAuthority()).snapshot;
      const fire=current.characters.find(c=>c.slot===0);
      collectionTrace.push({sample,fireX:fire.position.x,fireY:fire.position.y,
        diamondCount:current.counts.diamonds,fireDiamonds:fire.gameplay.diamonds,
        targetPresent:current.diamonds.some(d=>d.id===targetDiamond.id),
        levelEnded:current.level.ended});
      if(current.counts.diamonds===collectionBefore.counts.diamonds-1 &&
         !current.diamonds.some(d=>d.id===targetDiamond.id) &&
         fire.gameplay.diamonds===fireBefore.gameplay.diamonds+1){
        collected=current;break;
      }
      if(current.level.ended||fire.position.x>targetDiamond.position.x+90)break;
    }
  }finally{await first.keyboard.up('ArrowRight');}
  report.collectionProbe={
    target:{id:targetDiamond.id,x:targetDiamond.position.x,y:targetDiamond.position.y,
      character:targetDiamond.character},
    before:{count:collectionBefore.counts.diamonds,fireDiamonds:fireBefore.gameplay.diamonds},
    trace:collectionTrace,
    satisfied:!!collected
  };
  assert.ok(collected,'Real diamond pickup was not observed after normal keyboard movement');
  const bothCollected=await until(async()=>{
    const [viewA,viewB]=await Promise.all([viewerState(first),viewerState(second)]);
    if(viewA.visibleDiamonds!==collectionBefore.counts.diamonds-1 ||
       viewB.visibleDiamonds!==collectionBefore.counts.diamonds-1)return null;
    if(viewA.state.lastError||viewB.state.lastError)return null;
    return {viewA,viewB};
  },15000);
  assert.equal(bothCollected.viewA.worldSteps,initialPhysics[0]);
  assert.equal(bothCollected.viewB.worldSteps,initialPhysics[1]);
  pass('real-diamond-contact-and-two-viewer-removal',{
    authorityDiamondCount:collected.counts.diamonds,
    fireDiamonds:collected.characters.find(c=>c.slot===0).gameplay.diamonds,
    viewers:[bothCollected.viewA.visibleDiamonds,bothCollected.viewB.visibleDiamonds],
    targetX:targetDiamond.position.x,observedSamples:collectionTrace.length
  });
  // Test actual keyboard P on the web spectator, not a synthetic room command.
  await first.keyboard.press('KeyP');
  await until(async()=>{
    const view=await viewerState(first);
    return authority.room.userPaused===true &&
      view.state.room?.userPaused===true ?view:null;
  },10000);
  assert.equal((await authority.readAuthority()).gamePaused,true);
  assert.equal(authority.room.pauseRevision,1);
  pass('browser-key-P-pauses-authority',{revision:1,gamePaused:true});
  await second.keyboard.press('KeyP');
  await until(async()=>{
    const view=await viewerState(second);
    return authority.room.userPaused===false &&
      view.state.room?.pauseRevision===2 && !view.state.room.effectivePaused ?view:null;
  },10000);
  assert.equal((await authority.readAuthority()).gamePaused,false);
  pass('other-browser-key-P-resumes-authority',{revision:2,gamePaused:false});
  // Explicit spectator.close sends leave before marking the socket closed.
  await second.evaluate(()=>window.__spec.close());
  await until(async()=>{
    const view=await viewerState(first);
    return authority.room.effectivePaused && view.state.room?.bothReady===false &&
      view.state.room?.connected?.[1]===false ?view:null;
  },10000);
  assert.equal((await authority.readAuthority()).gamePaused,true);
  pass('browser-leave-pauses-authority',{seatLeft:1,gamePaused:true});
  // New player joins after collection with a freshly loaded uncollected level.
  // They must not resurrect already collected diamonds.
  const replacement=await openViewer();
  const lateJoin=await until(async()=>{
    const view=await viewerState(replacement);
    if(view.state?.lastError)throw Error('Late-join spectator projection rejected: '+view.state.lastError);
    return view.state?.initial ?view:null;
  },15000);
  const authorityNow=(await authority.readAuthority()).snapshot;
  report.lateJoinProbe={viewerSeat:lateJoin.state.seat,
    visibleDiamonds:lateJoin.visibleDiamonds,
    authorityDiamonds:authorityNow.counts.diamonds,
    visibleDiamondPositions:lateJoin.visibleDiamondPositions};
  assert.equal(lateJoin.state.seat,1);
  assert.equal(lateJoin.visibleDiamonds,authorityNow.counts.diamonds);
  const authoritativeDiamonds=authorityNow.diamonds.map(d=>d.rootDisplay);
  for(const visual of lateJoin.visibleDiamondPositions){
    assert.ok(authoritativeDiamonds.some(d=>Math.abs(d.x-visual.x)<2 &&
      Math.abs(d.y-visual.y)<2),'Late joiner displayed an absent/wrong diamond');
  }
  assert.equal(lateJoin.worldSteps,0);
  pass('late-join-does-not-resurrect-collected-diamond',{
    viewers:lateJoin.visibleDiamonds,authority:authorityNow.counts.diamonds});
  // The replacement browser must also control only its reassigned seat.
  const priorWater=lateJoin.water.x;
  const priorFire=lateJoin.fire.x;
  // On this tutorial platform, right movement may enter an obstacle after the
  // earlier interaction. Move toward the verified left-side open platform.
  const direction=priorWater>140?'KeyA':'KeyD';
  const sign=direction==='KeyA'?-1:1;
  const beforeAck=(await authority.readAuthority()).input.slots[1].ackSeq;
  await replacement.keyboard.down(direction);
  await sleep(800);
  await replacement.keyboard.up(direction);
  let latestRejoinedState=null;
  let rejoinedMotion;
  try{
    rejoinedMotion=await until(async()=>{
      const [newViewer,firstViewer]=await Promise.all([
        viewerState(replacement),viewerState(first)]);
      const server=await authority.readAuthority();
      latestRejoinedState={newViewer,firstViewer,
        serverAck:server.input.slots[1].ackSeq,
        serverWaterX:server.snapshot.characters.find(c=>c.slot===1).position.x,
        gamePaused:server.gamePaused};
      if(sign*(newViewer.water.x-priorWater)<=15||
         sign*(firstViewer.water.x-priorWater)<=15)return null;
      if(Math.abs(newViewer.water.x-firstViewer.water.x)>3)return null;
      return {newViewer,firstViewer};
    },12000);
  }catch(error){
    report.rejoinInputProbe={direction,priorWater,priorFire,beforeAck,latestRejoinedState};
    throw error;
  }
  report.rejoinInputProbe={direction,priorWater,priorFire,beforeAck,latestRejoinedState};
  assert.ok(Math.abs(rejoinedMotion.newViewer.fire.x-priorFire)<3,
    'Rejoining Watergirl caused Fireboy to move');
  assert.equal(rejoinedMotion.newViewer.worldSteps,0);
  assert.equal(rejoinedMotion.firstViewer.worldSteps,0);
  pass('late-joiner-resumes-own-controls-only',{
    seat:lateJoin.state.seat,waterDeltaX:rejoinedMotion.newViewer.water.x-priorWater,
    syncedWaterX:[rejoinedMotion.newViewer.water.x,rejoinedMotion.firstViewer.water.x]});
  report.status='passed';
}catch(error){
  report.status='failed';report.errors.push(String(error.stack||error));
  if(authority){
    report.lifecycleDiagnostic={room:authority.room.publicState()};
    try{
      const current=await authority.readAuthority();
      report.lifecycleDiagnostic.native={
        level:current.snapshot.level,
        levelEpoch:current.snapshot.levelEpoch,
        firstPlayer:current.snapshot.characters.map(x=>({
          slot:x.slot,dead:x.gameplay?.dead,dying:x.gameplay?.dying,
          x:x.position?.x,y:x.position?.y
        }))
      };
    }catch(nativeError){report.lifecycleDiagnostic.readError=String(nativeError);}
  }
}
finally{
  for(const page of viewers)await page.close().catch(()=>{});
  await browser?.close().catch(()=>{});
  await authority?.close().catch(err=>report.errors.push(String(err)));
  await viewHost?.close().catch(err=>report.errors.push(String(err)));
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(out,'viewer-report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,gameSha256:report.gameSha256,
    checks:report.checks.map(c=>c.name),errors:report.errors,
    lifecycleDiagnostic:report.status==='failed'?report.lifecycleDiagnostic:undefined}));
  if(report.status!=='passed')process.exitCode=1;
}
