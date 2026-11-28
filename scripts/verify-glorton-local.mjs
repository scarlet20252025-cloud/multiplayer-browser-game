import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright';
import {decodeGlortonFrame} from '../public/glorton-online/frame-wire.mjs';

const origin=new URL(process.argv[2]??'http://127.0.0.1:19361').origin;
const playerCount=Number(process.argv[3]??4);
assert([2,3,4].includes(playerCount),'Player count must be 2, 3, or 4');
const roomLimit=4;
const startupCatchUpLimitMs=1500;
const password=randomBytes(9).toString('hex');
const roomName='本地渲染测试-'+randomBytes(3).toString('hex');
const compareFile=process.env.GLORTON_COMPARE_FILE;
const bootTimeout=Number(process.env.GLORTON_BOOT_TIMEOUT_MS??50_000);
const verifyProvider=process.env.GLORTON_VERIFY_PROVIDER==='1';
const stallTest=process.env.GLORTON_VERIFY_STALL==='1';
const verifyInputBurst=process.env.GLORTON_VERIFY_INPUT_BURST==='1';
const verifyPrepCanvas=process.env.GLORTON_VERIFY_PREP_CANVAS==='1';
const verifyMovement=process.env.GLORTON_VERIFY_MOVEMENT==='1';
const verifyRematch=process.env.GLORTON_VERIFY_REMATCH==='1';
const verifyReadyReload=process.env.GLORTON_VERIFY_READY_RELOAD==='1';
const verifyMapVote=verifyRematch||verifyReadyReload;
const verifyVisual=verifyMovement||process.env.GLORTON_VERIFY_VISUAL==='1';
const minimumMovingFps=Number(process.env.GLORTON_MIN_MOVEMENT_FPS??30);
assert(!verifyMovement||Number.isFinite(minimumMovingFps)&&minimumMovingFps>=0,
  'GLORTON_MIN_MOVEMENT_FPS must be a non-negative number');
assert(!verifyMovement||!verifyMapVote,'Run the Mogadishu movement benchmark separately from the map vote test');
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
    roomState:null,roomStatesReceived:0,matchMap:null,matchFighterCount:null,firstMatchClock:null,matchStarts:new Map(),results:[],wire:[],local:[],publisherParts:new Set(),shellSizes:[],
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
      if(packet.op==='room_state'){
        log.roomState=packet;
        log.roomStatesReceived++;
      }
      if(packet.op==='match_start'){
        log.matchMap=packet.match_config?.stage;
        log.matchFighterCount=packet.initial_snapshot?.fighters?.length;
        log.firstMatchClock??={tick:packet.initial_snapshot?.tick,tickMs:packet.tick_ms};
        if(Number.isSafeInteger(packet.round))log.matchStarts.set(packet.round,packet.match_config);
      }
      if(packet.op==='match_end')log.results.push(packet);
      if(packet.op==='snapshot')log.snapshots.push({tick:packet.snapshot.tick,phase:packet.snapshot.match_state});
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

async function go(page,mode='select'){
  await page.waitForURL(url=>url.pathname==='/glorton-local/index.html');
  const stage=page.locator(`.glorton-stage[data-mode="${mode}"]`);
  const surface=stage.locator(mode==='select'?'[data-ready]':'#canvas');
  const loadingCanvas=page.locator('.glorton-stage[data-mode="loading"] #canvas');
  await surface.or(loadingCanvas).first().waitFor({state:'visible',timeout:bootTimeout});
  if(await loadingCanvas.isVisible()){
    try{await loadingCanvas.click({position:{x:12,y:12},timeout:2_000});}
    catch(error){if(error.name!=='TimeoutError')throw error;}
  }
  await surface.waitFor({state:'visible',timeout:bootTimeout});
}
const measure=page=>page.evaluate(()=>window.GlortonLocalSession?.metrics());
const slotsMatch=(logs,index,property,value)=>logs.every(log=>log.roomState?.slots?.[index]?.[property]===value);
const canvasSize=page=>page.locator('#canvas').evaluate(canvas=>({width:canvas.width,height:canvas.height,
  visible:Math.round(canvas.getBoundingClientRect().width*devicePixelRatio)}));

async function checkInputBurst(page,log){
  const lastTick=()=>Math.max(0,...log.frames.keys());
  function confirmed(after,predicate,message){
    return until(()=>[...log.frames].find(([tick,controls])=>tick>after&&predicate(controls[0]))?.[0],message,6_000);
  }
  const keyboard=page.keyboard;
  const canvas=page.locator('#canvas');
  await canvas.focus();
  const before=lastTick();
  await keyboard.down('a');
  let tick=await confirmed(before,input=>input?.left,'The first held direction never reached the authority');
  await keyboard.down('d');
  tick=await confirmed(tick,input=>input?.right&&!input.left,'The last pressed direction did not take precedence');
  await keyboard.up('d');
  tick=await confirmed(tick,input=>input?.left&&!input.right,'Releasing the second direction did not restore the held key');
  await keyboard.up('a');
  tick=await confirmed(tick,input=>!input?.left&&!input?.right,'Releasing both directions did not stop movement');

  const quickTapTrials=8;
  for(let trial=0;trial<quickTapTrials;trial++){
    const beforeShort=lastTick();
    await keyboard.press('Shift');
    await keyboard.press('s');
    const press=await confirmed(beforeShort,input=>input?.shield_pressed&&!input.shield_released,'The short shield press was lost');
    await confirmed(press,input=>input?.shield_released&&!input.shield_pressed,'The short shield release was lost');
    const down=await confirmed(beforeShort,input=>input?.down,'The short duck input was lost');
    await confirmed(down,input=>!input?.down,'The short duck release was lost');
  }

  const start=lastTick();
  const burstCount=40;
  for(let index=0;index<burstCount;index++){
    const direction=index%2?'a':'d';
    const action=['j','k','Shift','w'][index%4];
    await keyboard.down(direction);
    await keyboard.press(action);
    await keyboard.up(direction);
    await sleep(70);
  }
  const fields=['left','right','jump_pressed','punch_pressed','special_pressed','shield_pressed','shield_released'];
  await until(()=>fields.every(field=>[...log.frames].some(([tick,controls])=>tick>start&&controls[0]?.[field])),
    'A movement or attack type was lost during the mixed input burst',8_000);

  const beforeBlur=lastTick();
  await keyboard.down('a');
  await keyboard.down('Shift');
  const held=await confirmed(beforeBlur,input=>input?.left&&input.shield_pressed,'The focus-loss setup never reached the authority');
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));
  const cleared=await confirmed(held,input=>!input?.left&&!input?.right&&input?.shield_released,'Losing focus left a movement or shield input held');
  await keyboard.up('a');
  await keyboard.up('Shift');
  await canvas.focus();
  await keyboard.press('k');
  const resumed=await confirmed(cleared,input=>input?.special_pressed,'Input failed after returning focus');
  assert.equal(log.desyncs.length,0,'Mixed inputs caused a synchronization error');
  return {transitions:burstCount*4,quickTapTrials,confirmedActions:fields.length,blurReleased:true,throughTick:resumed};
}

function verifyStartupCatchUp(logs,metrics){
  return logs.map((log,index)=>{
    const player=`P${index+1}`;
    const clock=log.firstMatchClock;
    assert(Number.isSafeInteger(clock?.tick)&&Number.isSafeInteger(clock.tickMs)&&clock.tickMs>0,
      `${player} did not receive the initial match clock`);
    assert(log.desyncs.length===0,`${player} requested mismatch recovery during continuous play`);
    // A paced relay can catch up once while the engine starts. Any later snapshot is a regression in this run.
    assert(log.snapshots.length<=1,`${player} received multiple snapshots before the deliberate reload`);
    const recovery=log.snapshots[0];
    if(recovery){
      const elapsed=(recovery.tick-clock.tick)*clock.tickMs;
      assert(elapsed>0&&elapsed<=startupCatchUpLimitMs&&['loading','countdown'].includes(recovery.phase),
        `${player} received an unexpected in-play snapshot at tick ${recovery.tick} (${recovery.phase})`);
    }
    assert.equal(metrics[index].corrections,log.snapshots.length,`${player} applied an unexpected number of corrections`);
    return recovery?.tick??null;
  });
}

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
        controls.slice(0,playerCount).every(input=>input?.[direction])),
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

async function verifySetupPreviews(page,seat){
  const loaded=(selector,count)=>page.locator(selector).evaluateAll((images,count)=>(
    images.length===count&&images.every(image=>image.naturalWidth>0&&!image.hidden)
  ),count);
  await until(()=>loaded('[data-fighter-list] img',6),`P${seat+1} did not receive all six character previews`);
  if(verifyReadyReload){
    await until(()=>loaded('[data-stage-list] img',4),`P${seat+1} did not receive all four map previews`);
    await until(()=>loaded('[data-picked-portrait]',1),`P${seat+1} did not receive the selected character preview`);
  }
}

async function verifyReadyRefresh(host,logs,room){
  const log=logs[0];
  const beforeWelcome=log.welcomes.length;
  const beforeRoomState=log.roomStatesReceived;
  const {fighter,color,ready}=log.roomState.slots[0];
  const stage=log.roomState.map_votes[0];
  assert.equal(ready,true);
  assert(stage,'P1 had no initial map vote to preserve');
  await host.reload({waitUntil:'domcontentloaded'});
  await go(host);
  await until(()=>log.welcomes.length>beforeWelcome&&log.welcomes.at(-1)===0&&log.state?.room===room&&
    log.roomStatesReceived>beforeRoomState&&log.roomState?.phase==='lobby'&&
    logs.every(item=>item.roomState?.slots?.[0]?.connected===true),
  'P1 did not restore the existing pregame seat after refresh',bootTimeout);
  for(const [index,item] of logs.entries()){
    const current=item.roomState.slots[0];
    assert.deepEqual({fighter:current.fighter,color:current.color,ready:current.ready},{fighter,color,ready},
      `P${index+1} did not retain P1's character, color, and ready state after refresh`);
    assert.equal(item.roomState.map_votes[0],stage,`P${index+1} did not retain P1's map vote after refresh`);
  }
  assert.equal(await host.locator(`[data-fighter="${fighter}"]`).getAttribute('aria-pressed'),'true');
  assert.equal(await host.getByLabel('颜色').inputValue(),String(color));
  assert.equal(await stageVote(host,stage).getAttribute('aria-pressed'),'true');
  assert.equal(await host.locator('[data-ready]').getAttribute('aria-pressed'),'true');
  await verifySetupPreviews(host,0);
}

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

async function checkRematch(pages,logs,room,firstMap){
  const round=logs[0].roomState.round;
  assert.equal(round,1,'The first match did not start as round one');
  const fightersBefore=logs[0].roomState.slots.slice(0,playerCount).map(({fighter,color})=>({fighter,color}));
  await finishStockMatch(pages,logs,round);
  await pages[0].locator('[data-rematch]').click();
  await until(()=>logs.every(log=>log.roomState?.round===round&&log.roomState.phase==='finished'&&
    log.roomState.rematch_votes?.length>=playerCount&&log.roomState.rematch_votes[0]===true&&
    log.roomState.rematch_votes.slice(1,playerCount).every(vote=>vote===false)),
  'The first replay vote did not remain on the result screen with the other seats undecided');
  assert.equal(await pages[0].locator('[data-rematch]').getAttribute('aria-pressed'),'true');
  for(const page of pages)assert(await page.locator('.local-hud-result').isVisible(),'A single vote started a replay');
  for(const page of pages.slice(1))await page.locator('[data-rematch]').click();
  await until(()=>logs.every(log=>{
    const state=log.roomState;
    return log.state?.room===room&&state?.phase==='lobby'&&state.round===round+1&&!state.result&&
      state.slots.slice(0,playerCount).every(slot=>slot.connected&&!slot.ready)&&
      state.map_votes?.length>=playerCount&&state.map_votes.slice(0,playerCount).every(vote=>vote===null)&&
      state.rematch_votes?.length>=playerCount&&state.rematch_votes.slice(0,playerCount).every(vote=>vote===false);
  }),'The replay did not keep the same room and reset the ready, map vote, and replay choices');
  for(const log of logs){
    assert.deepEqual(log.roomState.slots.slice(0,playerCount).map(({fighter,color})=>({fighter,color})),fightersBefore);
  }
  const newMap=tiedMaps.find(stage=>stage!==firstMap);
  await pages[0].evaluate(()=>window.GlortonLocalSession.sendControl({op:'settings_update',patch:{stock:1,items:false}}));
  await until(()=>logs.every(log=>log.roomState?.settings?.stock===1&&log.roomState.settings.items===false),
    'Could not confirm the one-stock replay setup');
  for(const page of pages)await stageVote(page,newMap).click();
  await until(()=>logs.every(log=>log.roomState?.map_votes?.length>=playerCount&&
    log.roomState.map_votes.slice(0,playerCount).every(vote=>vote===newMap)),
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
  const pages=await Promise.all(Array.from({length:playerCount},()=>browser.newPage()));
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
    assert.equal(await host.getByLabel('参赛人数',{exact:true}).count(),0,'The create dialog still asks for a fixed roster');
    await host.getByRole('button',{name:'创建并进入'}).click({timeout:30_000});
    if(verifyHealthRetry)assert(healthProbes>=2,'The lobby did not recover from a temporary health-check failure');
    await go(host);
    await until(()=>logs[0].welcomes.includes(0)&&logs[0].state?.room,'P1 browser engine did not attach',bootTimeout);
    const {room}=logs[0].state;
    assert.equal(logs[0].state.roomName,roomName);
    assert.equal(logs[0].state.automaticRoster,true,'The lobby did not create an automatic roster');
    assert.equal(logs[0].state.capacity,roomLimit);
    assert.equal(logs[0].state.minimumPlayers,2);
    await host.getByText('至少 2 位玩家在线才能开局。',{exact:true}).waitFor();
    if(verifyPrepCanvas){
      const preparation=await host.locator('#canvas').evaluate(canvas=>{
        // Pygbag can run this assignment after the preparation UI has rendered.
        canvas.style.visibility='visible';
        const ready=document.querySelector('[data-ready]');
        const rect=ready.getBoundingClientRect();
        return {masked:getComputedStyle(canvas).visibility==='hidden',
          clickable:ready.contains(document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2))};
      });
      assert.deepEqual(preparation,{masked:true,clickable:true},'The runtime canvas obscured the preparation screen');
    }
    await host.getByRole('button',{name:'准备',exact:true}).click();
    await until(()=>logs[0].roomState?.slots?.[0]?.ready===true,'P1 could not prepare while waiting for guests');
    assert.equal(logs[0].matchStarts.size,0,'A new room started with only one player');
    await host.getByRole('button',{name:'取消准备',exact:true}).click();
    await until(()=>logs[0].roomState?.slots?.[0]?.ready===false,'P1 could not cancel while waiting for guests');

    const duplicate=await post('/api/rooms',{name:roomName,password,gameId:'tank-trouble'});
    assert.equal(duplicate.body.error,'ROOM_NAME_TAKEN','The main lobby accepted the same room name for a second game');
    const unstarted=await post('/glorton-online/join',{room:roomName,password,name:'待加载'});
    assert.equal(unstarted.status,200,'Joining by the original room name failed');
    assert.equal(unstarted.body.room,room);
    assert.equal(unstarted.body.roomName,roomName);
    const available=await publicRoom(room);
    assert.equal(available.capacity,roomLimit);
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
    assert.match(await row.textContent(),new RegExp(`1/${roomLimit}\\s*在线`));
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
    await Promise.all(pages.slice(1).map(page=>go(page)));
    await until(()=>logs.every((log,index)=>log.welcomes.includes(index)&&log.state?.phase==='lobby'&&
      log.roomState?.slots?.filter(slot=>slot?.kind==='human'&&slot.connected).length===playerCount),
    'Not every browser engine attached to the selected room',bootTimeout);
    assert.equal(logs[1].welcomes.filter(slot=>slot===1).length,2,'Returning guest did not claim the released seat');
    await host.getByText(`0/${playerCount} 已准备`,{exact:true}).waitFor();
    assert.equal(await host.locator('[data-player-vacant]').count(),roomLimit-playerCount);
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
      if(verifyProvider||verifyReadyReload)await verifySetupPreviews(page,index);
      const own=logs[index].roomState.slots[index];
      const fighter=fighters.find((name,offset)=>offset>=index&&name!==own.fighter);
      const color=(Number(own.color)+1)%4;
      await hud.locator(`[data-fighter="${fighter}"]`).click();
      await until(()=>slotsMatch(logs,index,'fighter',fighter),`P${index+1} character was not synchronized`);
      assert.equal(await hud.locator(`[data-fighter="${fighter}"]`).getAttribute('aria-pressed'),'true');
      await hud.getByLabel('颜色').selectOption(String(color));
      await until(()=>slotsMatch(logs,index,'color',color),`P${index+1} color was not synchronized`);
      if(verifyMapVote&&tiedMaps[index])await stageVote(page,tiedMaps[index]).click();
      if(verifyMapVote&&index===0){
        await hud.locator('[data-ready]').click();
        await until(()=>slotsMatch(logs,0,'ready',true),'The first player never became ready');
        await until(()=>logs.every(log=>log.roomState?.map_votes?.[0]===tiedMaps[0]),'The first map vote did not synchronize');
        if(verifyReadyReload)await verifyReadyRefresh(host,logs,room);
      }
      if(verifyMapVote&&index>0){
        assert(slotsMatch(logs,0,'ready',true),'The other player editing their choice cleared the first ready state');
      }
    }
    if(verifyMapVote)await verifyTiedMapVote(pages,logs);
    if(verifyVisual)await guest.setViewportSize({width:1000,height:760});
    for(const [index,page] of pages.entries()){
      if(verifyMapVote&&index===0)continue;
      await page.getByRole('button',{name:'准备',exact:true}).click();
      if(index<playerCount-1){
        await until(()=>slotsMatch(logs,index,'ready',true),`P${index+1} readiness was not synchronized`);
        assert(logs.every(log=>log.matchStarts.size===0),'The match began before all occupied seats were ready');
      }
    }
    await until(()=>logs.every(log=>log.state?.phase==='playing'),'Not every browser engine started');
    await Promise.all(pages.map(page=>go(page,'battle')));
    assert(logs.every(log=>log.matchFighterCount===playerCount),'The match roster differs from the ready players');
    const tiedMapWinner=verifyMapVote?logs[0].matchMap:null;
    if(verifyMapVote)assert(tiedMaps.includes(tiedMapWinner)&&logs.every(log=>log.matchMap===tiedMapWinner),
      'The authority did not choose a synchronized map from the tied votes');
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
    const inputBurst=verifyInputBurst?await checkInputBurst(host,logs[0]):null;
    await until(async()=>(await Promise.all(pages.map(measure))).every(item=>item?.tick>=360),
      'Game state did not continue after the movement test');
    const common=()=>[...logs[0].checkpoints].filter(([tick])=>logs.every(log=>log.checkpoints.has(tick)));
    await until(()=>common().length>=12,'Insufficient common authoritative checkpoints',20_000);
    const matches=common();
    for(const [tick,digest] of matches)for(const log of logs)assert.equal(log.checkpoints.get(tick),digest);
    assert(logs.every(log=>log.desyncs.length===0),'Continuous play diverged from the authority');
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
    const beforeRefresh=await Promise.all(pages.map(measure));
    const startupCatchUpTicks=verifyStartupCatchUp(logs,beforeRefresh);

    const lastPage=pages.at(-1),lastLog=logs.at(-1);
    const snapshotsBeforeRefresh=logs.map(log=>log.snapshots.length);
    const welcomesBeforeRefresh=lastLog.welcomes.length;
    await collectSnapshots(lastPage,lastLog);
    await lastPage.reload({waitUntil:'domcontentloaded'});
    await go(lastPage,'battle');
    await until(()=>lastLog.welcomes.length>welcomesBeforeRefresh&&lastLog.welcomes.at(-1)===playerCount-1&&lastLog.state?.room===room,
      `Refresh did not recover P${playerCount}`,bootTimeout);
    await until(async()=>(await Promise.all(pages.map(measure))).every(item=>item?.tick>=beforeRefresh.at(-1).tick+100),
      'The engines did not continue from the live snapshot');
    let restored=await Promise.all(pages.map(measure));
    if(verifyVisual){
      await lastPage.locator('#canvas').click({position:{x:40,y:40}});
      const pressedAfter=restored.at(-1).tick;
      await lastPage.keyboard.down('d');
      await until(()=>[...logs[0].frames].some(([tick,controls])=>tick>pressedAfter&&controls.at(-1)?.right),
        'The reattached seat could not move');
      await lastPage.keyboard.up('d');
    }
    const resumePackets=logs.map((log,index)=>log.snapshots.slice(snapshotsBeforeRefresh[index]).map(({tick})=>tick));
    const recoveryTick=resumePackets.at(-1).find(tick=>resumePackets.every(ticks=>ticks.includes(tick)));
    assert(recoveryTick>=beforeRefresh.at(-1).tick,'Missing a live reconnect snapshot');
    assert(resumePackets.slice(0,-1).every(ticks=>ticks.length===1),'A connected seat needed extra recovery during live reconnect');
    const joiningPackets=resumePackets.at(-1);
    const rejoinCatchUpTick=joiningPackets.find(tick=>tick!==recoveryTick)??null;
    assert(joiningPackets.length<=2&&(rejoinCatchUpTick===null||
      (rejoinCatchUpTick>recoveryTick&&rejoinCatchUpTick-recoveryTick<=60)),
    'The refreshed renderer did not settle within its initial catch-up window');
    if(rejoinCatchUpTick!==null){
      const afterResume=logs.map(log=>log.snapshots.length);
      await until(async()=>(await Promise.all(pages.map(measure))).every(item=>item?.tick>=rejoinCatchUpTick+60),
        'The refreshed browser did not keep up after its catch-up snapshot');
      assert.deepEqual(logs.map(log=>log.snapshots.length),afterResume,'An extra snapshot arrived after the reconnect window');
      restored=await Promise.all(pages.map(measure));
    }
    assert(logs.every(log=>log.desyncs.length===0),'A browser requested mismatch recovery');
    const expectedCorrections=beforeRefresh.map((item,index)=>index===playerCount-1?joiningPackets.length:item.corrections+1);
    assert.deepEqual(restored.map(item=>item.corrections),expectedCorrections,'A browser applied an unexpected reconnect snapshot');
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
    const rematch=verifyRematch?await checkRematch(pages,logs,room,tiedMapWinner):null;
    console.log(JSON.stringify({origin,players:playerCount,roomLimit,automaticRoster:true,roomSearchByNameAndCode:true,sharedRoomNames:true,guestSeatReleased:true,centeredStage:true,syncedSelection:true,
      noStreamedFrames:true,commonCheckpoints:matches.length,stateCorrections:beforeRefresh.map(item=>item.corrections),startupCatchUpTicks,
      recoveryTick,rejoinCatchUpTick,desyncRequests:0,allInputs:true,refreshRecovered:true,renderStallRecovered:stallTest,
      preparationCanvasMasked:verifyPrepCanvas,
      ...(verifyReadyReload?{pregameRefreshRecovered:true,characterAndMapPreviews:true,tiedMapWinner}:{}),
      ...(verifyHealthRetry?{healthProbeRecovered:true}:{}),
      ...(stallTest?{networkRttMs:restored.map(item=>Math.round(item.rttMs??0)),
        renderMs:restored.map(item=>Math.round(item.renderMs??0))}:{}),
      ...(verifyVisual?{fps:restored.map(item=>Number.isFinite(item.fps)?Math.round(item.fps):null),
        linkRttMs:restored.map(item=>item.linkRttMs),visibleBacking,
        firstMoveEchoMs:logs.map(log=>Math.round(log.firstMoveEchoMs)),rejoinedInputApplied:true}:{}),
      ...(movement?{movement}:{}),
      ...(inputBurst?{inputBurst}:{}),
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
      await writeFile(compareFile,JSON.stringify({players:playerCount,seats:logs.map(({wire,local})=>({wire,local}))}));
    }
  }
}finally{
  await browser.close();
}
