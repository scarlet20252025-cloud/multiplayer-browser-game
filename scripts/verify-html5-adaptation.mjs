#!/usr/bin/env node
/** Three ordered checks on a private, instrumented HTML5 build. Never an original-package baseline. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { startHtml5ResearchHost } from './html5-research-host.mjs';
import { analyzeJumpTrace } from '../adapters/fireboy-html5/jump-analysis.mjs';

const { values } = parseArgs({ options: {
  root: {type:'string'}, script: {type:'string'}, out: {type:'string'},
  'expected-sha256': {type:'string'}, 'level-id': {type:'string',default:'1'}, help: {type:'boolean'},
} });
if (values.help) {
  console.log('Usage: node scripts/verify-html5-adaptation.mjs --root <private first-game folder> --script <relative game.js> [--expected-sha256 <hash>] [--level-id 1] [--out <new result directory>]');
  process.exit(0);
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const startedAt = new Date().toISOString();
const outDir = path.resolve(values.out ?? `local/html5-adaptation/${startedAt.replace(/[:.]/g,'-')}`);
const tasks = ['jump-edge','pause-interception','state-export'].map(name => ({name,status:'not-run'}));
const report = {
  schemaVersion:1, recordedAt:startedAt, status:'running',
  scope:'Instrumented HTML5 candidate: jump trajectory, pause request interface, read-only state export',
  originalPackageBaseline:false, userLocalPackageByteMatch:'unknown', originalGameNetplayVerified:false,
  actualRoomTransportTested:false,
  source:null, environment:{node:process.version,platform:process.platform,arch:process.arch},
  instrumentation:{instanceExposure:'HTTP response only',physicsStep:'delegating observation wrapper; timestep unchanged',
    fullUnlock:true, invulnerable:false, upstreamHtmlEntryLoaded:false},
  tasks, files:[], pageErrors:[], badResponses:[], failedRequests:[], blockedExternalRequests:[], consoleWarnings:[],
};
try {
  report.testedCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  report.workingTreeDirty=Boolean(execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim());
} catch { report.testedCommit=null; report.workingTreeDirty=null; }
const scrub = text => {
  let result=String(text);
  for(const [from,to] of [[values.root && path.resolve(values.root),'<private-game-root>'],[process.cwd(),'<repository>']]) {
    if(from)result=result.split(from).join(to);
  }
  return result.slice(0,10000);
};
async function save(name, data) {
  const bytes=Buffer.from(JSON.stringify(data,null,2)+'\n');
  await writeFile(path.join(outDir,name),bytes);
  report.files.push({path:name,bytes:bytes.length,sha256:sha(bytes)});
}
await mkdir(outDir,{recursive:true});
// Overwrite the summary immediately: an early failure cannot inherit an old passed summary.
await writeFile(path.join(outDir,'report.json'),JSON.stringify(report,null,2)+'\n');
let host, browser, page;
const live = () => page.evaluate(() => ({
  gamePaused:__game.paused, physicsPaused:__game.physics.box2d.paused,
  physicsSteps:window.__jumpObserver?.stepCount ?? null,
  water:{x:__game.level.pers2.body.x,y:__game.level.pers2.body.y},
  clockSeconds:__game.level.ui.clock.getElapsedSeconds(),
}));
async function task(index, action) {
  const item=tasks[index];
  item.startedAt=new Date().toISOString();
  try { Object.assign(item,await action()); }
  catch(error) { item.status=error instanceof assert.AssertionError?'failed':'blocked'; item.error=scrub(error.stack ?? error.message); }
  item.finishedAt=new Date().toISOString();
  console.log(JSON.stringify({task:item.name,status:item.status,error:item.error ?? null}));
}

try {
  host=await startHtml5ResearchHost({root:values.root,script:values.script});
  report.source={script:values.script,sha256:host.sourceSha256,bytes:host.sourceBytes,servedSha256:host.servedSha256};
  if(values['expected-sha256'])assert.equal(host.sourceSha256,values['expected-sha256'],'Source hash differs from the requested build');
  const launchOptions={timeout:20000};
  if(process.env.CHROMIUM_PATH)launchOptions.executablePath=process.env.CHROMIUM_PATH;
  browser=await chromium.launch(launchOptions);
  report.environment.browser=browser.version();
  const context=await browser.newContext({viewport:{width:1280,height:960}});
  // No account, external multiplayer patch, analytics, platform stub or hosted asset dependency.
  await context.route('**/*',async route=>{
    const url=new URL(route.request().url());
    if(['http:','https:'].includes(url.protocol)&&url.origin!==host.url){
      if(report.blockedExternalRequests.length<60)report.blockedExternalRequests.push(url.origin+url.pathname);
      await route.abort();
    }else await route.continue();
  });
  page=await context.newPage();
  page.on('pageerror',error=>{if(report.pageErrors.length<60)report.pageErrors.push({message:scrub(error.message),stack:scrub(error.stack ?? '')});});
  const publicUrl=url=>{const parsed=new URL(url);return (parsed.origin===host.url?'':parsed.origin)+parsed.pathname;};
  page.on('response',response=>{if(response.status()>=400&&report.badResponses.length<60)report.badResponses.push({url:publicUrl(response.url()),status:response.status()});});
  page.on('requestfailed',request=>{if(report.failedRequests.length<60)report.failedRequests.push({url:publicUrl(request.url()),error:request.failure()?.errorText});});
  page.on('console',message=>{if(['error','warning'].includes(message.type())&&report.consoleWarnings.length<60)report.consoleWarnings.push({type:message.type(),text:scrub(message.text())});});
  await page.addInitScript(()=>{
    localStorage.setItem('fb-forest:unlock','1');
    localStorage.removeItem('fb-forest:invulnerable');
  });
  await page.goto(host.url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>window.__game?.state?.current==='menu',null,{timeout:60000});
  // Use the live progress model: it adds the playable state and preserves object identity.
  // Invoke existing menu entry points, not physics/state constructors or invented map data.
  report.temple=await page.evaluate(()=>{
    const temple=__game.progress.get('temples').find(item=>item.id==='forest');
    if(!temple)throw new Error('The live progress model has no forest temple');
    __game.state.states[__game.state.current].startTemple(temple);
    return {id:temple.id};
  });
  await page.waitForFunction(()=>__game.state.current==='levelMenu'&&!__game.state.fading&&__game.state.states.levelMenu.buttons,null,{timeout:30000});
  report.level=await page.evaluate(requestedLevelId=>{
    const menu=__game.state.states.levelMenu;
    const level=menu.templeData.levels.find(item=>Number(item.id)===Number(requestedLevelId));
    if(!level)throw new Error('Requested level is absent from the live temple model');
    if(!(level.state>0))throw new Error('Requested level is not playable in the live progress model');
    menu.startLevel({data:level});
    return {id:level.id,filename:level.filename,state:level.state};
  },values['level-id']);
  await page.waitForFunction(()=>__game.state.current==='level'&&__game.level?.levelStarted&&__game.level.pers2?.body&&!__game.paused&&!__game.physics.box2d.paused&&!__game.state.fading,null,{timeout:45000});
  report.runtimeReady=await page.evaluate(()=>({state:__game.state.current,phaser:window.Phaser?.VERSION ?? null,
    gamePaused:__game.paused,physicsPaused:__game.physics.box2d.paused,canvasCount:document.querySelectorAll('canvas').length}));
  await page.evaluate(async()=>{
    const {installJumpObserver}=await import('/adapters/fireboy-html5/jump-observer.mjs');
    for(const player of [__game.level.pers1,__game.level.pers2])for(const direction of ['left','right','up'])player.cursors[direction].isDown=false;
    window.__jumpObserver=installJumpObserver(__game);
  });

  await task(0,async()=>{
    try {
      await page.waitForFunction(()=>{
        const recent=__jumpObserver.read().samples.filter(row=>row.kind==='after-physics-step').slice(-15);
        if(recent.length<15)return false;
        return ['water','fire'].every(key=>recent.every(row=>row[key].feetContacts>0&&!row.gamePaused&&!row.physicsPaused&&Math.abs(row[key].y-recent[0][key].y)<1.5));
      },null,{timeout:12000,polling:50});
      await page.evaluate(async()=>{
        const hold=()=>new Promise(resolve=>setTimeout(resolve,2000));
        __jumpObserver.setPhase('hold');__jumpObserver.setJump(true);
        await hold();__jumpObserver.capture('held-end');
        __jumpObserver.setPhase('release');__jumpObserver.setJump(false);
      });
      await page.waitForFunction(()=>{
        const rows=__jumpObserver.read().samples.filter(row=>row.phase==='release'&&row.kind==='after-physics-step');
        return rows.length>=12&&rows.at(-1).water.prohibitJump===false&&rows.at(-1).water.feetContacts>0;
      },null,{timeout:5000,polling:25});
      await page.evaluate(async()=>{
        __jumpObserver.setPhase('repress');__jumpObserver.setJump(true);
        await new Promise(resolve=>setTimeout(resolve,2000));__jumpObserver.capture('held-end');
        __jumpObserver.setPhase('finished');__jumpObserver.setJump(false);
      });
    } finally {
      await page.evaluate(()=>{__game.level.pers2.cursors.up.isDown=false;});
      const trace=await page.evaluate(()=>__jumpObserver.read());
      await save('jump-trace.json',{schemaVersion:1,sourceGameSha256:host.sourceSha256,level:report.level,...trace});
      tasks[0].analysis=analyzeJumpTrace(trace);
    }
    return {status:tasks[0].analysis.status,analysis:tasks[0].analysis};
  });

  await task(1,async()=>{
    const observation={scope:'Native P behavior and adapted request/authoritative-apply interface; no production room transport',native:{},adapted:{}};
    try {
      observation.native.before=await live();
      assert.equal(observation.native.before.gamePaused,false);
      await page.keyboard.press('p');
      observation.native.afterPress=await live();
      await page.waitForTimeout(250);
      observation.native.afterWait=await live();
      assert.equal(observation.native.afterPress.gamePaused,true);
      assert.equal(observation.native.afterPress.physicsPaused,observation.native.before.physicsPaused);
      assert.equal(observation.native.afterWait.physicsSteps,observation.native.afterPress.physicsSteps);
      await page.keyboard.press('p');
      await page.waitForFunction(previous=>!__game.paused&&__jumpObserver.stepCount>previous,observation.native.afterWait.physicsSteps,{timeout:5000});
      observation.native.afterResume=await live();

      await page.evaluate(async()=>{
        const {installPauseBridge}=await import('/adapters/fireboy-html5/pause-bridge.mjs');
        window.__pauseRequests=[];
        window.__pauseSentinelCalls=0;
        window.__pauseSentinel=()=>{window.__pauseSentinelCalls++;};
        __game.level.pauseKey.onDown.add(window.__pauseSentinel);
        window.__pauseOptions={level:__game.level,roomEpoch:'research-room-1',clientId:'research-page-1',
          sendRoomCommand:command=>{__pauseRequests.push({...command});}};
        window.__pauseBridge=installPauseBridge(__pauseOptions);
        if(installPauseBridge(__pauseOptions)!==__pauseBridge)throw new Error('Pause installation was not idempotent');
        __pauseBridge.applyAuthoritativeState({roomEpoch:'research-room-1',revision:0,paused:false});
      });
      observation.adapted.before=await live();
      await page.keyboard.press('p');
      await page.waitForTimeout(250);
      observation.adapted.requestOnly=await page.evaluate(()=>({requests:__pauseRequests,inspect:__pauseBridge.inspect(),sentinelCalls:__pauseSentinelCalls}));
      observation.adapted.afterRequest=await live();
      assert.equal(observation.adapted.requestOnly.requests.length,1);
      assert.equal(observation.adapted.requestOnly.requests[0].command,'pause.set');
      assert.equal(observation.adapted.requestOnly.requests[0].desiredPaused,true);
      assert.equal(observation.adapted.afterRequest.gamePaused,false,'P must only request a pause');
      assert.ok(observation.adapted.afterRequest.physicsSteps>observation.adapted.before.physicsSteps);
      assert.equal(observation.adapted.requestOnly.sentinelCalls,1,'Unrelated P listeners must remain');
      observation.adapted.apply=await page.evaluate(()=>__pauseBridge.applyAuthoritativeState({roomEpoch:'research-room-1',revision:1,paused:true}));
      observation.adapted.authoritativePaused=await live();
      await page.waitForTimeout(250);
      assert.equal((await live()).physicsSteps,observation.adapted.authoritativePaused.physicsSteps);
      assert.equal(observation.adapted.authoritativePaused.gamePaused,true);
      observation.adapted.duplicate=await page.evaluate(()=>__pauseBridge.applyAuthoritativeState({roomEpoch:'research-room-1',revision:1,paused:true}));
      assert.equal(observation.adapted.duplicate.changed,false);
      await page.keyboard.press('p');
      observation.adapted.resumeRequest=await page.evaluate(()=>({requests:__pauseRequests,localPaused:__game.paused}));
      assert.equal(observation.adapted.resumeRequest.requests.length,2);
      assert.equal(observation.adapted.resumeRequest.requests[1].desiredPaused,false);
      assert.equal(observation.adapted.resumeRequest.localPaused,true);
      await page.evaluate(()=>__pauseBridge.applyAuthoritativeState({roomEpoch:'research-room-1',revision:2,paused:false}));
      await page.waitForFunction(previous=>__jumpObserver.stepCount>previous,observation.adapted.authoritativePaused.physicsSteps,{timeout:5000});
      observation.adapted.resumed=await live();
      observation.adapted.uiMethod=await page.evaluate(()=>{
        __game.level.togglePause(); // The same dynamic method called by HUD/Resume, not a simulated pointer click.
        __game.level.togglePause();
        return {requests:__pauseRequests,localPaused:__game.paused};
      });
      assert.equal(observation.adapted.uiMethod.requests.length,3);
      assert.equal(observation.adapted.uiMethod.localPaused,false);
      return {status:'passed',productionRoomTransport:'not-integrated',nativeGamePauseAffectsPhysicsByEngineGate:true,box2dPauseFlagDirectlyChanged:false};
    } finally {
      await save('pause-observations.json',observation);
      await page.evaluate(()=>{
        if(window.__pauseBridge){__pauseBridge.applyAuthoritativeState({roomEpoch:'research-room-1',revision:100,paused:false});__pauseBridge.uninstall();}
        else if(__game.paused)__game.level.togglePause();
        if(window.__pauseSentinel)__game.level.pauseKey.onDown.remove(__pauseSentinel,null);
      });
    }
  });

  await task(2,async()=>{
    await page.evaluate(async sourceGameSha256=>{
      const {createSnapshotExporter}=await import('/adapters/fireboy-html5/state-snapshot.mjs');
      window.__snapshotExporter=createSnapshotExporter(__game,{sourceGameSha256,sessionEpoch:'research-forest-1',devices:window.Devices});
      window.__snapshotA=__snapshotExporter.capture();
    },host.sourceSha256);
    const first=await page.evaluate(()=>__snapshotA);
    await save('snapshot-a.json',first);
    assert.equal(first.coverage.requiredPresent,true,'Actual level must contain two characters, diamonds, two doors and a supported mechanism');
    assert.equal(first.coverage.allObservedPositionsFinite,true);
    const previous=await page.evaluate(()=>{__game.level.pers2.cursors.right.isDown=true;return __jumpObserver.stepCount;});
    try {
      await page.waitForFunction(count=>__jumpObserver.stepCount>=count+8,previous,{timeout:4000,polling:15});
      const {second,difference}=await page.evaluate(()=>{
        const second=__snapshotExporter.capture();
        return {second,difference:__snapshotExporter.diff(__snapshotA,second)};
      });
      await save('snapshot-b.json',second);
      await save('snapshot-diff.json',difference);
      assert.equal(second.coverage.requiredPresent,true);
      assert.equal(second.coverage.allObservedPositionsFinite,true);
      assert.equal(difference.sameLevel,true);
      assert.deepEqual(first.characters.map(actor=>actor.id),second.characters.map(actor=>actor.id));
      const before=first.characters.find(actor=>actor.slot===1),after=second.characters.find(actor=>actor.slot===1);
      assert.ok(Math.abs(after.position.x-before.position.x)>0.5,'Second observation must detect actual character movement');
      return {status:'passed',counts:first.counts,mechanismKinds:[...new Set(first.mechanisms.map(value=>value.kind))],
        stableCharacterIds:true,waterDeltaX:after.position.x-before.position.x,
        observedChanges:difference.changes.length,unsupported:first.unsupported,
        completeDisplaySeparation:false,completeGameState:false};
    } finally { await page.evaluate(()=>{__game.level.pers2.cursors.right.isDown=false;}); }
  });
} catch(error) {
  report.harnessError=scrub(error.stack ?? error.message);
  for(const item of tasks)if(item.status==='not-run'){item.status='blocked';item.reason='Research runtime did not become ready; see harnessError';}
} finally {
  if(page) {
    await page.evaluate(()=>window.__jumpObserver?.stop()).catch(()=>{});
    try { report.lastRuntime=await page.evaluate(()=>({state:window.__game?.state?.current,gamePaused:window.__game?.paused,
      physicsPaused:window.__game?.physics?.box2d?.paused,observerErrors:window.__jumpObserver?.read().errors ?? []})); } catch {}
  }
  if(browser)await browser.close().catch(()=>{});
  if(host){
    try { report.source.originalUnchanged=sha(await readFile(path.join(values.root,values.script)))===host.sourceSha256; }
    catch(error){report.source.originalUnchanged=false;report.source.recheckError=scrub(error.message);}
    await host.close().catch(()=>{});
  }
  const knownProgressErrors=report.pageErrors.filter(error=>
    host?.sourceSha256==='337125629748bace45e23b040e54b0d206e4cd78c9c8709d7785faa637e00677'&&
    error.message==='h5api is not defined'&&/:52779:\d+/.test(error.stack));
  report.diagnostics={
    knownProgressSdkErrors:knownProgressErrors.length,
    knownProgressSdkScope:'Inspected h5api.progress callback only; loading-progress UI and hosting SDK are not validated or stubbed',
    unexplainedPageErrors:report.pageErrors.filter(error=>!knownProgressErrors.includes(error)),
    missingGameResources:report.badResponses.filter(response=>response.url!=='/favicon.ico'),
    failedResourceRequests:report.failedRequests,
    blockedExternalRequests:report.blockedExternalRequests,
    unexplainedConsoleErrors:report.consoleWarnings.filter(message=>message.type==='error'),
    observerErrors:report.lastRuntime?.observerErrors ?? [],
  };
  const diagnosticsBlocked=report.diagnostics.unexplainedPageErrors.length>0||report.diagnostics.missingGameResources.length>0||report.failedRequests.length>0||report.blockedExternalRequests.length>0||report.diagnostics.unexplainedConsoleErrors.length>0||report.diagnostics.observerErrors.length>0;
  report.status=tasks.some(item=>item.status==='failed')||report.source?.originalUnchanged===false?'failed'
    :tasks.every(item=>item.status==='passed')&&!diagnosticsBlocked?'passed':'blocked';
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(outDir,'report.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,sourceSha256:report.source?.sha256,
    tasks:tasks.map(({name,status})=>({name,status})),report:path.relative(process.cwd(),path.join(outDir,'report.json'))}));
  process.exitCode=report.status==='passed'?0:1;
}
