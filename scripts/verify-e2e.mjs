import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { startServer } from '../server/index.mjs';
import { launchAuthorityBrowser } from '../server/ruffle-authority.mjs';

await mkdir('local/screenshots',{recursive:true});
await mkdir('evidence',{recursive:true});
let app, browser;
const contexts=[];const pages=[];const browserErrors=[];const checks=[];
const record=(name,detail)=>{checks.push({name,status:'passed',detail});console.log('PASS',name);};
let outcome='failed';
try{
  app=await startServer({port:0,maxRooms:3});
  browser=await launchAuthorityBrowser();
  const health=await (await fetch(`${app.url}/health`)).json();
  assert.equal(health.ok,true);assert.equal(health.originalGamesVerified,false);assert.equal(health.probePresent,true);
  record('honest capability reporting',health);
  for(let i=0;i<2;i++){
    const context=await browser.newContext({viewport:{width:1280,height:960}});contexts.push(context);
    const page=await context.newPage();pages.push(page);
    page.on('pageerror',error=>browserErrors.push({page:i,message:error.message}));
    await page.goto(app.url);
    await page.waitForFunction(()=>!document.getElementById('create').disabled);
    await page.locator('#name').fill(i===0?'验证玩家 A':'验证玩家 B');
  }
  const [a,b]=pages;
  await a.locator('#create').click();
  await a.waitForFunction(()=>window.lab?.ready&&window.lab.slot===0,null,{timeout:60000});
  await a.waitForFunction(()=>window.lab.appliedTick===0);
  const zero=await a.evaluate(()=>({hello:window.lab.hello,state:window.lab.readRendered(),display:window.lab.readDisplay()}));
  assert.equal(zero.hello.role,'client');assert.equal(zero.state.tick,0);assert.equal(zero.display.tick,0);
  assert.deepEqual(zero.state.players.map(p=>({id:p.id,x:p.x,y:p.y,aimX:p.aimX,aimY:p.aimY})),[
    {id:0,x:160,y:180,aimX:.25,aimY:.5},{id:1,x:480,y:180,aimX:.75,aimY:.5}]);
  record('waiting viewer applies the complete tick-zero initial state',zero);
  const code=await a.locator('#room-code').textContent();
  await b.locator('#code').fill(code);await b.locator('#join').click();
  await b.waitForFunction(()=>window.lab?.ready&&window.lab.slot===1,null,{timeout:60000});
  await a.waitForFunction(()=>window.lab.room.status==='running'&&window.lab.appliedTick>=2);
  await b.waitForFunction(()=>window.lab.appliedTick>=2);
  record('server AS3 authority and two distinct client renderers',{room:code,roles:await Promise.all(pages.map(p=>p.evaluate(()=>window.lab.hello)))});
  const initial=await a.evaluate(()=>window.lab.latestState);
  await a.keyboard.down('d');await b.keyboard.down('w');
  await a.waitForFunction(s=>window.lab.latestState.players[0].x>s.players[0].x+12&&window.lab.latestState.players[1].y<s.players[1].y-12,initial,{timeout:7000});
  await a.keyboard.up('d');await b.keyboard.up('w');
  record('simultaneous inputs control separate seats',await a.evaluate(()=>window.lab.latestState));
  for(const [page,x,y] of [[a,.2,.3],[b,.8,.7]]){
    const rect=await page.evaluate(()=>window.lab.contentRect());
    await page.mouse.move(rect.x+rect.width*x,rect.y+rect.height*y);
  }
  await a.waitForFunction(()=>{
    const [p,q]=window.lab.latestState.players;
    return Math.abs(p.aimX-.2)<.02&&Math.abs(p.aimY-.3)<.02&&Math.abs(q.aimX-.8)<.02&&Math.abs(q.aimY-.7)<.02;
  },null,{timeout:7000});
  await a.mouse.down();
  await b.waitForFunction(()=>window.lab.latestState.players[0].buttons===2&&window.lab.latestState.players[1].buttons===0);
  await a.mouse.up();
  await a.waitForFunction(()=>window.lab.latestState.players[0].buttons===0);
  record('independent mouse coordinates and button ownership',await a.evaluate(()=>window.lab.latestState.players));
  const localGuard=await a.evaluate(()=>{
    const before=window.lab.readRendered();
    const returned=window.lab.tryLocalStep({moveX:1,moveY:0,buttons:0},{moveX:0,moveY:0,buttons:0});
    return {before,returned,after:window.lab.readRendered()};
  });
  assert.equal(localGuard.returned,null);assert.deepEqual(localGuard.before,localGuard.after);
  record('viewer cannot advance authoritative simulation',{returned:localGuard.returned,tick:localGuard.before.tick});
  const histories=await Promise.all(pages.map(p=>p.evaluate(()=>window.lab.stateHistory)));
  const common=histories[0].filter(s=>histories[1].some(t=>t.tick===s.tick));
  assert.ok(common.length>5);
  for(const state of common)assert.deepEqual(state,histories[1].find(t=>t.tick===state.tick));
  for(const p of pages){
    const observation=await p.evaluate(()=>({rendered:window.lab.readRendered(),display:window.lab.readDisplay(),history:window.lab.stateHistory}));
    assert.deepEqual(observation.rendered,observation.history.find(s=>s.tick===observation.rendered.tick));
    assert.equal(observation.display.tick,observation.rendered.tick);
    for(let i=0;i<2;i++){
      const model=observation.rendered.players[i],view=observation.display.players[i];
      assert.equal(view.id,i);assert.equal(view.x,model.x);assert.equal(view.y,model.y);
      assert.ok(Math.abs(view.pointerX-model.aimX*640)<.1);
      assert.ok(Math.abs(view.pointerY-model.aimY*360)<.1);
      assert.ok(Number.isFinite(view.pointerScaleX)&&view.pointerScaleX>0);
      assert.ok(Number.isFinite(view.pointerScaleY)&&view.pointerScaleY>0);
    }
  }
  record('both clients, AS3 models and actual DisplayObject positions match',{comparedTicks:common.length});
  await a.keyboard.down('Space');await b.waitForFunction(()=>window.lab.latestState.players[0].buttons===1);
  await a.evaluate(()=>window.dispatchEvent(new Event('blur')));
  await b.waitForFunction(()=>window.lab.latestState.players[0].buttons===0);
  await a.keyboard.up('Space');record('focus loss releases input',{});
  const previousTick=await b.evaluate(()=>window.lab.latestState.tick);
  await a.reload();
  await a.waitForFunction(c=>window.lab?.ready&&window.lab.slot===0&&window.lab.room.code===c,code,{timeout:60000});
  await b.waitForFunction(t=>window.lab.room.status==='running'&&window.lab.latestState.tick>t,previousTick,{timeout:15000});
  record('refresh reconnect preserves seat and authoritative room',{room:code,previousTick});
  await a.screenshot({path:'local/screenshots/lab-player-a.png',fullPage:true});
  await b.screenshot({path:'local/screenshots/lab-player-b.png',fullPage:true});
  await a.locator('#leave').click();await a.waitForFunction(()=>window.lab.slot===null);
  await b.locator('#leave').click();await b.waitForFunction(()=>window.lab.slot===null);
  await a.locator('#match').click();await b.locator('#match').click();
  await a.waitForFunction(()=>window.lab?.ready&&window.lab.room.status==='running'&&window.lab.appliedTick>=2,null,{timeout:60000});
  await b.waitForFunction(()=>window.lab?.ready&&window.lab.room.status==='running'&&window.lab.appliedTick>=2,null,{timeout:60000});
  const pairing=await Promise.all(pages.map(p=>p.evaluate(()=>({room:window.lab.room.code,slot:window.lab.slot}))));
  assert.equal(pairing[0].room,pairing[1].room);assert.notEqual(pairing[0].slot,pairing[1].slot);
  record('quick match pairs two independent browsers',pairing);
  assert.deepEqual(browserErrors,[]);
  const clientErrors=await Promise.all(pages.map(p=>p.evaluate(()=>window.lab.errors)));
  assert.deepEqual(clientErrors,[[],[]]);record('no browser or application errors through the final matched room',{browserErrors,clientErrors});
  outcome='passed';
}catch(error){checks.push({name:'failure',status:'failed',message:error.stack});console.error(error);for(let i=0;i<pages.length;i++)await pages[i].screenshot({path:`local/screenshots/failure-${i}.png`,fullPage:true}).catch(()=>{});process.exitCode=1;}
finally{
  const result={schema:1,status:outcome,recordedAt:new Date().toISOString(),scope:'Authored AS3 probe only; original games have NOT been run',
    environment:{node:process.version,browser:browser?.version()??null,network:'local loopback; not an Internet latency result'},checks,metrics:app?.getMetrics()??null,browserErrors};
  await writeFile('evidence/e2e-results.json',JSON.stringify(result,null,2)+'\n');
  for(const context of contexts)await context.close();
  await browser?.close();await app?.close();
}
