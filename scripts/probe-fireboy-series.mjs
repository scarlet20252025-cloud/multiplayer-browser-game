#!/usr/bin/env node
/**
 * 森林冰火人四部曲的手感回归：每一部都起一个真实权威 + 两个真实标签页，
 * 按住右走 1.6 秒，统计本席位角色是否出现回退帧。
 *
 *   node scripts/probe-fireboy-series.mjs --root ".../html5-online/games"
 */
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';
import {startHtml5ResearchHost} from './html5-research-host.mjs';

const GAMES=[
  {dir:'1-forest-temple',templeId:'forest',storagePrefix:'fb-forest',title:'森林神庙'},
  {dir:'2-light-temple',templeId:'light',storagePrefix:'fb-light',title:'光明神庙'},
  {dir:'3-ice-temple',templeId:'ice',storagePrefix:'fb-ice',title:'冰雪神庙'},
  {dir:'4-crystal-temple',templeId:'crystal',storagePrefix:'fb-crystal',title:'水晶神庙'},
];

const {values}=parseArgs({options:{root:{type:'string'},out:{type:'string'},'only-dir':{type:'string'}}});
const out=path.resolve(values.out??'local/fireboy-series');
await mkdir(out,{recursive:true});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

if(!values.root)throw Error('Private --root required');
const root=values.root;
const report={schemaVersion:1,startedAt:new Date().toISOString(),status:'blocked',games:[]};
let browser;
try{
  browser=await chromium.launch();
  const games=values['only-dir']?GAMES.filter(g=>g.dir===values['only-dir']):GAMES;
  for(const game of games){
    const entry={id:game.templeId,title:game.title,dir:game.dir};
    let authority,viewers;const pages=[];
    try{
      const viewerPort=8891,roomPort=8892;
      authority=await startHtml5ResearchRoom({root,script:`${game.dir}/js/game.js`,
        requireScript:'lib/require.js',entryPath:`/${game.dir}/index.html`,levelId:1,
        templeId:game.templeId,storagePrefix:game.storagePrefix,gameId:game.templeId,
        port:roomPort,allowedViewerOrigins:[`http://127.0.0.1:${viewerPort}`]});
      viewers=await startHtml5ResearchHost({root,script:`${game.dir}/js/game.js`,
        requireScript:'lib/require.js',entryPath:`/${game.dir}/index.html`,port:viewerPort,
        autoJoinWsUrl:authority.localUrl.replace(/^http/,'ws')+'/ws',autoJoinLevelId:1,
        templeId:game.templeId,storagePrefix:game.storagePrefix,gameId:game.templeId});
      for(const seat of [0,1]){
        const page=await browser.newPage({viewport:{width:1024,height:768}});
        page.on('pageerror',error=>{entry.error=entry.error??String(error.message);});
        await page.goto(`${viewers.url}/${game.dir}/index.html?seat=${seat}`,{waitUntil:'domcontentloaded'});
        pages.push(page);
      }
      const until=Date.now()+60000;
      let ready=false;
      while(Date.now()<until){
        ready=await pages[0].evaluate(()=>{
          const s=window.__localHtml5Player?.status?.();
          return Boolean(s?.room?.bothReady&&!s.room.effectivePaused);
        }).catch(()=>false);
        if(ready)break;
        await sleep(300);
      }
      entry.ready=ready;
      if(!ready)throw Error('room did not become ready');
      await sleep(1200);
      await pages[0].evaluate(()=>{
        window.__probe=[];const t0=performance.now();
        const loop=()=>{const s=window.__game?.level?.pers1?.sprite;
          if(s)window.__probe.push([performance.now()-t0,s.x]);requestAnimationFrame(loop);};
        requestAnimationFrame(loop);
      });
      await pages[0].keyboard.down('ArrowRight');
      await sleep(1600);
      await pages[0].keyboard.up('ArrowRight');
      await sleep(300);
      const frames=await pages[0].evaluate(()=>window.__probe);
      let backward=0,forward=0,maxBack=0;
      for(let i=1;i<frames.length;i++){
        const dx=frames[i][1]-frames[i-1][1];
        // 亚像素抖动不算回退；只统计肉眼可见（>0.05px）的倒退。
        if(dx<-0.05){backward++;maxBack=Math.min(maxBack,dx);}else if(dx>0.05)forward++;
      }
      entry.frames=frames.length;
      entry.fps=frames.length>1?+(((frames.length-1)/((frames.at(-1)[0]-frames[0][0])/1000))).toFixed(1):null;
      entry.forwardFrames=forward;
      entry.backwardFrames=backward;
      entry.backwardRatio=+((backward/(frames.length-1||1))).toFixed(3);
      entry.maxBackwardPx=+maxBack.toFixed(2);
      entry.travelled=+(frames.at(-1)[1]-frames[0][1]).toFixed(1);
      entry.enginePaused=await pages[0].evaluate(()=>window.__game?.paused??null);
      entry.status=backward===0?'passed':'failed';
    }catch(error){
      entry.status='failed';entry.error=entry.error??String(error.message);
    }finally{
      for(const page of pages)await page.close().catch(()=>{});
      if(viewers)await viewers.close().catch(()=>{});
      if(authority)await authority.close().catch(()=>{});
      report.games.push(entry);
    }
  }
  report.status=report.games.every(g=>g.status==='passed')?'passed':'failed';
}catch(error){
  report.status='failed';report.error=String(error.stack||error);
}finally{
  if(browser)await browser.close().catch(()=>{});
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(out,'series.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if(report.status!=='passed')process.exitCode=1;
}
