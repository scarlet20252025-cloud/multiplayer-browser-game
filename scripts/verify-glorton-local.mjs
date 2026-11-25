import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright';
import {decodeGlortonFrame} from '../public/glorton-online/frame-wire.mjs';

const origin=new URL(process.argv[2]??'http://127.0.0.1:19361').origin;
const capacity=Number(process.argv[3]??4);
assert([2,3,4].includes(capacity),'Player count must be 2, 3, or 4');
const password=randomBytes(9).toString('hex');
const roomName='本地渲染测试-'+randomBytes(3).toString('hex');
const compareFile=process.env.GLORTON_COMPARE_FILE;
const bootTimeout=Number(process.env.GLORTON_BOOT_TIMEOUT_MS??50_000);
const verifyProvider=process.env.GLORTON_VERIFY_PROVIDER==='1';
const stallTest=process.env.GLORTON_VERIFY_STALL==='1';
const verifyMovement=process.env.GLORTON_VERIFY_MOVEMENT==='1';
const verifyRematch=process.env.GLORTON_VERIFY_REMATCH==='1';
const verifyVisual=verifyMovement||process.env.GLORTON_VERIFY_VISUAL==='1';
const minimumMovingFps=Number(process.env.GLORTON_MIN_MOVEMENT_FPS??30);
assert(!verifyMovement||Number.isFinite(minimumMovingFps)&&minimumMovingFps>=0,
  'GLORTON_MIN_MOVEMENT_FPS must be a non-negative number');
assert(!verifyMovement||!verifyRematch,'Run the Mogadishu movement benchmark separately from the map vote test');
const verifyHealthRetry=process.env.GLORTON_VERIFY_HEALTH_RETRY==='1';
const fighters=['SBLPlayer','PeachPlayer','TrashPlayer','CoffeePlayer','DefaultPlayer','AuberginePlayer'];
const tiedMaps=['Mogadishu','Rooftop'];

async function until(check,message,ms=20_000){
  const end=Date.now()+ms;
  while(Date.now()<end){
    const result=await check();
    if(result)return result;
    await sleep(75);
  }
  throw Error(message);
}

function trace(page){
  const log={errors:[],loads:[],binary:0,checkpoints:new Map(),frames:new Map(),received:[],desyncs:[],snapshots:[],welcomes:[],state:null,
    roomState:null,matchMap:null,matchStarts:new Map(),results:[],wire:[],local:[],publisherParts:new Set(),shellSizes:[],
    inputs:[],firstMoveEchoMs:null};
  page.on('pageerror',error=>log.errors.push(error.message));
  page.on('requestfailed',request=>{
    const {pathname}=new URL(request.url());
    if(pathname==='/glorton-online/browser-health')log.errors.push(pathname+' '+request.failure()?.errorText);
  });
  page.on('console',message=>{
    if(message.type()==='error'||/Traceback|Error:|Exception/.test(message.text()))log.errors.push(message.text());
    else log.loads.push(message.text());
  });
  page.on('response',response=>{
    const url=new URL(response.url());
    if(response.status()>=400)log.errors.push(response.status()+' '+url.pathname);
    if(verifyProvider&&response.ok()){
      if(url.hostname==='james123wang5.github.io'&&/\/chunks\/app-\d{3}\.bin$/.test(url.pathname))
        log.publisherParts.add(url.pathname);
      if(url.origin===origin&&url.pathname==='/glorton-local/app.apk')
        log.shellSizes.push(Number(response.headers()['content-length']));
    }
  });
  page.on('websocket',socket=>{
    if(new URL(socket.url()).pathname!=='/glorton-online/browser-ws')return;
    socket.on('framesent',({payload})=>{
      if(typeof payload!=='string'){log.binary++;return;}
      const packet=JSON.parse(payload);
      if(packet.op==='desync')log.desyncs.push(packet);
      if(verifyVisual&&packet.op==='input')log.inputs.push({controls:packet.controls,time:performance.now()});
    });
    socket.on('framereceived',({payload})=>{
      if(typeof payload!=='string'){log.binary++;return;}
      const packet=decodeGlortonFrame(JSON.parse(payload));
      log.received.push(packet.op);
      if(packet.op==='state')log.state=packet;
      if(packet.op==='welcome')log.welcomes.push(packet.slot);
      if(packet.op==='room_state')log.roomState=packet;
      if(packet.op==='match_start'){
        log.matchMap=packet.match_config?.stage;
        if(Number.isSafeInteger(packet.round))log.matchStarts.set(packet.round,packet.match_config);
      }
      if(packet.op==='match_end')log.results.push(packet);
      if(packet.op==='snapshot')log.snapshots.push(packet.snapshot.tick);
      if(compareFile&&['match_start','frame','snapshot'].includes(packet.op))
        log.wire.push(packet.op==='frame'?JSON.stringify(packet):payload);
      if(packet.op==='frame'){
        log.frames.set(packet.tick,packet.controls);
        if(packet.digest)log.checkpoints.set(packet.tick,packet.digest);
        const slot=log.welcomes.at(-1);
        if(verifyVisual&&log.firstMoveEchoMs===null&&Number.isInteger(slot)){
          const direction=slot%2?'left':'right';
          const sent=log.inputs.find(input=>input.controls?.[direction]);
          if(sent&&packet.controls[slot]?.[direction])log.firstMoveEchoMs=performance.now()-sent.time;
        }
      }
    });
  });
  return log;
}

async function go(page){
  await page.waitForURL(url=>url.pathname==='/glorton-local/index.html');
  const canvas=page.locator('#canvas');
  await canvas.waitFor({state:'visible',timeout:45_000});
  await canvas.click({position:{x:12,y:12}});
}
const measure=page=>page.evaluate(()=>window.GlortonLocalSession?.metrics());
const slotsMatch=(logs,index,property,value)=>logs.every(log=>log.roomState?.slots?.[index]?.[property]===value);
const canvasSize=page=>page.locator('#canvas').evaluate(canvas=>({width:canvas.width,height:canvas.height,
  visible:Math.round(canvas.getBoundingClientRect().width*devicePixelRatio)}));

async function terrainSample(page){
  return page.locator('#canvas').evaluate(canvas=>{
    const sample=document.createElement('canvas');
    sample.width=48;
    sample.height=24;
    const context=sample.getContext('2d');
    // Skip the black gutters and on-screen status. Only read back after a timed interval.
    context.drawImage(canvas,canvas.width*.1,canvas.height*.35,canvas.width*.8,canvas.height*.5,
      0,0,sample.width,sample.height);
    return Array.from(context.getImageData(0,0,sample.width,sample.height).data);
  });
}

function changedTerrain(before,after){
  let changed=0;
  for(let index=0;index<before.length;index+=4){
    const colorDifference=Math.max(...[0,1,2].map(channel=>Math.abs(before[index+channel]-after[index+channel])));
    if(colorDifference>36)changed++;
  }
  return changed*4/before.length;
}

function paintStats(samples){
  const sorted=field=>samples.map(sample=>sample[field]).sort((a,b)=>a-b);
  const fps=sorted('fps'), ms=sorted('renderMs');
  return {medianFps:Number(fps[Math.floor(fps.length/2)].toFixed(1)),lowestFps:Number(fps[0].toFixed(1)),
    medianRenderMs:Number(ms[Math.floor(ms.length/2)].toFixed(1)),samples:fps.length};
}

async function measureMovement(pages,logs){
  const host=pages[0];
  assert(logs.every(log=>log.matchMap==='Mogadishu'),'Movement benchmark used the wrong map');
  assert((await canvasSize(host)).width>=1200,'Movement benchmark requires a large canvas backing');
  async function sampleFrames(count){
    const samples=[];
    for(let index=0;index<count;index++){
      const sample=await measure(host);
      assert(sample?.status==='battle'&&Number.isFinite(sample.fps)&&Number.isFinite(sample.renderMs),
        'The battle stopped reporting rendered frames during the movement benchmark');
      samples.push(sample);
      if(index<count-1)await sleep(360);
    }
    return samples;
  }
  // Let the camera settle after the preceding input check and clear the rolling FPS window.
  await sleep(1100);
  const idleStart=await terrainSample(host);
  const idle=paintStats(await sampleFrames(6));
  const idleTerrainChange=changedTerrain(idleStart,await terrainSample(host));
  const terrainChanges=[];
  const moving=[];
  for(const key of ['d','a','d']){
    const direction=key==='a'?'left':'right';
    const start=logs[0].frames.size;
    await Promise.all(pages.map(page=>page.keyboard.down(key)));
    try{
      await until(()=>[...logs[0].frames.values()].slice(start).some(controls=>
        controls.slice(0,capacity).every(input=>input?.[direction])),
      `Could not confirm sustained ${direction} movement for every fighter`);
      await host.keyboard.press('w',{delay:160});
      // Let the HUD's rolling FPS window fully enter the moving period.
      await sleep(800);
      const before=await terrainSample(host);
      moving.push(...await sampleFrames(3));
      terrainChanges.push(changedTerrain(before,await terrainSample(host)));
    }finally{
      await Promise.all(pages.map(page=>page.keyboard.up(key)));
    }
  }
  assert(terrainChanges.filter(change=>change>=Math.max(.12,idleTerrainChange+.06)).length>=2,
    `Visible terrain did not move enough during timed samples (${terrainChanges.map(change=>change.toFixed(3))})`);
  return {canvas:await canvasSize(host),idle,moving:paintStats(moving),
    terrainChangePct:terrainChanges.map(change=>Math.round(change*100)),idleTerrainChangePct:Math.round(idleTerrainChange*100)};
}

const stageVote=(page,stage)=>page.locator(`[data-stage-vote="${stage}"]`);

async function verifyTiedMapVote(pages,logs){
  await until(()=>logs.every(log=>tiedMaps.every((stage,index)=>log.roomState?.map_votes?.[index]===stage)),
    'The stage votes did not reach every seat');
  for(const page of pages)for(const stage of tiedMaps){
    assert.match(await stageVote(page,stage).textContent(),/1\s*票/);
  }
  for(const [index,stage] of tiedMaps.entries()){
    assert.equal(await stageVote(pages[index],stage).getAttribute('aria-pressed'),'true');
  }
  assert(slotsMatch(logs,0,'ready',true),'Changing another vote cleared the first ready state');
  assert.equal(await pages[0].locator('[data-ready]').getAttribute('aria-pressed'),'true');
}

async function finishStockMatch(pages,logs,round){
  const guests=pages.slice(1);
  const finished=()=>logs.every(log=>log.results.some(result=>result.round===round&&result.reason==='game_set'));
  await Promise.all(guests.map(page=>page.locator('#canvas').click({position:{x:40,y:40}})));
  await Promise.all(guests.map(page=>page.keyboard.down('a')));
  try{
    const deadline=Date.now()+22_000;
    while(!finished()&&Date.now()<deadline){
      await Promise.all(guests.map(page=>page.keyboard.press('w',{delay:140})));
      await sleep(750);
    }
    assert(finished(),'The other fighters did not fall out of the one-stock match');
  }finally{
    await Promise.all(guests.map(page=>page.keyboard.up('a')));
  }
  for(const [index,page] of pages.entries()){
    assert.equal(logs[index].results.find(packet=>packet.round===round)?.winner_slot,0,
      'The authority did not award the match to the remaining player');
    const result=page.locator('.local-hud-result');
    await result.waitFor({state:'visible'});
    assert((await result.locator('[data-result-title]').textContent()).trim(),'The result has no title');
    await result.locator('[data-rematch]').waitFor({state:'visible'});
    await result.locator('[data-result-leave]').waitFor({state:'visible'});
  }
}

async function checkRematch(pages,logs,room){
  const firstMap=logs[0].matchMap;
  assert(tiedMaps.includes(firstMap)&&logs.every(log=>log.matchMap===firstMap),
    'The authority did not choose a synchronized map from the tied votes');
  const round=logs[0].roomState.round;
  assert.equal(round,1,'The first match did not start as round one');
  const fightersBefore=logs[0].roomState.slots.slice(0,capacity).map(({fighter,color})=>({fighter,color}));
  await finishStockMatch(pages,logs,round);
  await pages[0].locator('[data-rematch]').click();
  await until(()=>logs.every(log=>log.roomState?.round===round&&log.roomState.phase==='finished'&&
    log.roomState.rematch_votes?.length>=capacity&&log.roomState.rematch_votes[0]===true&&
    log.roomState.rematch_votes.slice(1,capacity).every(vote=>vote===false)),
  'The first replay vote did not remain on the result screen with the other seats undecided');
  assert.equal(await pages[0].locator('[data-rematch]').getAttribute('aria-pressed'),'true');
  for(const page of pages)assert(await page.locator('.local-hud-result').isVisible(),'A single vote started a replay');
  for(const page of pages.slice(1))await page.locator('[data-rematch]').click();
  await until(()=>logs.every(log=>{
    const state=log.roomState;
    return log.state?.room===room&&state?.phase==='lobby'&&state.round===round+1&&!state.result&&
      state.slots.slice(0,capacity).every(slot=>slot.connected&&!slot.ready)&&
      state.map_votes?.length>=capacity&&state.map_votes.slice(0,capacity).every(vote=>vote===null)&&
      state.rematch_votes?.length>=capacity&&state.rematch_votes.slice(0,capacity).every(vote=>vote===false);
  }),'The replay did not keep the same room and reset the ready, map vote, and replay choices');
  for(const log of logs){
    assert.deepEqual(log.roomState.slots.slice(0,capacity).map(({fighter,color})=>({fighter,color})),fightersBefore);
  }
  const newMap=tiedMaps.find(stage=>stage!==firstMap);
  await pages[0].evaluate(()=>window.GlortonLocalSession.sendControl({op:'settings_update',patch:{stock:1,items:false}}));
  await until(()=>logs.every(log=>log.roomState?.settings?.stock===1&&log.roomState.settings.items===false),
    'Could not confirm the one-stock replay setup');
  for(const page of pages)await stageVote(page,newMap).click();
  await until(()=>logs.every(log=>log.roomState?.map_votes?.length>=capacity&&
    log.roomState.map_votes.slice(0,capacity).every(vote=>vote===newMap)),
    'The replay map choices did not reach every seat');
  for(const page of pages)await page.locator('[data-ready]').click();
  await until(()=>logs.every(log=>log.matchStarts.size===2&&log.matchStarts.get(round+1)?.stage===newMap&&
    log.matchStarts.get(round+1).limit_value===1),'The second match did not start on the new chosen map');
  await until(async()=>(await Promise.all(pages.map(measure))).every(value=>value?.status==='battle'&&value.tick>=265),
    'The second match did not advance',30_000);
  await finishStockMatch(pages,logs,round+1);
  assert(logs.every(log=>log.desyncs.length===0),'The replay caused a checksum mismatch');
  await pages[0].locator('[data-result-leave]').click();
  await pages[0].waitForURL(url=>url.pathname==='/');
  await until(async()=>!(await publicRoom(room)),'Leaving the final result did not close the room');
  return {tiedMaps,firstMap,replayMap:newMap,reusedRoom:true,results:round+1,leftFromResult:true};
}

async function collectSnapshots(page,log){
  if(!compareFile)return;
  const snapshots=await page.evaluate(()=>window.glortonDiagnosticSnapshots?.splice(0)??[]).catch(()=>[]);
  log.local.push(...snapshots);
}

async function join(page,room){
  await page.getByLabel('房间密码',{exact:true}).fill(password);
  await page.getByRole('button',{name:'进入对局'}).click();
  await page.waitForURL(url=>url.pathname==='/glorton-local/index.html'&&new URLSearchParams(url.hash.slice(1)).get('room')===room);
}

async function post(path,body){
  const response=await fetch(origin+path,{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
  return {status:response.status,body:await response.json()};
}

async function publicRoom(code){
  for(let attempt=0;attempt<3;attempt++){
    try{
      const response=await fetch(origin+'/api/rooms',{signal:AbortSignal.timeout(2600)});
      assert(response.ok);
      return (await response.json()).rooms.find(room=>room.code===code);
    }catch(error){
      if(attempt===2)throw error;
      await sleep(150);
    }
  }
}

const browser=await chromium.launch({channel:process.env.GLORTON_CHROMIUM_CHANNEL});
try{
  const pages=await Promise.all(Array.from({length:capacity},()=>browser.newPage()));
  const [host,guest]=pages;
  if(verifyMovement)await host.setViewportSize({width:1920,height:1080});
  const logs=pages.map(trace);
  let healthProbes=0;
  if(verifyHealthRetry)await host.route('**/glorton-online/browser-health',route=>{
    healthProbes++;
    return healthProbes===1?route.fulfill({status:502,body:'temporarily unavailable'}):route.continue();
  });
  if(compareFile)await Promise.all(pages.map(page=>page.addInitScript(()=>{
    const captures=[];
    window.glortonDiagnosticSnapshots=captures;
    window.GlortonCapture=(tick,rawJson)=>captures.push([Number(tick),String(rawJson)]);
  })));
  try{
    await host.goto(origin+'/?glorton=host');
    await host.getByLabel('房间密码',{exact:true}).fill(password);
    await host.locator('#glorton-room-name').fill(roomName);
    await host.locator('#glorton-capacity').selectOption(String(capacity));
    await host.getByRole('button',{name:'创建并进入'}).click({timeout:30_000});
    if(verifyHealthRetry)assert(healthProbes>=2,'The lobby did not recover from a temporary health-check failure');
    await go(host);
    await until(()=>logs[0].welcomes.includes(0)&&logs[0].state?.room,'P1 browser engine did not attach',bootTimeout);
    const {room}=logs[0].state;
    assert.equal(logs[0].state.roomName,roomName);

    const duplicate=await post('/api/rooms',{name:roomName,password,gameId:'tank-trouble'});
    assert.equal(duplicate.body.error,'ROOM_NAME_TAKEN','The main lobby accepted the same room name for a second game');
    const unstarted=await post('/glorton-online/join',{room:roomName,password,name:'待加载'});
    assert.equal(unstarted.status,200,'Joining by the original room name failed');
    assert.equal(unstarted.body.room,room);
    assert.equal(unstarted.body.roomName,roomName);
    const available=await publicRoom(room);
    assert.equal(available.occupied,1,'An unattached browser occupied a seat');
    assert.equal(available.available,true);
    const leavePayload={room,seat:unstarted.body.seat};
    for(let attempt=0;attempt<2;attempt++)assert.equal((await post('/glorton-online/leave',leavePayload)).body.ok,true);

    if(verifyProvider){
      const failed=await browser.newPage();
      try{
        await failed.route('https://james123wang5.github.io/**/chunks/**',route=>route.abort());
        await failed.route('**/api/rooms',route=>route.fulfill({status:502,body:'temporarily unavailable'}));
        await failed.goto(origin+'/?'+new URLSearchParams({room:roomName}));
        assert.equal(await failed.locator('#join-title').textContent(),roomName,
          'The standard room-name link could not open a join form during a failed list load');
        await failed.getByLabel('房间密码',{exact:true}).fill(password);
        await failed.locator('[data-action="confirm-join"]').click();
        await failed.waitForURL(url=>url.pathname==='/glorton-local/index.html'&&new URLSearchParams(url.hash.slice(1)).get('room')===room);
        await failed.getByText('暂时无法读取发行方资源',{exact:false}).first().waitFor({state:'visible',timeout:20_000});
        assert.equal((await publicRoom(room)).occupied,1,'A failed game load occupied a seat');
        await failed.getByRole('button',{name:'返回大厅',exact:true}).click();
        await failed.waitForURL(url=>url.pathname==='/');
      }finally{await failed.close();}
    }

    await guest.goto(origin);
    const search=guest.locator('#plaza-search');
    const row=guest.locator('#plaza-list [data-game="glorton"] .catalog-room').filter({hasText:roomName});
    await search.fill(roomName);
    await row.waitFor({state:'visible'});
    await search.fill('不存在-'+roomName);
    await row.waitFor({state:'hidden'});
    await search.fill(room.toLowerCase());
    await row.waitFor({state:'visible'});
    assert.match(await row.textContent(),new RegExp(`1/${capacity}\\s*在线`));
    await row.getByRole('button',{name:'加入',exact:true}).click();
    await join(guest,room);
    await go(guest);
    await until(()=>logs[1].welcomes.includes(1),'P2 could not enter before testing a deliberate exit',bootTimeout);
    await guest.getByRole('button',{name:'返回大厅',exact:true}).click();
    await guest.waitForURL(url=>url.pathname==='/');
    await until(async()=>{
      const current=await publicRoom(room);
      return current?.available&&current.occupied===1&&!current.paused;
    },'Leaving as a guest did not free a vacancy',11_000);
    await guest.goto(origin+'/?'+new URLSearchParams({room:roomName,game:'glorton'}));
    await join(guest,room);
    for(const [index,page] of pages.slice(2).entries()){
      await page.goto(index===0?origin+'/?glorton='+room:origin+'/?'+new URLSearchParams({room:roomName,game:'glorton'}));
      await join(page,room);
    }
    await Promise.all(pages.slice(1).map(go));
    await until(()=>logs.every((log,index)=>log.welcomes.includes(index)&&log.state?.phase==='lobby'&&
      log.roomState?.slots?.filter(slot=>slot?.kind==='human'&&slot.connected).length===capacity),
    'Not every browser engine attached to the selected room',bootTimeout);
    assert.equal(logs[1].welcomes.filter(slot=>slot===1).length,2,'Returning guest did not claim the released seat');
    if(verifyMovement){
      await host.evaluate(()=>window.GlortonLocalSession.sendControl({op:'settings_update',patch:{stage:'Mogadishu',items:false}}));
      await until(()=>logs.every(log=>log.roomState?.settings?.stage==='Mogadishu'&&log.roomState.settings.items===false),
        'Could not select Mogadishu and disable random item effects');
    }
    if(verifyRematch){
      await host.evaluate(()=>window.GlortonLocalSession.sendControl({op:'settings_update',patch:{stock:1,items:false}}));
      await until(()=>logs.every(log=>log.roomState?.settings?.stock===1&&log.roomState.settings.items===false),
        'Could not set the one-stock match for a natural finish');
    }
    const [stage,left,right]=await Promise.all(['.glorton-stage','.local-hud-room','.local-hud-roster']
      .map(selector=>host.locator(selector).boundingBox()));
    assert(stage&&left&&right,'Game stage and sidebars must all be visible');
    assert(left.x+left.width<=stage.x&&stage.x+stage.width<=right.x,'Desktop sidebars overlap the game stage');
    assert(Math.abs(stage.x+stage.width/2-host.viewportSize().width/2)<3,'The game stage is not horizontally centered');

    for(const [index,page] of pages.entries()){
      const hud=page.locator('.glorton-local-hud');
      assert.match(await hud.locator('[data-self]').textContent(),new RegExp(`^P${index+1}`));
      if(verifyProvider)await until(()=>hud.locator('[data-fighter-list] img').evaluateAll(images=>
        images.length===6&&images.every(image=>image.naturalWidth>0&&!image.hidden)),
      `P${index+1} did not receive all six character previews`);
      const own=logs[index].roomState.slots[index];
      const fighter=fighters.find((name,offset)=>offset>=index&&name!==own.fighter);
      const color=(Number(own.color)+1)%4;
      await hud.locator(`[data-fighter="${fighter}"]`).click();
      await until(()=>slotsMatch(logs,index,'fighter',fighter),`P${index+1} character was not synchronized`);
      assert.equal(await hud.locator(`[data-fighter="${fighter}"]`).getAttribute('aria-pressed'),'true');
      await hud.getByLabel('颜色').selectOption(String(color));
      await until(()=>slotsMatch(logs,index,'color',color),`P${index+1} color was not synchronized`);
      if(verifyRematch&&tiedMaps[index])await stageVote(page,tiedMaps[index]).click();
      if(verifyRematch&&index===0){
        await hud.locator('[data-ready]').click();
        await until(()=>slotsMatch(logs,0,'ready',true),'The first player never became ready');
      }
      if(verifyRematch&&index>0){
        assert(slotsMatch(logs,0,'ready',true),'The other player editing their choice cleared the first ready state');
      }
    }
    if(verifyRematch)await verifyTiedMapVote(pages,logs);
    if(verifyVisual)await guest.setViewportSize({width:1000,height:760});
    for(const [index,page] of pages.entries()){
      if(verifyRematch&&index===0)continue;
      await page.getByRole('button',{name:'准备',exact:true}).click();
      if(index<capacity-1)await until(()=>slotsMatch(logs,index,'ready',true),`P${index+1} readiness was not synchronized`);
    }
    await until(()=>logs.every(log=>log.state?.phase==='playing'),'Not every browser engine started');
    await until(async()=>(await Promise.all(pages.map(measure))).every(item=>item?.tick>=265),
      'The browser battle simulations did not advance',30_000);

    await Promise.all(pages.map(page=>page.locator('#canvas').click({position:{x:40,y:40}})));
    const current=Math.max(0,...logs.flatMap(log=>[...log.frames.keys()]));
    const keys=pages.map((_,index)=>index%2?'a':'d');
    const sentBeforeMovement=logs.map(log=>log.inputs.length);
    await Promise.all(pages.map((page,index)=>page.keyboard.down(keys[index])));
    await sleep(825);
    await Promise.all(pages.map((page,index)=>page.keyboard.up(keys[index])));
    await until(()=>[...logs[0].frames].some(([tick,input])=>tick>current&&
      keys.every((key,index)=>input[index]?.[key==='a'?'left':'right'])),
    'The authority did not consume all keyboard inputs');
    if(verifyVisual)await until(()=>logs.every((log,index)=>{
      const direction=keys[index]==='a'?'left':'right';
      const sent=log.inputs.slice(sentBeforeMovement[index]);
      return sent.length===2&&sent[0].controls[direction]&&!sent[1].controls[direction]&&log.firstMoveEchoMs!==null;
    }),'Holding a movement key should send one press and one release');
    await until(async()=>(await Promise.all(pages.map(measure))).every(item=>item?.tick>=360),
      'Game state did not continue after the movement test');
    const common=()=>[...logs[0].checkpoints].filter(([tick])=>logs.every(log=>log.checkpoints.has(tick)));
    await until(()=>common().length>=12,'Insufficient common authoritative checkpoints',20_000);
    const matches=common();
    for(const [tick,digest] of matches)for(const log of logs)assert.equal(log.checkpoints.get(tick),digest);
    const metrics=await Promise.all(pages.map(measure));
    assert(logs.every(log=>log.desyncs.length===0),'Continuous play diverged from the authority');
    if(!stallTest)assert(metrics.every(item=>item.corrections===0),'Unexpected recovery without transport pacing');
    if(stallTest)await until(async()=>{
      const stats=await Promise.all(pages.map(measure));
      return stats.every(item=>Number.isFinite(item.rttMs)&&Number.isFinite(item.renderMs));
    },'Network RTT and render time were not reported independently');
    if(verifyVisual)await until(async()=>{
      const stats=await Promise.all(pages.map(measure));
      return stats.every(item=>Number.isFinite(item.linkRttMs)&&Number.isFinite(item.fps)&&item.fps>0);
    },'Actual display frame rate and transport RTT were not reported');
    let visibleBacking;
    if(verifyVisual){
      await until(async()=>{
        visibleBacking=await Promise.all(pages.map(canvasSize));
        return visibleBacking.every(item=>Math.abs(item.width-Math.min(1280,item.visible))<=8);
      },'Canvas buffers did not match their visible sizes');
      assert(visibleBacking[0].width>visibleBacking[1].width,'Both window sizes used the same canvas buffer');
    }
    const movement=verifyMovement?await measureMovement(pages,logs):null;
    const beforeRefresh=verifyMovement?await Promise.all(pages.map(measure)):metrics;

    const lastPage=pages.at(-1),lastLog=logs.at(-1);
    const snapshotsBeforeRefresh=logs.map(log=>log.snapshots.length);
    await collectSnapshots(lastPage,lastLog);
    await lastPage.reload({waitUntil:'domcontentloaded'});
    await go(lastPage);
    await until(()=>lastLog.welcomes.filter(slot=>slot===capacity-1).length===2&&lastLog.state?.room===room,
      `Refresh did not recover P${capacity}`,21_000);
    await until(async()=>(await Promise.all(pages.map(measure))).every(item=>item?.tick>=beforeRefresh.at(-1).tick+100),
      'The engines did not continue from the live snapshot');
    const restored=await Promise.all(pages.map(measure));
    if(verifyVisual){
      await lastPage.locator('#canvas').click({position:{x:40,y:40}});
      const pressedAfter=restored.at(-1).tick;
      await lastPage.keyboard.down('d');
      await until(()=>[...logs[0].frames].some(([tick,controls])=>tick>pressedAfter&&controls.at(-1)?.right),
        'The reattached seat could not move');
      await lastPage.keyboard.up('d');
    }
    const resumePackets=logs.map((log,index)=>log.snapshots.slice(snapshotsBeforeRefresh[index]));
    const recoveryTick=resumePackets.at(-1).find(tick=>resumePackets.every(ticks=>ticks.includes(tick)));
    assert(recoveryTick>=beforeRefresh.at(-1).tick,'Missing a live reconnect snapshot');
    assert(logs.every(log=>log.desyncs.length===0),'A browser requested mismatch recovery');
    if(!stallTest)assert.deepEqual(restored.map(item=>item.corrections),pages.map(()=>1),'A browser applied an unexpected snapshot');
    assert(logs.every(log=>log.binary===0),'The browsers exchanged binary frames');
    if(stallTest){
      const before=await measure(lastPage);
      const snapshotsBeforeStall=lastLog.snapshots.length;
      await lastPage.evaluate(()=>{
        const resumeAt=performance.now()+1600;
        while (performance.now()<resumeAt) { /* Simulate a suspended renderer. */ }
      });
      await until(()=>lastLog.snapshots.length>snapshotsBeforeStall,'An overloaded browser did not receive a recovery checkpoint');
      await until(async()=>{
        const results=await Promise.all(pages.map(measure));
        return results.every(item=>item.tick>=before.tick+100)&&
          Math.max(...results.map(item=>item.tick))-Math.min(...results.map(item=>item.tick))<=8;
      },'The overloaded browser kept falling behind after checkpoint recovery');
      assert(logs.every(log=>log.desyncs.length===0),'A render stall triggered a checksum mismatch');
    }
    if(verifyProvider)for(const log of logs){
      assert.equal(log.publisherParts.size,5,'The browser did not receive all five publisher-hosted chunks');
      assert(log.shellSizes.length>0&&log.shellSizes.every(size=>size>0&&size<256_000),
        'The lobby must serve only the small client bootstrap');
    }
    assert.equal(new URL(lastPage.url()).hash,'#room='+room);
    const rematch=verifyRematch?await checkRematch(pages,logs,room):null;
    console.log(JSON.stringify({origin,players:capacity,roomSearchByNameAndCode:true,sharedRoomNames:true,guestSeatReleased:true,centeredStage:true,syncedSelection:true,
      noStreamedFrames:true,commonCheckpoints:matches.length,stateCorrections:metrics.map(item=>item.corrections),
      recoveryTick,desyncRequests:0,allInputs:true,refreshRecovered:true,renderStallRecovered:stallTest,
      ...(verifyHealthRetry?{healthProbeRecovered:true}:{}),
      ...(stallTest?{networkRttMs:restored.map(item=>Math.round(item.rttMs??0)),
        renderMs:restored.map(item=>Math.round(item.renderMs??0))}:{}),
      ...(verifyVisual?{fps:restored.map(item=>Number.isFinite(item.fps)?Math.round(item.fps):null),
        linkRttMs:restored.map(item=>item.linkRttMs),visibleBacking,
        firstMoveEchoMs:logs.map(log=>Math.round(log.firstMoveEchoMs)),rejoinedInputApplied:true}:{}),
      ...(movement?{movement}:{}),
      ...(rematch?{rematch}:{}),
      ...(verifyProvider?{publisherHostedAssets:true,bootstrapBytes:logs[0].shellSizes[0]}:{})}));
    if(movement)assert(movement.moving.medianFps>=minimumMovingFps,
      `Moving-camera median was ${movement.moving.medianFps} FPS, minimum ${minimumMovingFps} FPS`);
  }catch(error){
    const diagnostics=await Promise.allSettled(pages.map(page=>page.evaluate(()=>({
      engine:window.GlortonLocalSession?.metrics(),
      health:document.querySelector('#glorton-health-text')?.textContent,
    }))));
    console.error(JSON.stringify(logs.map((log,index)=>({state:log.state,welcomes:log.welcomes,
      checkpoints:log.checkpoints.size,snapshots:log.snapshots,desyncs:log.desyncs.length,metrics:diagnostics[index].value,
      received:log.received.slice(-12),errors:log.errors.slice(-15),startup:log.loads.slice(-18)}))));
    throw error;
  }finally{
    if(compareFile){
      await Promise.all(pages.map((page,index)=>collectSnapshots(page,logs[index])));
      // Strings preserve exactly the number spellings in the native snapshots.
      await writeFile(compareFile,JSON.stringify({players:capacity,seats:logs.map(({wire,local})=>({wire,local}))}));
    }
  }
}finally{
  await browser.close();
}
