#!/usr/bin/env node
/**
 * 量化冰火人权威流的真实节奏：状态消息间隔、载荷大小、权威往返。
 * 只测量，不改游戏；用于判断卡顿来自「快照太稀」还是「单次捕获太慢」。
 *
 *   node scripts/measure-html5-stream.mjs \
 *     --root "E:/.../html5-online/games" --script 1-forest-temple/js/game.js \
 *     --require-script lib/require.js --entry-path /1-forest-temple/index.html
 */
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {WebSocket} from 'ws';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';

const {values}=parseArgs({options:{
  root:{type:'string'},script:{type:'string'},'require-script':{type:'string'},
  'entry-path':{type:'string'},seconds:{type:'string'},out:{type:'string'},
}});
const seconds=Number(values.seconds??8);
const out=path.resolve(values.out??'local/html5-stream');
await mkdir(out,{recursive:true});

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const percentile=(sorted,p)=>sorted.length?sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]:null;

function connect(url){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(url.replace(/^http/,'ws')+'/ws');
    const player={ws,messages:[],send:obj=>ws.send(JSON.stringify(obj))};
    ws.on('message',buffer=>{
      const text=buffer.toString();
      try{player.messages.push({message:JSON.parse(text),bytes:Buffer.byteLength(text),at:performance.now()});}
      catch{}
    });
    ws.once('error',reject);ws.once('open',()=>resolve(player));
  });
}

const report={schemaVersion:1,startedAt:new Date().toISOString(),seconds,status:'blocked',checks:[]};
let room;const peers=[];let inputTimer,idleTimer;
try{
  if(!values.root||!values.script)throw Error('Private --root and --script required');
  room=await startHtml5ResearchRoom({root:values.root,script:values.script,
    requireScript:values['require-script'],entryPath:values['entry-path'],levelId:1});
  report.gameSha256=room.sourceSha256;

  const a=await connect(room.url),b=await connect(room.url);
  peers.push(a,b);
  a.send({type:'ready'});b.send({type:'ready'});
  const waitFor=(player,predicate,timeout=20000)=>{
    const until=Date.now()+timeout;
    return new Promise((resolve,reject)=>{
      const tick=()=>{
        const hit=player.messages.find(entry=>predicate(entry.message));
        if(hit)return resolve(hit);
        if(Date.now()>until)return reject(Error('timeout waiting for condition'));
        setTimeout(tick,30);
      };
      tick();
    });
  };
  await waitFor(a,m=>m.type==='room'&&m.room?.bothReady&&!m.room.effectivePaused);

  // Warm up so downloads, level setup and first snapshots are out of the sample.
  await sleep(2500);
  const started=performance.now();
  a.messages.length=0;b.messages.length=0;
  let seq=0,dir=1;
  // 走 400ms 停 600ms：持续按住会走进岩浆/尖刺，房间一 suspend 流就断了。
  a.send({type:'input',seq:seq++,moveX:1,moveY:0,buttons:0});
  inputTimer=setInterval(()=>{
    a.send({type:'input',seq:seq++,moveX:dir?1:0,moveY:0,buttons:0});
  },50);
  const flip=setInterval(()=>{dir=dir?0:1;},400);
  idleTimer=setInterval(()=>b.send({type:'input',seq:b.seq=(b.seq??0)+1,moveX:0,moveY:0,buttons:0}),120);
  b.seq=0;
  await sleep(seconds*1000);
  clearInterval(flip);
  clearInterval(inputTimer);clearInterval(idleTimer);

  const stateEntries=a.messages.filter(entry=>entry.message.type==='state');
  const states=stateEntries.map(entry=>entry.message);
  const gaps=[];
  for(let i=1;i<stateEntries.length;i++)
    gaps.push(stateEntries[i].at-stateEntries[i-1].at);
  const cleanGaps=gaps.filter(Number.isFinite).sort((x,y)=>x-y);
  const byteSizes=stateEntries.map(entry=>entry.bytes).sort((x,y)=>x-y);

  // 权威往返：CDP evaluate 一次的耗时，直接决定「每 tick 捕获」的上限。
  const authorityCosts=[];
  for(let i=0;i<5;i++){
    const t0=performance.now();
    await room.readAuthority();
    authorityCosts.push(performance.now()-t0);
  }

  const span=stateEntries.length>1?stateEntries.at(-1).at-stateEntries[0].at:0;
  const snapshot=states.at(-1)?.snapshot;
  report.checks.push({
    name:'state-stream',
    snapshots:states.length,
    hz:span>0?+(((states.length-1)/(span/1000))).toFixed(2):0,
    spanMs:+span.toFixed(0),
    expected:seconds*1000,
    gapP50:percentile(cleanGaps,0.5),
    gapP95:percentile(cleanGaps,0.95),
    gapMax:cleanGaps.at(-1),
    bytesP50:percentile(byteSizes,0.5),
    bytesMax:byteSizes.at(-1),
    kbytesPerSecond:+((byteSizes.reduce((n,x)=>n+x,0)/seconds)/1024).toFixed(1),
    authorityRoundTripMs:authorityCosts.map(x=>+x.toFixed(1)),
    authorityP50:+percentile([...authorityCosts].sort((x,y)=>x-y),0.5).toFixed(1),
    counts:snapshot?.counts??null,
    coverage:snapshot?.coverage??null,
  });
  report.status='ok';
}catch(error){
  report.status='failed';report.error=String(error.stack||error);
}finally{
  clearInterval(inputTimer);clearInterval(idleTimer);
  for(const peer of peers){try{peer.ws.terminate();}catch{}}
  if(room)await room.close().catch(()=>{});
  report.finishedAt=new Date().toISOString();
  await writeFile(path.join(out,'stream.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if(report.status!=='ok')process.exitCode=1;
}
