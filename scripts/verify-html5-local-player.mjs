#!/usr/bin/env node
/** End-user two-tab localhost smoke test on genuine HTML5 runtime, not mock sprites. */
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright';
import {startHtml5LocalRoom} from './start-html5-local-room.mjs';
const {values}=parseArgs({options:{root:{type:'string'},script:{type:'string'},
  'require-script':{type:'string'},'entry-path':{type:'string'},
  'expected-sha256':{type:'string'},out:{type:'string'}}});
const dir=path.resolve(values.out??'local/html5-local-player-results');
await mkdir(dir,{recursive:true});
const report={schemaVersion:1,status:'blocked',checks:[],errors:[],
  originalPackageBaseline:false,publicHostingVerified:false,
  scope:'two manually openable browser tabs, one native Box2D authority, private localhost'};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(fn,ms=60000){
  const deadline=Date.now()+ms;
  while(Date.now()<deadline){
    const value=await fn();
    if(value)return value;
    await sleep(80);
  }
  throw Error('Native local player timed out');
}
const pass=(name,value)=>report.checks.push({name,status:'passed',value});
const read=page=>page.evaluate(()=>({
  player:window.__localHtml5Player?.status()??null,
  hud:document.getElementById('research-player-status')?.textContent,
  waterX:window.__game?.level?.pers2?.sprite?.x??null,
  fireX:window.__game?.level?.pers1?.sprite?.x??null,
  localPaused:window.__game?.paused??null,
  physicsPause:window.__game?.physics?.box2d?.paused??null
}));
let app,browser;
try{
  if(!values.root||!values.script)throw Error('Private game directory required');
  app=await startHtml5LocalRoom({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path'],
    viewerPort:8877,roomPort:8878,levelId:1,
    expectedSha256:values['expected-sha256']??null});
  report.gameSha256=app.sourceSha256;
  browser=await chromium.launch({timeout:20000});
  const fire=await browser.newPage({viewport:{width:1280,height:960}});
  const water=await browser.newPage({viewport:{width:1280,height:960}});
  report.errorsFromPages=[];
  for(const page of [fire,water]){
    page.on('pageerror',error=>{if(report.errorsFromPages.length<40)
      report.errorsFromPages.push(error.message);});
    await page.route('**/*',route=>{
      try{return new URL(route.request().url()).origin===app.viewers.url
        ?route.continue():route.abort();}
      catch{return route.abort();}
    });
  }
  // Avoid three concurrent native Phaser loads on a constrained CI runner.
  // The authority is already loaded; join the first real page, then the second.
  await fire.goto(app.url,{waitUntil:'domcontentloaded'});
  await until(async()=>{
    const first=await read(fire);
    return first.player?.seat===0?first:null;
  },70000);
  await water.goto(app.url,{waitUntil:'domcontentloaded'});
  await until(async()=>{
    const [a,b]=await Promise.all([read(fire),read(water)]);
    return a.player?.initial&&b.player?.initial&&
      a.player.seat===0&&b.player.seat===1&&
      app.authority.room.running?{a,b}:null;
  },85000);
  const [a,b]=await Promise.all([read(fire),read(water)]);
  if(!a.hud?.includes('火娃')||!b.hud?.includes('水娃')||!a.localPaused||!b.localPaused)
    throw Error('Two-tab UI did not assign native spectator seats');
  pass('two-real-browser-tabs-self-join',{seats:[a.player.seat,b.player.seat],
    roleText:[a.hud,b.hud]});
  const initial=b.waterX;
  await water.keyboard.down('KeyD');
  await sleep(600);
  await water.keyboard.up('KeyD');
  const after=await until(async()=>{
    const [left,right]=await Promise.all([read(fire),read(water)]);
    if(!Number.isFinite(left.waterX)||left.waterX<=initial+20||
       Math.abs(left.waterX-right.waterX)>4)return null;
    return {left,right};
  },20000);
  pass('manual-keyboard-watergirl-moves-in-both-tabs',{
    originalX:initial,tabX:[after.left.waterX,after.right.waterX]});
  await fire.keyboard.press('KeyP');
  await until(()=>app.authority.room.userPaused===true,12000);
  if((await app.authority.readAuthority()).gamePaused!==true)
    throw Error('Manual P did not pause native authority');
  await water.keyboard.press('KeyP');
  await until(()=>app.authority.room.userPaused===false,12000);
  pass('manual-pause-and-resume-in-two-tabs',{revision:app.authority.room.pauseRevision});
  const known=report.errorsFromPages.filter(x=>x!=='h5api is not defined');
  if(known.length)throw Error('Unexpected source errors: '+known.join('; '));
  report.status='passed';
}catch(error){
  report.errors.push(String(error.stack??error));
  report.failureDiagnostics={};
  try{
    for(const [i,page] of (browser?.contexts()?.[0]?.pages()??[]).entries()){
      report.failureDiagnostics['page'+i]={
        url:page.url(),status:await read(page),
        gameState:await page.evaluate(()=>window.__game?.state?.current??null).catch(()=>null)
      };
    }
  }catch(err){report.failureDiagnostics.error=String(err);}
}
finally{
  await browser?.close().catch(error=>report.errors.push(String(error)));
  await app?.close().catch(error=>report.errors.push(String(error)));
  await writeFile(path.join(dir,'local-two-tab-report.json'),
    JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({status:report.status,gameSha256:report.gameSha256,
    checks:report.checks.map(x=>x.name),errors:report.errors,
    failureDiagnostics:report.status!=='passed'?report.failureDiagnostics:undefined,
    pageErrors:report.status!=='passed'?report.errorsFromPages:undefined}));
  if(report.status!=='passed')process.exitCode=1;
}
