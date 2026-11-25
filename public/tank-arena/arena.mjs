import {ARENA_SOCKET, COLORS, MAX_PLAYERS, MIN_PLAYERS, MODES, SUPPLIES} from './rules.mjs';
import {createArenaAudio} from './arena-audio.mjs';
import {createArenaView} from './arena-view.mjs';

if(window.arenaEntryActive?.()===false)throw Error('Arena startup was superseded');
const $=id=>document.getElementById(id);
const draw=createArenaView($('field'));
const audio=createArenaAudio();
const url=new URL(location.href);
const room=url.searchParams.get('room')??'';
const match=url.searchParams.get('match')??'';
const fragment=new URLSearchParams(url.hash.slice(1));
const accessKey='maze-tank-match:'+room;
const validToken=token=>typeof token==='string'&&/^[a-f0-9]{48}$/.test(token);
function arenaEndpoint(value){
  try{
    const endpoint=new URL(value);
    if(['ws:','wss:'].includes(endpoint.protocol)&&endpoint.pathname===ARENA_SOCKET&&
       !endpoint.username&&!endpoint.password&&!endpoint.hash)return endpoint;
  }catch{}
  return null;
}
let access;
const suppliedToken=fragment.get('seat');
const suppliedEndpoint=arenaEndpoint(fragment.get('ws'));
try{
  const saved=JSON.parse(sessionStorage.getItem(accessKey)||'null');
  if(saved?.match===match)access=saved;
}catch{}
if(validToken(suppliedToken)&&suppliedEndpoint){
  access={match,token:suppliedToken,ws:suppliedEndpoint.href};
  try{
    sessionStorage.setItem(accessKey,JSON.stringify(access));
    url.hash='';
    history.replaceState(null,'',url);
  }catch{}
}
const returnUrl=new URL('/',location.origin);
if(room){
  returnUrl.searchParams.set('room',room);
  $('room-label').textContent='房间 '+room;
  $('room-label').hidden=false;
}
$('return').href=returnUrl.href;
$('match-return').href=returnUrl.href;

const CONNECT_WINDOW=13_000;
const WELCOME_TIMEOUT=4000;
const SNAPSHOT_TIMEOUT=8000;
const RETRY_DELAYS=[500,900,1400];
const snapshotLists=['names','tanks','connected','dropped','scores','modeVotes','blasts','shots','pickups','mines'];
let socket,seat=null,state=null,previous=null,received=0,seq=0,terminal=false,connectionReady=false;
let loadingTimer,retryTimer,latencyTimer,stallTimer,primaryEndpoint,alternateEndpoint,preferredEndpoint;
let sound=true,blasts=[],effects=[],roster=[];
try{sound=localStorage.getItem('maze-tank-sound')!=='off';}catch{}
const keys=new Set();
let touchKeys=new Set(),touchControls;
const controlled=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowLeft','ArrowDown','ArrowRight','Space']);
const resultPhases=new Set(['between','result']);
const drivePhases=new Set(['playing','settling']);
const finishText={PLAYERS_LEFT:'在线玩家不足',SESSION_ENDED:'对局已结束'};
const outcomeText={armor:'存活到最后',beacon:'占领信标',kills:'达到 10 次击毁',relay:'累积占领 20 秒','self-destruction':'最后一辆对手自毁，本小局不计分'};

function changed(node,value){if(node.textContent!==value)node.textContent=value;}

function setLatency(label,measured=false){
  clearTimeout(latencyTimer);
  const indicator=$('latency');
  changed(indicator,label);
  indicator.classList.toggle('measured',measured);
}

function refreshLatency(label,measured=false){
  setLatency(label,measured);
  latencyTimer=setTimeout(()=>setLatency('暂不可测'),3500);
}

function overlay(note,title,detail='',actions=''){
  $('overlay').hidden=false;
  changed($('overlay-note'),note);
  changed($('overlay-title'),title);
  changed($('overlay-detail'),detail);
  $('overlay-detail').hidden=!detail;
  $('overlay-actions').hidden=!actions;
  $('match-retry').hidden=actions!=='retry';
}

function renderSound(){
  $('sound').disabled=!audio.supported;
  $('sound').setAttribute('aria-pressed',String(sound));
  changed($('sound'),sound?'音效开':'音效关');
  audio.enable(sound);
}
renderSound();
window.addEventListener('pointerdown',audio.unlock,{capture:true});
$('sound').addEventListener('click',()=>{
  sound=!sound;
  renderSound();
  audio.unlock();
  try{localStorage.setItem('maze-tank-sound',sound?'on':'off');}catch{}
});

const modeOptions=Object.fromEntries(Object.entries(MODES).map(([id,details])=>{
  const button=document.createElement('button');
  button.type='button';
  button.className='mode-button';
  button.dataset.mode=id;
  button.disabled=true;
  button.setAttribute('aria-pressed','false');
  button.innerHTML='<span><strong class="mode-name"></strong><span class="vote-count"></span></span><span class="mode-desc"></span>';
  button.querySelector('.mode-name').textContent=details.label;
  button.querySelector('.mode-desc').textContent=details.description;
  button.addEventListener('click',()=>transmit({type:'vote-mode',mode:state?.modeVotes[seat]===id?null:id}));
  $('mode-options').append(button);
  return [id,{button,count:button.querySelector('.vote-count')}];
}));

for(const supply of Object.values(SUPPLIES)){
  const item=document.createElement('div');
  const title=document.createElement('dt'),description=document.createElement('dd');
  title.textContent=supply.label;
  title.style.color=supply.color;
  description.textContent=supply.description;
  item.append(title,description);
  $('supply-list').append(item);
}

function prepareRoster(count){
  if(roster.length===count)return;
  for(const id of ['roster-left','roster-right','scores','match-stats'])$(id).replaceChildren();
  roster=Array.from({length:count},(_,index)=>{
    const card=$('player-card').content.firstElementChild.cloneNode(true);
    const tag='P'+(index+1);
    card.style.setProperty('--seat-color',COLORS[index]);
    card.querySelector('.seat-label').textContent=tag;
    $(index<Math.ceil(count/2)?'roster-left':'roster-right').append(card);
    const score=document.createElement('li');
    const label=document.createElement('span'),value=document.createElement('strong');
    label.textContent=tag;
    score.style.setProperty('--seat-color',COLORS[index]);
    score.append(label,value);
    $('scores').append(score);
    const row=document.createElement('tr'),statName=document.createElement('th');
    statName.scope='row';
    statName.textContent=tag;
    row.style.setProperty('--seat-color',COLORS[index]);
    row.append(statName);
    const columns=['score','kills','deaths','wins'].map(field=>{
      const cell=document.createElement('td');
      cell.textContent='0';
      row.append(cell);
      return {field,cell};
    });
    $('match-stats').append(row);
    return {name:card.querySelector('h2'),you:card.querySelector('.you'),
      connection:card.querySelector('.connection'),condition:card.querySelector('.condition'),
      armor:card.querySelector('.armor'),supply:card.querySelector('.supply'),score,value,statName,columns};
  });
}
prepareRoster(MIN_PLAYERS);

function setConnection(index,label,online=false){
  const node=roster[index]?.connection;
  if(!node)return;
  changed(node,label);
  node.classList.toggle('online',online);
}

function playEvents(world,old){
  const play=(kind,x,volume)=>audio.play(kind,volume,(x/world.width-.5)*1.45);
  const knownEffects=new Set((old.effects??[]).map(effect=>effect.id));
  for(const effect of world.effects??[]){
    if(knownEffects.has(effect.id))continue;
    effects.push({...effect,time:received});
    if(effect.kind==='mine')play('mine-blast',effect.x,.95);
    if(effect.kind==='cluster')play('fragment',effect.x,.93);
  }
  const knownBlasts=new Set(old.blasts.map(blast=>blast.id));
  for(const blast of world.blasts){
    if(knownBlasts.has(blast.id))continue;
    blasts.push({...blast,time:received});
    play('explosion',blast.x,.98);
  }
  for(const [index,tank] of world.tanks.entries()){
    const before=old.tanks[index];
    if(before&&world.connected[index]&&old.connected[index]){
      if(tank.armor&&before.shield&&!tank.shield)play('shield',tank.x,.78);
      if(tank.armor&&!before.armor)play('respawn',tank.x,.40);
      if(tank.armor&&tank.pulseCharge>0&&!(before.pulseCharge>0))
        play('pulse-charge',tank.x,index===seat ? .61 : .39);
      if(index===seat&&tank.weapon==='burst'){
        if(!before.gatlingSpin&&tank.gatlingSpin>0)play('spin-up',tank.x,.47);
        if(before.gatlingSpin===1&&tank.gatlingSpin<1)play('spin-down',tank.x,.4);
      }
    }
  }
  const pickups=new Set(world.pickups.map(pickup=>pickup.id));
  for(const pickup of old.pickups)if(!pickups.has(pickup.id))play('pickup',pickup.x,.47);
  const oldShots=new Map(old.shots.map(shot=>[shot.id,shot]));
  const shots=new Set();
  let bounces=0;
  for(const shot of world.shots){
    if(shot.kind==='mineShard'||shot.kind==='fragment')continue;
    const before=oldShots.get(shot.id);
    if(shot.kind==='pulse'){
      if(!before)play(shot.path?.length>=2?'pulse':'pulse-shell',shot.x,shot.owner===seat ? 1 : .73);
      continue;
    }
    const volley=shot.owner+':'+shot.kind;
    if(!before&&!shots.has(volley))play(shot.kind,shot.x,shot.owner===seat ? .91 : .57);
    if(!before)shots.add(volley);
    if(shot.ricochets>(before?.ricochets??0)&&bounces++<3){
      const missile=shot.kind==='guide'||shot.kind==='seeker';
      const impactX=shot.kind==='beam'?shot.path?.[shot.ricochets]?.x??shot.x:shot.x;
      play(missile?'rocket-bounce':'bounce',impactX,missile ? .70 : .49);
    }
    if(before&&shot.owner===seat&&shot.kind==='seeker'&&before.target==null&&shot.target!=null)
      play('lock',shot.x,.42);
  }
  const mines=new Set(old.mines.map(mine=>mine.id));
  for(const mine of world.mines)if(!mines.has(mine.id))play('mine',mine.x,.49);
}

function renderModes(world,online){
  const threshold=Math.floor(online/2)+1;
  changed($('vote-threshold'),online<MIN_PLAYERS?'等待玩家':threshold+' 票通过');
  for(const [id,{button,count}] of Object.entries(modeOptions)){
    changed(count,String(world.modeVotes.filter(vote=>vote===id).length)+' 票');
    button.classList.toggle('current',world.mode===id);
    button.setAttribute('aria-current',world.mode===id?'true':'false');
    button.setAttribute('aria-pressed',String(world.modeVotes[seat]===id));
    button.disabled=seat===null||!world.connected[seat]||world.phase==='waiting'||world.phase==='settling'||world.paused||
      id===world.mode||Boolean(world.nextMode);
  }
  changed($('vote-note'),world.nextMode?'即将开始 '+MODES[world.nextMode].label:'在线玩家过半后开启新赛局，比分归零。');
}

function update(next){
  const sameRound=state?.round===next.round&&state?.series===next.series&&state?.mapSeed===next.mapSeed;
  if(state?.width!==next.width||state?.height!==next.height)
    $('field').closest('.battle-center').style.setProperty('--board-ratio',String(next.width/next.height));
  previous=sameRound?state:null;
  state=next;
  received=performance.now();
  if(previous)playEvents(next,previous);
  else{blasts=[];effects=[];}
  prepareRoster(next.playerCount);
  const online=next.connected.filter(Boolean).length;
  for(const [index,tank] of next.tanks.entries()){
    const card=roster[index];
    changed(card.name,next.names[index]);
    card.name.title=next.names[index];
    card.you.hidden=index!==seat;
    changed(card.value,String(next.scores[index]));
    card.score.title=next.names[index]+' · '+next.scores[index]+' 分';
    const playerLabel='P'+(index+1)+' · '+next.names[index];
    changed(card.statName,playerLabel);
    card.statName.title=playerLabel;
    for(const {field,cell} of card.columns)changed(cell,String(next.stats?.[index]?.[field]??0));
    const connected=next.connected[index];
    setConnection(index,connected?'在线':next.dropped[index]?'已离场':next.phase==='waiting'?'等待连接':'等待重连',connected);
    const active=tank.armor>0&&!next.dropped[index];
    const condition=next.queued?.[index]?'下轮参战':
      tank.respawnRemaining>0?Math.ceil(tank.respawnRemaining)+' 秒复活':'已击毁';
    changed(card.condition,next.dropped[index]?'离场':!connected?'待命':active?'在场':condition);
    card.condition.classList.toggle('inactive',connected&&!active);
    changed(card.armor,tank.shield?'可挡 1 次':'无');
    card.armor.classList.toggle('active',tank.shield);
    const ammo=tank.weapon==='burst'?tank.gatlingAmmo:tank.weapon==='double'?tank.doubleAmmo:null;
    const weapon=SUPPLIES[tank.weapon]?.label??(active?'标准炮':'—');
    const pulseStatus=active&&(tank.pulseFiring?'发射中':tank.pulseCharge>0?'蓄力':'');
    const supply=pulseStatus?SUPPLIES.pulse.label+' · '+pulseStatus:ammo>0?weapon+' · '+ammo:weapon;
    changed(card.supply,supply);
  }
  const mode=MODES[next.mode];
  changed($('mode-title'),mode.label);
  const objective=next.mode==='deathmatch'?'先击毁对手 10 次':
    next.mode==='relay'?'先累计独占 20 秒':`第 ${next.round} 小局 · 先得 ${mode.scoreToWin} 分`;
  changed($('round'),objective);
  const mapName='随机迷宫 · '+(next.mapPlayerCount??next.playerCount)+' 人图';
  changed($('map-name'),mapName);
  const clock=$('clock');
  clock.hidden=next.beaconMoveRemaining==null;
  if(!clock.hidden)changed(clock,Math.ceil(next.beaconMoveRemaining)+' 秒后转移');

  renderModes(next,online);
  const hint=$('respawn-hint'),self=next.tanks[seat];
  $('guide-hint').hidden=!drivePhases.has(next.phase)||!self?.armor||!next.shots.some(shot=>shot.owner===seat&&shot.kind==='guide');
  hint.hidden=next.phase!=='playing'||next.paused||!self||self.armor>0;
  changed(hint,next.queued?.[seat]?'已加入 · 下一小局参战':
    self?.respawnRemaining>0?`已击毁 · ${Math.ceil(self.respawnRemaining)} 秒后复活`:'本小局已击毁 · 观战中');
  renderPhase(next,online);
}

function renderPhase(next,online){
  const showingBlast=next.phase==='settling'||(resultPhases.has(next.phase)&&blasts.length>0);
  if(showingBlast){$('overlay').hidden=true;return;}
  const name=next.winnerName??next.names[next.winner];
  const mode=MODES[next.mode];
  if(next.phase==='waiting')overlay(mode.label,'等待玩家入场',`${online} / ${next.playerCount} 位玩家已连接`);
  else if(next.paused)overlay('对局暂停','等待玩家重连',`至少需要 ${MIN_PLAYERS} 位在线玩家`);
  else if(next.phase==='switching')overlay('投票通过',MODES[next.nextMode].label,'即将生成新迷宫并重新计分');
  else if(next.phase==='countdown')overlay(mode.label,'准备开战');
  else if(next.phase==='between')overlay('小局结束',name?name+' 得分':'平局',outcomeText[next.reason]);
  else if(next.phase==='result'){
    const detail=[outcomeText[next.reason],'下一局自动开始'].filter(Boolean).join(' · ');
    overlay('对局结算',next.winner===seat?'你获胜了':name?name+' 获胜':'平局',detail);
  }
  else $('overlay').hidden=true;
}

function transmit(message){
  if((connectionReady||message.type==='leave')&&socket?.readyState===WebSocket.OPEN&&socket.bufferedAmount<32*1024)
    socket.send(JSON.stringify(message));
}

function input(){
  if(!connectionReady||terminal||!state||!drivePhases.has(state.phase)||state.paused||!state.connected[seat]||!state.tanks[seat]?.armor)return;
  const pressed=code=>keys.has(code)||touchKeys.has(code);
  const down=(...codes)=>Number(codes.some(pressed));
  transmit({type:'input',seq:++seq,
    drive:down('KeyW','ArrowUp')-down('KeyS','ArrowDown'),
    turn:down('KeyD','ArrowRight')-down('KeyA','ArrowLeft'),fire:pressed('Space')});
}

function clearControls(){keys.clear();if(!touchControls?.clear())input();}
if(matchMedia('(any-pointer: coarse)').matches){
  import('./touch.mjs').catch(()=>import('./touch.mjs?retry=1')).then(({mountTouchControls})=>{
    touchControls=mountTouchControls($('field').closest('.board'),'tank',pressed=>{
      touchKeys=pressed;
      if(pressed.size)audio.unlock();
      input();
    });
  }).catch(()=>{});
}
window.addEventListener('keydown',event=>{
  if(!connectionReady||!controlled.has(event.code)||event.ctrlKey||event.altKey||event.metaKey||terminal)return;
  if(event.code==='Space'&&event.target instanceof Element&&event.target.closest('button, a, summary'))return;
  audio.unlock();
  event.preventDefault();
  keys.add(event.code);
  input();
});
window.addEventListener('keyup',event=>{if(keys.delete(event.code))input();});
window.addEventListener('blur',clearControls);
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearControls();});
const transmitLoop=setInterval(input,45);

function finish(message){
  terminal=true;
  clearInterval(transmitLoop);
  clearTimeout(retryTimer);
  closeConnection();
  setLatency('未连接');
  $('respawn-hint').hidden=true;
  overlay('对局连接',message,'返回房间可以重新开局。','return');
  roster.forEach((_,index)=>setConnection(index,'已结束'));
  for(const {button} of Object.values(modeOptions))button.disabled=true;
}

function closeConnection(){
  clearTimeout(loadingTimer);
  clearTimeout(stallTimer);
  connectionReady=false;
  clearControls();
  const live=socket;
  socket=null;
  try{live?.close();}catch{}
}

function connectionUnavailable(){
  setLatency('未连接');
  if(seat!==null)setConnection(seat,'未连接');
  overlay('对局连接','暂时无法连接对局','可使用原席位重试，或返回房间重新进入。','retry');
}

function retryConnection(attempt,started){
  if(terminal)return;
  if(seat!==null)setConnection(seat,'重连中');
  $('respawn-hint').hidden=true;
  for(const {button} of Object.values(modeOptions))button.disabled=true;
  const left=CONNECT_WINDOW-(performance.now()-started);
  if(attempt>=RETRY_DELAYS.length||left<=0){connectionUnavailable();return;}
  setLatency('重连中');
  overlay('对局连接','正在重连…','正在使用原席位重试。');
  retryTimer=setTimeout(()=>connect(attempt+1,started),Math.min(left,RETRY_DELAYS[attempt]));
}

function connect(attempt=0,started=performance.now()){
  if(terminal)return;
  const left=CONNECT_WINDOW-(performance.now()-started);
  if(left<=0){connectionUnavailable();return;}
  const firstEndpoint=preferredEndpoint??primaryEndpoint;
  const backup=firstEndpoint===primaryEndpoint?alternateEndpoint:primaryEndpoint;
  const endpoint=attempt%2&&backup?backup:firstEndpoint;
  setLatency(attempt||seat!==null?'重连中':'连接中');
  let live;
  try{live=new WebSocket(endpoint);}catch{retryConnection(attempt,started);return;}
  socket=live;
  let assignedSeat=null;
  const current=()=>!terminal&&socket===live;
  function failed(){
    if(!current())return;
    const hadState=connectionReady;
    closeConnection();
    retryConnection(hadState?0:attempt,hadState?performance.now():started);
  }
  function checkSnapshots(){
    if(!current())return;
    const remaining=SNAPSHOT_TIMEOUT-(performance.now()-received);
    if(remaining<=0)failed();
    else stallTimer=setTimeout(checkSnapshots,remaining);
  }
  loadingTimer=setTimeout(failed,Math.min(WELCOME_TIMEOUT,left));
  live.onmessage=({data})=>{
    if(!current()||typeof data!=='string')return;
    let message;
    try{message=JSON.parse(data);}catch{return;}
    if(!message)return;
    if(message.type==='seat'&&Number.isInteger(message.seat)&&message.seat>=0&&message.seat<MAX_PLAYERS){
      assignedSeat=message.seat;
    }else if(message.type==='arena'&&assignedSeat!==null&&Object.hasOwn(MODES,message.mode)&&
             Number.isInteger(message.tick)&&snapshotLists.every(key=>Array.isArray(message[key]))&&
             message.tanks[assignedSeat]&&message.connected[assignedSeat]){
      if(!connectionReady){
        clearTimeout(loadingTimer);
        connectionReady=true;
        preferredEndpoint=endpoint;
        seat=assignedSeat;
        state=null;
        refreshLatency('测量中');
        stallTimer=setTimeout(checkSnapshots,SNAPSHOT_TIMEOUT);
      }
      update(message);
    }else if(message.type==='latency'&&connectionReady&&Number.isInteger(message.ms)&&message.ms>=0&&message.ms<=12_000)
      refreshLatency(message.ms+' ms',true);
    else if(message.type==='ended')finish(finishText[message.code]??'对局已结束');
  };
  live.onerror=failed;
  live.onclose=event=>{
    if(!current())return;
    if(event.code===4001)return finish('席位已在另一个标签页打开');
    if(event.code===1008&&event.reason==='seat-unavailable')return finish('原席位已失效');
    failed();
  };
}

$('match-retry').addEventListener('click',()=>{
  clearTimeout(retryTimer);
  closeConnection();
  overlay('对局连接','正在建立连接');
  connect();
});

// Return focus to play after keyboard activation or a pointer click on a HUD button.
for(const id of ['mode-options','sound']){
  $(id).addEventListener('click',event=>{
    if(event.detail>0&&document.activeElement instanceof HTMLButtonElement)document.activeElement.blur();
  });
}
for(const id of ['return','match-return'])$(id).addEventListener('click',()=>{
  transmit({type:'leave'});
  terminal=true;
  try{sessionStorage.removeItem(accessKey);}catch{}
});
window.addEventListener('pagehide',()=>{
  terminal=true;
  clearInterval(transmitLoop);
  clearTimeout(retryTimer);
  clearTimeout(latencyTimer);
  closeConnection();
});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});

if(validToken(access?.token)){
  primaryEndpoint=arenaEndpoint(access.ws);
  if(primaryEndpoint){
    primaryEndpoint.searchParams.set('token',access.token);
    const viewerSocket=new URL(ARENA_SOCKET,location.href);
    viewerSocket.protocol=location.protocol==='https:'?'wss:':'ws:';
    if(primaryEndpoint.hostname===viewerSocket.hostname&&primaryEndpoint.protocol===viewerSocket.protocol){
      const legacyPort={'8787':'8788','10011':'10012'}[viewerSocket.port];
      if(legacyPort&&primaryEndpoint.port===legacyPort)alternateEndpoint=viewerSocket;
      else if(viewerSocket.port==='10011'&&primaryEndpoint.port===viewerSocket.port){
        alternateEndpoint=viewerSocket;
        alternateEndpoint.port=legacyPort;
      }
      alternateEndpoint?.searchParams.set('token',access.token);
    }
    connect();
  }else finish('入场地址无效');
}else finish(validToken(suppliedToken)?'入场地址无效':'请先从大厅确认对局');

function frame(now){
  const animating=blasts.length>0;
  blasts=blasts.filter(blast=>now-blast.time<1380);
  effects=effects.filter(effect=>now-effect.time<900);
  draw(state,previous,Math.max(0,Math.min(1,(now-received)/38)),seat,blasts,now,effects);
  if(connectionReady&&!terminal&&animating&&!blasts.length&&resultPhases.has(state?.phase))
    renderPhase(state,state.connected.filter(Boolean).length);
  if(!terminal)requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
