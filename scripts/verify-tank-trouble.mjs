import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {copyFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {chromium} from 'playwright';
import {startGameLobby} from './start-game-lobby.mjs';
import {ARENA_SOCKET,MODES,MOVE_SPEED,TICK_RATE,TURN_SPEED,arenaFor,cellCenter,wrapAngle} from '../public/tank-arena/rules.mjs';
import {advanceArena,createArena,neutralInput,normalizeInput} from '../server/tank-arena-sim.mjs';
import {laserPath} from '../public/tank-arena/laser-path.mjs';
import {cellOf,pathsFrom} from '../tests/tank-arena-paths.mjs';

const root=await mkdtemp(path.join(os.tmpdir(),'arena-e2e-'));
const password='local-test';
const faults=[];
const assets=new Set();
const arenaRoute=/\/tank-arena\/index\.html/;
const laserModule='/tank-arena/laser-path.mjs';
let app,browser;

async function until(read,message,ms=15_000){
  const deadline=Date.now()+ms;
  while(Date.now()<deadline){
    const result=await read();
    if(result)return result;
    await sleep(35);
  }
  throw Error(message);
}

async function makePlayer(){
  const page=await browser.newPage({viewport:{width:1060,height:800}});
  await page.addInitScript(()=>{
    window.__explosionSounds=0;
    const original=AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start=function(...args){
      if(this.buffer?.duration>.6)window.__explosionSounds++;
      return original.apply(this,args);
    };
  });
  const player={page,seat:null,world:null,reflected:false};
  page.on('pageerror',error=>faults.push(error.message));
  page.on('request',request=>{
    const target=new URL(request.url());
    if(target.pathname.startsWith('/tank-arena/'))assets.add(target.pathname);
  });
  page.on('websocket',socket=>{
    const endpoint=new URL(socket.url());
    if(endpoint.pathname!=='/tank-match')return;
    player.matchOrigin=endpoint.origin;
    socket.on('framereceived',({payload})=>{
      const frame=JSON.parse(payload.toString());
      if(frame.type==='seat')player.seat=frame.seat;
      if(frame.type!=='arena')return;
      player.world=frame;
      if(frame.shots.some(shot=>shot.ricochets>0))player.reflected=true;
    });
  });
  return player;
}

async function ready(player,round){
  return until(()=>player.world?.round===round&&player.world.phase==='playing'&&
    player.world.connected.every(Boolean)&&player.world,'Arena did not start round '+round);
}

async function start(name,count=2){
  const players=await Promise.all(Array.from({length:count},makePlayer));
  const [first,...guests]=players;
  const invite=new URL('/',app.url);invite.searchParams.set('room',name);
  await first.page.goto(app.url);
  await first.page.locator('[data-action="save-profile"]').click();
  await first.page.locator('[data-action="focus-create"][data-game="tank-trouble"]').click();
  await first.page.locator('#create-name').fill(name);
  await first.page.locator('#create-password').fill(password);
  await first.page.locator('[data-action="create-room"]').click();
  await first.page.locator('.room-layout').waitFor();
  assert.equal(await first.page.locator('[data-action="select-game"]').count(),0);
  for(const guest of guests){
    await guest.page.goto(invite.href);
    await guest.page.locator('[data-action="save-profile"]').click();
    await guest.page.locator('#join-password').fill(password);
    await guest.page.locator('[data-action="confirm-join"]').click();
    await guest.page.locator('.room-layout').waitFor();
  }
  await first.page.locator('[data-action="level"][data-game="tank-trouble"]:not(.disabled)').click();
  await Promise.all(guests.map(player=>player.page.locator('[data-action="confirm-level"]').click()));
  await Promise.all(players.map(player=>player.page.waitForURL(arenaRoute)));
  await Promise.all(players.map(player=>ready(player,1)));
  assert.deepEqual(players.map(player=>player.seat),Array.from({length:count},(_,index)=>index));
  assert(players.every(player=>player.matchOrigin===new URL(app.url).origin.replace(/^http/,'ws')));
  assert.equal(new Set(players.map(player=>new URL(player.page.url()).searchParams.get('match'))).size,1);
  return {players,first,second:guests[0],invite};
}

async function hold(player,key,ms){
  await player.page.bringToFront();
  await player.page.keyboard.down(key);
  await sleep(ms);
  await player.page.keyboard.up(key);
  await sleep(100);
}

function self(player){return player.world.tanks[player.seat];}

async function steer(player,target){
  for(let attempt=0;attempt<8;attempt++){
    const tank=self(player);
    if(Math.hypot(tank.x-target.x,tank.y-target.y)<9)return;
    const heading=Math.atan2(target.y-tank.y,target.x-tank.x);
    const error=wrapAngle(heading-tank.hull);
    if(Math.abs(error)<.075)return;
    await hold(player,error<0?'a':'d',Math.max(24,Math.abs(error)/TURN_SPEED*1000));
  }
  throw Error('Could not steer to the next corridor near '+JSON.stringify(target));
}

async function travel(player,point,{stopBefore=false}={}){
  const initial=cellOf(self(player));
  const route=pathsFrom(player.world.mapSeed,initial).get(cellOf(point).join(','));
  assert(route,'Expected an accessible maze cell');
  const waypoints=route.map(([col,row])=>cellCenter(col,row));
  if(stopBefore)waypoints.pop();
  else waypoints.push(point);
  for(const target of waypoints){
    for(let attempt=0;attempt<5;attempt++){
      await steer(player,target);
      const tank=self(player),distance=Math.hypot(tank.x-target.x,tank.y-target.y);
      if(distance<10)break;
      assert.equal(player.world.phase,'playing');
      const speed=MOVE_SPEED*(tank.boostRemaining>0?1.3:1);
      await hold(player,'w',Math.max(24,(distance-3)/speed*1000));
    }
    assert(Math.hypot(self(player).x-target.x,self(player).y-target.y)<13,
      'Tank did not reach '+JSON.stringify(target));
  }
}

async function shootOpponent(first,second,score){
  const target=first.world.tanks[second.seat];
  const blastId=first.world.blasts.at(-1)?.id??0;
  await steer(first,target);
  if(self(first).weapon==='mine'){
    await hold(first,'Space',55);
    await hold(first,'w',455);
    await steer(first,target);
  }
  const weapon=self(first).weapon;
  await hold(first,'Space',weapon==='burst'?700:145);
  await until(()=>[first,second].every(player=>player.world.scores[first.seat]===score&&
    player.world.blasts.some(blast=>blast.seat===second.seat&&blast.id>blastId)),
  'Both players did not see the confirmed one-hit kill with '+(weapon??'standard fire'),3500);
}

async function verifySidebars(player){
  const view=await player.page.evaluate(()=>{
    const cards=[...document.querySelectorAll('.player-card')];
    const arena=document.querySelector('#field').getBoundingClientRect();
    const left=document.querySelector('#roster-left').getBoundingClientRect();
    const right=document.querySelector('#roster-right').getBoundingClientRect();
    return {positioned:left.right<=arena.left&&right.left>=arena.right,
      names:cards.map(card=>card.querySelector('h2').textContent),
      fields:cards.map(card=>[...card.querySelectorAll('dt')].map(node=>node.textContent))};
  });
  assert(view.positioned);
  assert.deepEqual(view.names,player.world.names);
  for(const fields of view.fields)assert.deepEqual(fields,['连接','战况','护甲','武器']);
  const cards=player.page.locator('.player-card');
  assert.equal(await cards.nth(player.seat).locator('.connection').textContent(),'在线');
  assert.equal(await player.page.locator('.player-card .you:visible').count(),1);
  assert(await cards.nth(player.seat).locator('.you').isVisible());
}

async function vote(players,mode){
  await Promise.all(players.map(player=>player.page.locator('[data-mode="'+mode+'"]').click()));
}

async function waitMode(players,mode){
  await until(()=>players.every(player=>player.world?.mode===mode&&player.world.phase==='playing'),
    'Mode did not start: '+mode);
}

async function verifyRoundFinish(first,second){
  const players=[first,second];
  await vote(players,'elimination');
  await waitMode(players,'elimination');
  await travel(first,first.world.tanks[second.seat],{stopBefore:true});
  await shootOpponent(first,second,1);
  await until(()=>players.every(player=>player.world.phase==='settling'),
    'The last hit did not enter the explosion animation phase',2000);
  const visible=await Promise.all(players.map(player=>player.page.locator('#overlay').isVisible()));
  assert.deepEqual(visible,[false,false],'The score overlay covered the last explosion');
  await sleep(1050);
  const heading=first.world.tanks[0].hull;
  await hold(first,'a',260);
  await until(()=>Math.abs(wrapAngle(first.world.tanks[0].hull-heading))>.2,
    'The surviving tank could not turn after the explosion',900);
  assert.equal(first.world.phase,'settling');
  assert.equal(first.world.remaining,null);
  assert.equal(await first.page.locator('#clock').isVisible(),false);
  assert.deepEqual(await first.page.locator('#match-stats tr').first().locator('td').allTextContents(),['1','1','0','0']);
  await Promise.all(players.map(player=>player.page.locator('#overlay-note').filter({hasText:'小局结束'}).waitFor()));
  for(const player of players)assert.match(await player.page.locator('#overlay-title').textContent(),/得分/);
}

async function verifyJoinInProgress(first,second,invite){
  const guest=await makePlayer();
  const roomName=invite.searchParams.get('room');
  const matchId=new URL(first.page.url()).searchParams.get('match');
  const mapSeed=first.world.mapSeed;
  const score=first.world.scores[0];
  const token=page=>page.evaluate(name=>sessionStorage.getItem('fb-lobby-token:'+name),roomName);
  const preflight=url=>url.origin===invite.origin&&url.pathname==='/tank-arena/index.html'&&!url.search;
  let entryAttempts=0,admissions=0,activeRequests=0;
  const lobbySockets=[],launches=[];
  guest.page.on('request',request=>{
    if(new URL(request.url()).pathname==='/api/rooms/join'&&request.method()==='POST')admissions++;
  });
  guest.page.on('websocket',socket=>{
    const url=new URL(socket.url());
    if(url.pathname!=='/lobby'||url.searchParams.get('presence')==='chat')return;
    lobbySockets.push(socket);
    socket.on('framesent',({payload})=>{
      if(JSON.parse(payload.toString()).type==='join-active')activeRequests++;
    });
    socket.on('framereceived',({payload})=>{
      const packet=JSON.parse(payload.toString());
      if(packet.type==='session-start')launches.push(packet.session.launchUrl);
    });
  });
  await guest.page.route(preflight,async route=>{
    entryAttempts++;
    if(entryAttempts===2)return route.fulfill({status:200,contentType:'text/html',body:'<p>Unmarked page</p>'});
    return route.fulfill({status:502,body:'Temporary upstream failure'});
  });
  await guest.page.goto(app.url);
  await guest.page.locator('[data-action="save-profile"]').click();
  const openRoom=guest.page.locator('.catalog-game[data-game="tank-trouble"] .catalog-room.live')
    .filter({has:guest.page.getByText(roomName,{exact:true})});
  await openRoom.getByRole('button',{name:'加入对局'}).click();
  await guest.page.locator('#join-password').fill(password);
  await guest.page.locator('[data-action="confirm-join"]').click();
  const retry=guest.page.locator('[data-action="retry-match-entry"]');
  await retry.waitFor();
  const savedRoomToken=await token(guest.page);
  assert(savedRoomToken);
  assert.equal(guest.page.url(),invite.href);
  assert.equal(entryAttempts,3,'A 200 response without an arena marker must not permit navigation');
  assert.equal(admissions,1);
  assert.equal(activeRequests,1);
  assert.equal(launches.length,1);
  assert.equal(lobbySockets.length,1);
  assert(!lobbySockets[0].isClosed(),'The lobby socket must survive failed arena preflight');
  await guest.page.unroute(preflight);
  await retry.click();
  await guest.page.waitForURL(arenaRoute);
  assert.equal(admissions,1,'Manual entry retry must not reserve another room seat');
  assert.equal(activeRequests,2);
  assert.equal(launches.length,2);
  assert(launches[0]===launches[1],'Manual entry retry must reuse the authorized match seat');
  assert.equal(lobbySockets.length,1);
  await until(()=>[first,second,guest].every(player=>player.world?.connected.filter(Boolean).length===3),
    'The third player did not reach the same live match');
  assert.equal(new URL(guest.page.url()).searchParams.get('match'),matchId);
  assert.equal(guest.world.mapSeed,mapSeed);
  assert.equal(guest.world.scores[0],score,'Joining reset a player’s existing score');
  assert.equal(guest.seat,2);

  assert.equal(await token(guest.page),savedRoomToken);
  await guest.page.reload();
  await guest.page.locator('.player-card .you:visible').waitFor();
  assert.equal(guest.seat,2);
  assert.equal(await token(guest.page),savedRoomToken);
  await guest.page.locator('#return').click();
  await guest.page.waitForURL(invite.href);
  await guest.page.locator('.room-layout').waitFor();
  assert.equal(await token(guest.page),savedRoomToken);
  await until(()=>first.world.connected.filter(Boolean).length===2,'Returning did not leave the battlefield');
  await guest.page.locator('[data-action="join-active"]').click();
  await guest.page.waitForURL(arenaRoute);
  await until(()=>first.world.connected.filter(Boolean).length===3,'The returning player could not rejoin');
  assert.equal(new URL(guest.page.url()).searchParams.get('match'),matchId);
  assert.equal(guest.world.scores[0],score);
  await guest.page.locator('#return').click();
  await guest.page.waitForURL(invite.href);
  await guest.page.locator('.room-layout').waitFor();
  await guest.page.locator('.room-banner [data-action="leave"]').click();
  console.log('A password-authenticated third player retried a failed entry on the same seat, refreshed, returned and rejoined without resetting the score');
}

async function verifyControlledArena(template){
  const {page}=await makePlayer();
  let arena=createArena(template.mapSeed,2,'deathmatch');
  const [gunner,opponent]=arena.tanks;
  const neutral=neutralInput();
  const step=1/TICK_RATE;
  let input=neutral,tick=0,pressedAt=null,firstShotAt=null,timer;
  let presentation={mode:arena.mode,phase:'playing',remaining:null};
  // Keep walls, opponents and random pickups out of this isolated timing check.
  arena.walls=[];
  arena.supplyWait=Infinity;
  Object.assign(gunner,{x:240,y:200,hull:0});
  Object.assign(opponent,{x:700,y:400});
  arena.pickups.push({id:1,kind:'burst',x:gunner.x,y:gunner.y});
  advanceArena(arena,[neutral,neutral],step);
  const loadedAmmo=gunner.gatlingAmmo;
  assert.equal(gunner.weapon,'burst');
  assert(loadedAmmo>3,'The pickup did not load the Gatling magazine');

  await page.routeWebSocket(url=>url.pathname===ARENA_SOCKET,route=>{
    route.onMessage(payload=>{
      const packet=JSON.parse(payload.toString());
      if(packet.type!=='input')return;
      const next=normalizeInput(packet);
      if(!next)return;
      if(next.fire&&!input.fire)pressedAt=tick;
      input=next;
    });
    const publish=()=>route.send(JSON.stringify({...template,...presentation,tick,
      tanks:arena.tanks,shots:arena.shots,pickups:arena.pickups,blasts:arena.blasts,effects:arena.effects}));
    route.send(JSON.stringify({type:'seat',seat:0}));
    publish();
    clearInterval(timer);
    timer=setInterval(()=>{
      tick++;
      if(presentation.phase==='playing')advanceArena(arena,[input,neutral],step);
      if(arena.nextShot>0)firstShotAt??=tick;
      if(tick%2===0)publish();
    },1000*step);
  });

  const target=new URL('/tank-arena/index.html?room=gatling-test&match=fixture',app.url);
  const endpoint=new URL(app.lobbyWsUrl);endpoint.pathname=ARENA_SOCKET;
  target.hash=new URLSearchParams({seat:'a'.repeat(48),ws:endpoint}).toString();
  try{
    await page.goto(target.href);
    await page.locator('.player-card .you:visible').waitFor();
    await page.bringToFront();
    await page.keyboard.down('Space');
    await until(()=>arena.nextShot>=3,'Holding Space did not sustain Gatling fire',4000);
    assert(firstShotAt-pressedAt>=5,'Gatling skipped spin-up');
    assert(arena.shots.some(shot=>shot.kind==='burst'));
    assert(arena.shots.every(shot=>shot.kind==='burst'));
    await page.keyboard.up('Space');
    await until(()=>!input.fire,'Space release never reached the simulation',2000);
    const {nextShot:releasedShots}=arena;
    const releasedAmmo=gunner.gatlingAmmo;
    const releasedAt=tick;
    await until(()=>tick-releasedAt>=TICK_RATE/2,'The Gatling fixture stopped stepping',2000);
    assert.equal(arena.nextShot,releasedShots,'Gatling kept firing after Space was released');
    assert.equal(gunner.gatlingAmmo,releasedAmmo);
    assert(releasedAmmo>0&&releasedAmmo<loadedAmmo,'Gatling did not preserve partial ammunition');
    await page.keyboard.down('Space');
    await until(()=>arena.nextShot>releasedShots,'The remaining magazine could not resume firing',3000);
    await page.keyboard.up('Space');
    await until(()=>!input.fire,'The second Space release never reached the simulation',2000);
    assert(gunner.gatlingAmmo<releasedAmmo);
    console.log('Real Chromium Space input spun up the Gatling, stopped on release and resumed with the remaining magazine');

    const matchPage=page.url();
    presentation={...presentation,phase:'result',phaseRemaining:2,winner:0,
      winnerName:template.names[0],scores:[MODES.deathmatch.scoreToWin,0],reason:'kills'};
    await page.getByText('对局结算',{exact:true}).waitFor();
    assert.equal(await page.getByRole('button',{name:/再来一局|重赛/}).isVisible(),false);
    assert.match(await page.locator('#overlay-title').textContent(),/获胜/);
    assert.match(await page.locator('#overlay-detail').textContent(),/下一局自动开始/);

    await page.emulateMedia({reducedMotion:'reduce'});
    const nextSeed=template.mapSeed===42?43:42;
    arena=createArena(nextSeed,2,'deathmatch');
    presentation={mode:arena.mode,remaining:null,phase:'countdown',phaseRemaining:1.5,
      series:template.series+1,mapSeed:nextSeed,round:1,scores:[0,0]};
    await page.getByText('准备开战',{exact:true}).waitFor();
    assert.equal(page.url(),matchPage);
    console.log('Final result offered no rematch vote and accepted the next series without leaving the arena');

    arena.supplyWait=Infinity;
    arena.tanks[0].weapon='beam';
    presentation.phase='playing';
    const points=laserPath(arena.tanks[0],arena.tanks[0].hull,arena.walls);
    assert(points.length>=3);
    const [start,hit,returned]=points;
    assert(Math.abs(start.y-returned.y)<.01&&Math.sign(hit.x-start.x)!==Math.sign(returned.x-hit.x));
    await page.locator('.player-card').first().getByText('激光束',{exact:true}).waitFor();
    const span=Math.hypot(returned.x-hit.x,returned.y-hit.y);
    const x=hit.x+(returned.x-hit.x)*Math.min(span*.57,36)/span;
    const y=hit.y+Math.sign(returned.x-hit.x)*7;
    const returnArrowLit=() => page.locator('#field').evaluate((canvas,{x,y,width,height})=>{
      const ctx=canvas.getContext('2d');
      const sx=canvas.width/width,sy=canvas.height/height;
      const data=ctx.getImageData(Math.round((x-6)*sx),Math.round((y-4)*sy),Math.ceil(12*sx),Math.ceil(8*sy)).data;
      for(let index=0;index<data.length;index+=4)if(data[index]>220&&data[index+1]>205&&data[index+2]>210)return true;
      return false;
    },{x,y,width:arena.width,height:arena.height});
    await until(returnArrowLit,'A straight-on laser did not draw the return marker beside the preview',5000);
    await page.keyboard.down('Space');
    try{
      const fired=await until(()=>arena.shots.find(shot=>shot.kind==='beam'&&shot.ricochets>0),
        'The fired laser did not propagate past its first reflection',3000);
      assert.deepEqual(fired.path,points);
      assert(fired.front>Math.hypot(hit.x-start.x,hit.y-start.y));
    }finally{await page.keyboard.up('Space');}
    console.log('A head-on laser drew a distinct return marker and the fired wave followed its reflection');
  }finally{
    clearInterval(timer);
    await page.close();
  }
}

try{
  const manifestsDir=path.join(root,'manifests');
  await mkdir(manifestsDir);
  await copyFile(new URL('../config/games/tank-trouble.json',import.meta.url),path.join(manifestsDir,'tank-trouble.json'));
  app=await startGameLobby({root,shanyiRoot:root,viewerPort:18992,lobbyPort:18993,
    publicViewerPort:18992,publicLobbyPort:18993,roomsFile:path.join(root,'rooms.json'),manifestsDir,bvn33ServiceUrl:null});
  assert.deepEqual(app.catalog.map(({id,runtime})=>({id,runtime})),[{id:'tank-trouble',runtime:'tank-arena'}]);
  const absent=await Promise.all(['/tank-trouble-classic/index.html','/lockstep-preview/index.html','/tank-trouble/art/tank-0.png']
    .map(route=>fetch(new URL(route,app.url))));
  assert(absent.every(response=>response.status===404));
  const laserResponse=await fetch(new URL(laserModule,app.url));
  assert.equal(laserResponse.status,200,'The public laser module was not served');
  assert.match(laserResponse.headers.get('content-type')??'',/^text\/javascript\b/);
  await laserResponse.arrayBuffer();
  browser=await chromium.launch();
  const {first,second,invite}=await start('迷宫验收 A');
  const gatlingTemplate=first.world;
  assert.equal(new URL(first.page.url()).hash,'');
  assert.equal(new URL(second.page.url()).hash,'');
  assert([
    '/tank-arena/arena-view.mjs','/tank-arena/arena-audio.mjs','/tank-arena/arena.css','/tank-arena/arena.mjs',
    '/tank-arena/index.html','/tank-arena/rules.mjs',laserModule,
  ].every(asset=>assets.has(asset)),'The arena did not load every required browser module');
  await Promise.all([first,second].map(verifySidebars));
  await first.page.locator('#match-reactions summary').click();
  await first.page.locator('#match-reactions').getByRole('button',{name:'加油'}).click();
  await second.page.locator('#match-reactions [role="status"]').filter({hasText:'P1 💪'}).waitFor();
  if(process.env.ARENA_QA_IMAGE)await first.page.screenshot({path:process.env.ARENA_QA_IMAGE});
  const hull=self(first).hull;
  await first.page.locator('#field').click({position:{x:35,y:40}});
  await sleep(250);
  assert.equal(self(first).hull,hull);
  assert.equal(first.world.shots.length,0);
  console.log('Both clients rendered matching sidebars, and mouse interaction did not rotate or fire');
  const initialMaze=first.world.mapSeed;
  assert.equal(initialMaze,second.world.mapSeed);
  const initial=second.world.tanks[0];
  await hold(first,'a',350);
  const turned=second.world.tanks[0];
  assert.equal(turned.x,initial.x);assert.equal(turned.y,initial.y);
  assert(wrapAngle(turned.hull-initial.hull)<-.45);
  await hold(first,'w',220);
  const driven=second.world.tanks[0];
  assert(driven.x>turned.x+9&&driven.y<turned.y-9);
  await hold(first,'s',205);
  assert(second.world.tanks[0].x<driven.x-8&&second.world.tanks[0].y>driven.y+8);
  const other=first.world.tanks[1];
  await hold(second,'d',330);
  assert(wrapAngle(first.world.tanks[1].hull-other.hull)>.45);
  assert.equal(first.world.tanks[1].x,other.x);
  const savedSeat=second.seat;
  second.seat=null;second.world=null;
  await second.page.reload();
  await second.page.locator('.player-card .you:visible').waitFor();
  await ready(second,1);
  assert.equal(second.seat,savedSeat);
  assert.equal(second.world.mapSeed,initialMaze);
  await second.page.locator('#field').click({position:{x:35,y:40}});
  console.log('Both browsers share the same generated maze, steering has no strafe, and refresh kept the same maze and seat');

  await verifyRoundFinish(first,second);
  console.log('Both browsers left the final explosion unobstructed before displaying the round result');
  await vote([first],'deathmatch');
  await until(()=>second.world.modeVotes[0]==='deathmatch','First vote was not shared');
  assert.equal(second.world.mode,'elimination');
  await vote([second],'deathmatch');
  await waitMode([first,second],'deathmatch');
  assert.equal(first.world.remaining,null);
  const audioBaseline=await Promise.all([first,second].map(player=>player.page.evaluate(()=>window.__explosionSounds)));
  first.reflected=false;second.reflected=false;
  const selfBlast=first.world.tanks[0];
  await steer(first,{x:2,y:self(first).y});
  await hold(first,'Space',130);
  await until(()=>first.reflected&&second.reflected,'Wall reflection was not visible to both players');
  await until(()=>[first,second].every(player=>player.world.tanks[0].armor===0),
    'The reflected shot did not destroy its owner');
  assert.deepEqual(first.world.scores,[0,0]);
  await first.page.locator('#respawn-hint').waitFor({state:'visible'});
  await until(()=>first.world.tanks[0].armor===1&&!first.world.tanks[0].spawnGrace,'Respawn protection did not end');
  assert.notDeepEqual(cellOf(first.world.tanks[0]),cellOf(selfBlast));
  await travel(first,first.world.tanks[1],{stopBefore:true});
  await shootOpponent(first,second,1);
  await Promise.all([first,second].map((player,index)=>
    player.page.waitForFunction(count=>window.__explosionSounds>=count+2,audioBaseline[index])));
  console.log('Both browsers saw ricochet self-kill, no self-kill point, enemy one-hit kill, sound, and respawn');
  await verifyJoinInProgress(first,second,invite);

  const parallel=await start('迷宫验收 B',6);
  assert.equal(app.lobby.activeSessions.length,2);
  assert.notEqual(new URL(first.page.url()).searchParams.get('match'),new URL(parallel.first.page.url()).searchParams.get('match'));
  const six=parallel.first.world;
  assert(six.width>first.world.width&&six.height>first.world.height);
  assert(arenaFor(six.mapSeed,6).walls.length>arenaFor(first.world.mapSeed).walls.length);
  assert(parallel.players.every(player=>player.world.playerCount===6&&player.world.mapSeed===six.mapSeed));
  await verifySidebars(parallel.players.at(-1));
  const browserCanvas=await parallel.first.page.locator('#field').evaluate(canvas=>({width:canvas.width,height:canvas.height}));
  assert.equal(browserCanvas.width/browserCanvas.height,six.width/six.height);
  await vote(parallel.players.slice(0,3),'elimination');
  await until(()=>parallel.players[5].world.modeVotes.filter(Boolean).length===3,'Six-player votes did not sync');
  assert.equal(parallel.players[5].world.mode,'beacon');
  await vote([parallel.players[5]],'elimination');
  await waitMode(parallel.players,'elimination');
  assert.notEqual(parallel.first.world.mapSeed,six.mapSeed);
  assert.equal(first.world.mode,'deathmatch');
  if(process.env.ARENA_SIX_QA_IMAGE)await parallel.first.page.screenshot({path:process.env.ARENA_SIX_QA_IMAGE});
  await vote(parallel.players.slice(0,4),'relay');
  await waitMode(parallel.players,'relay');
  const location=parallel.first.world.beacon;
  assert.equal(parallel.first.world.remaining,null);
  await parallel.first.page.getByText(/秒后转移/).waitFor();
  await until(()=>parallel.players.every(player=>player.world.beacon.x!==location.x||player.world.beacon.y!==location.y),
    'The relay objective did not move on every client',18_000);
  assert(parallel.players.every(player=>player.world.beacon.x===parallel.first.world.beacon.x&&
    player.world.beacon.y===parallel.first.world.beacon.y));
  const catalog=await browser.newPage();
  await catalog.goto(app.url);
  await catalog.locator('[data-action="save-profile"]').click();
  const gameRooms=catalog.locator('.catalog-game[data-game="tank-trouble"]');
  const fullRoom=gameRooms.locator('.catalog-room.live').filter({has:catalog.getByText('迷宫验收 B',{exact:true})});
  assert(await fullRoom.getByRole('button',{name:'对局已满'}).isDisabled());

  await first.page.locator('#return').click();
  await first.page.waitForURL(invite.href);
  await first.page.locator('.room-layout').waitFor();
  await second.page.getByText('在线玩家不足',{exact:true}).waitFor();
  await second.page.locator('#return').click();
  await second.page.locator('.room-layout').waitFor();
  assert.deepEqual(app.lobby.activeSessions.map(session=>session.room),['迷宫验收 B']);
  for(const player of [first,second])await player.page.locator('[data-action="leave"]').first().click();
  await catalog.locator('[data-action="refresh-plaza"]').click();
  await gameRooms.locator('.catalog-room').filter({hasText:'迷宫验收 A'}).getByText(/已保存/).waitFor();
  await verifyControlledArena(gatlingTemplate);
  assert.deepEqual(faults,[]);
  console.log('Six-seat layout, strict majority, moving relay, independent running rooms, and game-first saved room grouping passed');
}finally{
  await browser?.close();
  await app?.close();
  await rm(root,{recursive:true,force:true});
}
