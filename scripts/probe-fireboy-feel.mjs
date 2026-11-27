#!/usr/bin/env node
/**
 * 真机手感探针：两个真实浏览器标签页 + 一个真实 HTML5/Box2D 权威。
 * 采集本席位角色每帧的 sprite 坐标，用来回答两个问题：
 *   1) 按住右走时画面是否回退（dx<0 的帧占比、最大回退像素）；
 *   2) 按跳跃后 y 的实际轨迹与起跳延迟。
 *
 *   node scripts/probe-fireboy-feel.mjs --root ".../games" --script 1-forest-temple/js/game.js \
 *     --require-script lib/require.js --entry-path /1-forest-temple/index.html
 */
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';
import {startHtml5ResearchHost} from './html5-research-host.mjs';

const {values}=parseArgs({options:{
  root:{type:'string'},script:{type:'string'},'require-script':{type:'string'},
  'entry-path':{type:'string'},out:{type:'string'},headed:{type:'boolean'},
}});
const out=path.resolve(values.out??'local/fireboy-feel');
await mkdir(out,{recursive:true});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

const report={schemaVersion:1,startedAt:new Date().toISOString(),status:'blocked'};
let authority,viewers,browser,pages=[];
try{
  if(!values.root||!values.script)throw Error('Private --root and --script required');
  const viewerPort=8891,roomPort=8892,viewerOrigin=`http://127.0.0.1:${viewerPort}`;
  authority=await startHtml5ResearchRoom({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path'],levelId:1,
    port:roomPort,allowedViewerOrigins:[viewerOrigin]});
  viewers=await startHtml5ResearchHost({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path'],port:viewerPort,
    autoJoinWsUrl:authority.localUrl.replace(/^http/,'ws')+'/ws',autoJoinLevelId:1});

  browser=await chromium.launch({headless:!values.headed});
  for(const seat of [0,1]){
    const page=await browser.newPage({viewport:{width:1024,height:768}});
    const errors=[];
    page.on('pageerror',error=>errors.push(String(error.message)));
    await page.goto(`${viewers.url}/1-forest-temple/index.html?seat=${seat}`,{waitUntil:'domcontentloaded'});
    pages.push({page,seat,errors});
  }

  const status=()=>pages[0].page.evaluate(()=>window.__localHtml5Player?.status?.()??null);
  const until=Date.now()+60000;
  while(Date.now()<until){
    const s=await status();
    if(s?.room?.bothReady&&!s.room.effectivePaused)break;
    await sleep(300);
  }
  await sleep(1500);

  const installProbe=()=>pages[0].page.evaluate(()=>{
    window.__feelProbe={frames:[],active:true};
    const started=performance.now();
    const loop=()=>{
      if(!window.__feelProbe.active)return;
      const sprite=window.__game?.level?.pers1?.sprite;
      if(sprite)window.__feelProbe.frames.push([performance.now()-started,sprite.x,sprite.y]);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  });
  await installProbe();

  // 1) 按住右走 2.2 秒
  const page=pages[0].page;
  await page.keyboard.down('ArrowRight');
  await sleep(2200);
  await page.keyboard.up('ArrowRight');
  await sleep(400);

  const walk=await page.evaluate(()=>window.__feelProbe.frames.splice(0));
  const walkStats=(()=>{
    let backward=0,forward=0,maxBack=0,total=0;
    for(let i=1;i<walk.length;i++){
      const dx=walk[i][1]-walk[i-1][1];
      if(dx<0){backward++;maxBack=Math.min(maxBack,dx);}
      else if(dx>0)forward++;
      total+=Math.abs(dx);
    }
    return {frames:walk.length,forwardFrames:forward,backwardFrames:backward,
      backwardRatio:+(backward/(walk.length-1||1)).toFixed(3),
      maxBackwardPx:+maxBack.toFixed(2),pathPx:+total.toFixed(1),
      startX:+walk[0]?.[1]?.toFixed(1),endX:+walk.at(-1)?.[1]?.toFixed(1)};
  })();

  // 2) 跳跃：按下 120ms 再松，记录 y 轨迹 900ms
  const beforeJump=await page.evaluate(()=>{
    window.__feelProbe.frames.length=0;
    return window.__game?.level?.pers1?.sprite?.y??null;
  });
  await page.keyboard.down('Space');
  await sleep(120);
  await page.keyboard.up('Space');
  await sleep(900);
  const jump=await page.evaluate(()=>window.__feelProbe.frames.splice(0));
  const jumpStats=(()=>{
    const ys=jump.map(f=>f[2]);
    const baseline=beforeJump??ys[0];
    const minY=Math.min(...ys);
    const t0=jump[0]?.[0]??0;
    const takeoff=jump.find(f=>f[2]<baseline-2);
    const land=jump.find(f=>f[2]>=baseline-1&&f[0]>(takeoff?.[0]??0)+50);
    return {frames:ys.length,startY:+baseline?.toFixed(1),minY:+minY.toFixed(1),
      risePx:+(baseline-minY).toFixed(1),
      takeoffDelayMs:takeoff?+(takeoff[0]-t0).toFixed(0):null,
      airMs:takeoff&&land?+(land[0]-takeoff[0]).toFixed(0):null,
      ySeries:ys.slice(0,24).map(y=>+y.toFixed(1))};
  })();

  const errors=pages.flatMap(p=>p.errors);
  report.status='ok';
  report.walk=walkStats;
  report.jump=jumpStats;
  report.pageErrors=errors.slice(0,5);
  report.sampling=await page.evaluate(()=>{
    const s=window.__localHtml5Player?.status?.();
    return {frames:s?.frames??null,lastApply:s?.lastApply??null,seat:s?.seat??null};
  });
}catch(error){
  report.status='failed';report.error=String(error.stack||error);
}finally{
  for(const entry of pages)await entry.page.close().catch(()=>{});
  if(browser)await browser.close().catch(()=>{});
  if(viewers)await viewers.close().catch(()=>{});
  if(authority)await authority.close().catch(()=>{});
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(out,'feel.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if(report.status!=='ok')process.exitCode=1;
}
