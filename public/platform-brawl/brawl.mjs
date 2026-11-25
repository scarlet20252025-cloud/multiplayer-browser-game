const version=new URL(import.meta.url).search;
const [{HEIGHT,WIDTH,PLATFORMS,BRAWL_SOCKET,SCORE_TO_WIN}, {createBrawlView,PALETTES}]=await Promise.all([
  import('./rules.mjs'+version),
  import('./view.mjs'+version),
]);
if(window.brawlBootVersion!==version)throw Error('Game boot superseded');

const $=id=>document.getElementById(id);
const display=createBrawlView($('field'),{width:WIDTH,height:HEIGHT,platforms:PLATFORMS});
const url=new URL(location.href);
const room=url.searchParams.get('room')??'';
const match=url.searchParams.get('match')??'';
const fragment=new URLSearchParams(url.hash.slice(1));
const savedKey='cloud-brawl-seat:'+room;
const validToken=value=>/^[a-zA-Z0-9_-]{16,150}$/.test(value??'');
const baseEndpoint=new URL(BRAWL_SOCKET,url);
baseEndpoint.protocol=url.protocol==='https:'?'wss:':'ws:';
const legacyPorts={'8787':'8788','10011':'10012'};
const legacy=legacyPorts[baseEndpoint.port];

function matchEndpoint(value){
  try{
    const endpoint=new URL(value||baseEndpoint.href);
    if(endpoint.protocol===baseEndpoint.protocol&&endpoint.hostname===baseEndpoint.hostname&&
       [baseEndpoint.port,legacy].includes(endpoint.port)&&endpoint.pathname===BRAWL_SOCKET&&
       !endpoint.username&&!endpoint.password&&!endpoint.hash)return endpoint;
  }catch{}
  return null;
}

let access;
try{
  const saved=JSON.parse(sessionStorage.getItem(savedKey)||'null');
  if(saved?.match===match&&validToken(saved.token)&&matchEndpoint(saved.ws))access=saved;
}catch{}
if(validToken(fragment.get('seat'))){
  const endpoint=matchEndpoint(fragment.get('ws'));
  if(endpoint){
    access={match,token:fragment.get('seat'),ws:endpoint.href};
    try{
      sessionStorage.setItem(savedKey,JSON.stringify(access));
      url.hash='';
      history.replaceState(null,'',url);
    }catch{}
  }
}
const returnUrl=new URL('/',url);
if(room){
  returnUrl.searchParams.set('room',room);
  $('room-label').hidden=false;
  $('room-label').textContent=room;
}
$('return').href=returnUrl;
$('score-target').textContent='先得 '+SCORE_TO_WIN+' 分';
$('match').hidden=false;
$('boot-failure').hidden=true;

const keyboardActions=new Map(Object.entries({
  KeyA:'left',ArrowLeft:'left',KeyD:'right',ArrowRight:'right',
  KeyW:'jump',ArrowUp:'jump',Space:'jump',KeyJ:'light',KeyK:'heavy',
}));
const keys=new Set();
let touchKeys=new Set(),touchControls;
let ws,ready=false,stopped=false,seat=null,lastPacketAt=0;
let sequence=0,lastEventId=0,frameState,previousPlayers=new Map(),transportTimer;
let generation=0,retryTimer,attemptTimer,stallTimer,mayResume=true,preferred,alternate;
const RETRIES=[450,850,1400];
const HANDSHAKE_TIME=4000;
const STALL_TIME=8500;
const MATCH_CLOSE_TEXT={PLAYERS_LEFT:'在线玩家不足',SESSION_ENDED:'对局已结束'};

function changed(element,text){
  if(element.textContent!==text)element.textContent=text;
}
function overlay(kicker,title,detail='',retry=false){
  $('overlay').hidden=false;
  changed($('overlay-kicker'),kicker);
  changed($('overlay-title'),title);
  changed($('overlay-detail'),detail);
  $('retry').hidden=!retry;
}
function latency(text,connected=false){
  changed($('latency'),text);
  $('latency').classList.toggle('connected',connected);
}
function measure(ms){
  latency(ms+' ms',true);
  clearTimeout(transportTimer);
  transportTimer=setTimeout(()=>{if(ready)latency('已连接',true);},4200);
}
function transmit(message){
  if(ws?.readyState!==WebSocket.OPEN||ws.bufferedAmount>16_384)return;
  ws.send(JSON.stringify(message));
}
function input(){
  if(!ready)return;
  const pressed=new Set([...keys,...touchKeys].map(code=>keyboardActions.get(code)));
  transmit({type:'input',seq:++sequence,left:pressed.has('left'),right:pressed.has('right'),
    jump:pressed.has('jump'),light:pressed.has('light'),heavy:pressed.has('heavy')});
}
function clearInput(){
  keys.clear();
  touchKeys=new Set();
  touchControls?.clear();
  input();
}
window.addEventListener('keydown',event=>{
  if(!keyboardActions.has(event.code)||event.ctrlKey||event.metaKey||event.altKey)return;
  if(event.target instanceof Element&&event.target.closest('button,a,input,select,textarea,[contenteditable]'))return;
  if(document.fullscreenElement&&event.defaultPrevented)return;
  event.preventDefault();
  if(!ready||frameState?.phase!=='playing'||frameState.paused||keys.has(event.code))return;
  keys.add(event.code);
  input();
});
window.addEventListener('keyup',event=>{
  if(keys.delete(event.code)){
    event.preventDefault();
    input();
  }
});
window.addEventListener('blur',clearInput);
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearInput();});
$('field').addEventListener('pointerdown',()=>{
  if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
});
if(matchMedia('(any-pointer: coarse)').matches){
  void import('./touch.mjs'+version)
    .catch(()=>import('./touch.mjs'+version+'&retry=1'))
    .then(({mountTouchControls})=>{
      touchControls=mountTouchControls(document.querySelector('.play'),'brawl',next=>{
        touchKeys=ready&&frameState?.phase==='playing'&&!frameState.paused?next:new Set();
        input();
      });
    }).catch(()=>{});
}
if(document.fullscreenEnabled){
  $('fullscreen').hidden=false;
  $('fullscreen').onclick=()=>{
    if(document.fullscreenElement)void document.exitFullscreen().catch(()=>{});
    else void document.querySelector('.play').requestFullscreen().catch(()=>{});
  };
  document.addEventListener('fullscreenchange',()=>{
    changed($('fullscreen'),document.fullscreenElement?'退出全屏':'全屏');
    clearInput();
    $('fullscreen').blur();
  });
}
const sounds={
  hit:[320,125,.12],
  ringout:[560,145,.34],
  respawn:[405,700,.16],
};
let audioContext,soundOn=true;
const AudioPlayer=window.AudioContext||window.webkitAudioContext;
try{soundOn=localStorage.getItem('cloud-brawl-sound')!=='off';}catch{}
function soundLabel(){
  $('audio-toggle').hidden=!AudioPlayer;
  $('audio-toggle').setAttribute('aria-pressed',String(soundOn));
  changed($('audio-toggle'),soundOn?'音效开':'音效关');
}
function unlockSound(){
  if(!AudioPlayer||!soundOn)return;
  audioContext??=new AudioPlayer();
  if(audioContext.state==='suspended')void audioContext.resume().catch(()=>{});
}
function playSound(kind){
  if(!soundOn||audioContext?.state!=='running'||!Object.hasOwn(sounds,kind))return;
  const [start,end,time]=sounds[kind];
  const now=audioContext.currentTime;
  const voice=audioContext.createOscillator();
  const amp=audioContext.createGain();
  voice.type=kind==='hit'?'triangle':'sine';
  voice.frequency.setValueAtTime(start,now);
  voice.frequency.exponentialRampToValueAtTime(end,now+time);
  amp.gain.setValueAtTime(.045,now);
  amp.gain.exponentialRampToValueAtTime(.001,now+time);
  voice.connect(amp).connect(audioContext.destination);
  voice.start();
  voice.stop(now+time);
}
$('audio-toggle').onclick=()=>{
  soundOn=!soundOn;
  try{localStorage.setItem('cloud-brawl-sound',soundOn?'on':'off');}catch{}
  soundLabel();
  unlockSound();
  $('audio-toggle').blur();
};
window.addEventListener('pointerdown',unlockSound,{passive:true,once:true});
window.addEventListener('keydown',unlockSound,{once:true});
soundLabel();

const roster=new Map();
function scoreRow(player){
  const root=document.createElement('li');
  root.className='player';
  root.style.setProperty('--seat-color',PALETTES[player.seat].base);
  const badge=document.createElement('span');
  badge.className='player-badge';
  badge.textContent='P'+(player.seat+1);
  const note=document.createElement('span');
  note.className='player-note';
  const name=document.createElement('strong');
  name.className='player-name';
  const info=document.createElement('small');
  info.className='player-activity';
  note.append(name,info);
  const score=document.createElement('b');
  score.className='player-score';
  root.append(badge,note,score);
  const entry={root,name,info,score};
  roster.set(player.seat,entry);
  const before=[...roster.entries()].find(([index])=>index>player.seat)?.[1].root;
  $('players').insertBefore(root,before??null);
  return entry;
}
function updateScores(players){
  for(const player of players){
    const row=roster.get(player.seat)??scoreRow(player);
    row.root.classList.toggle('you',player.seat===seat);
    row.root.classList.toggle('offline',!player.connected);
    changed(row.name,(player.name||'P'+(player.seat+1))+(player.seat===seat?'（你）':''));
    changed(row.info,player.connected?(player.active?(Math.round(player.damage)+'% 伤害'):'等待回场'):'离线');
    changed(row.score,String(player.score));
  }
}
function updatePhase(state){
  if(state.phase==='waiting')overlay('等待玩家','等待玩家进入','至少 2 位玩家在线后开局。');
  else if(state.paused)overlay('对局暂停','等待对手重连','比分和位置已保留。');
  else if(state.phase==='result'){
    const winner=state.players.find(player=>player.seat===state.winner);
    const title=!winner?'双方平局':winner.seat===seat?'你赢了':winner.name+' 获胜';
    const remaining=Math.max(0,Math.ceil(state.remaining??0));
    overlay('对局结算',title,remaining?remaining+' 秒后重新开局':'即将重新开局');
  }else $('overlay').hidden=true;
}
function updateState(next){
  const old=frameState;
  previousPlayers=new Map((old?.round===next.round?old.players:[]).map(player=>[player.seat,player]));
  const lastAt=lastPacketAt;
  const now=performance.now();
  lastPacketAt=now;
  frameState={...next,interpMs:Math.min(90,Math.max(24,now-lastAt))};
  if(old?.phase==='playing'&&(next.phase!=='playing'||(!old.paused&&next.paused)))clearInput();
  updateScores(next.players);
  changed($('round'),'第 '+next.round+' 局');
  updatePhase(next);
  for(const event of next.events){
    if(!Number.isInteger(event?.id)||event.id<=lastEventId)continue;
    lastEventId=event.id;
    if(old&&Number.isFinite(event.x)&&Number.isFinite(event.y)){
      display.event(event,now);
      playSound(event.type);
    }
  }
}
function isSnapshot(message,assigned){
  if(message.type!=='brawl'||!['waiting','playing','result'].includes(message.phase)||!Number.isInteger(message.tick)||
      !Array.isArray(message.players)||!Array.isArray(message.events))return false;
  return message.players.some(player=>player?.seat===assigned&&player.connected)&&
    message.players.every(player=>Number.isInteger(player?.seat)&&player.seat>=0&&player.seat<PALETTES.length&&
      Number.isFinite(player.x)&&Number.isFinite(player.y));
}

function disconnect(){
  generation++;
  clearTimeout(attemptTimer);
  clearTimeout(stallTimer);
  clearTimeout(transportTimer);
  clearInput();
  ready=false;
  const old=ws;
  ws=null;
  try{old?.close();}catch{}
}
function terminalNotice(message){
  stopped=true;
  mayResume=false;
  clearTimeout(retryTimer);
  disconnect();
  latency('未连接');
  overlay('对局连接',message,'可返回房间重新开局。');
}
function retry(index){
  if(index>=RETRIES.length){
    latency('未连接');
    overlay('对局连接','暂时无法连接对局','可以使用原席位重试。',true);
    return;
  }
  latency('重连中');
  overlay('对局连接','正在重新连接','正在使用原席位重试。');
  retryTimer=setTimeout(()=>connect(index+1),RETRIES[index]);
}
function connect(index=0){
  if(stopped||!mayResume)return;
  const current=generation;
  const target=index%2===1&&alternate?alternate:preferred;
  const endpoint=new URL(target);
  endpoint.search='';
  endpoint.searchParams.set('token',access.token);
  latency(index||seat!==null?'重连中':'连接中');
  let live;
  try{live=new WebSocket(endpoint);}catch{retry(index);return;}
  ws=live;
  let assigned=null;
  const active=()=>current===generation&&!stopped&&live===ws;
  function failed(){
    if(!active())return;
    const hadState=ready;
    disconnect();
    retry(hadState?0:index);
  }
  function checkStall(){
    if(!active())return;
    const left=STALL_TIME-(performance.now()-lastPacketAt);
    if(left<=0)failed();
    else stallTimer=setTimeout(checkStall,left);
  }
  attemptTimer=setTimeout(failed,HANDSHAKE_TIME);
  live.onmessage=({data})=>{
    if(!active()||typeof data!=='string')return;
    let message;
    try{message=JSON.parse(data);}catch{return;}
    if(!message)return;
    if(message.type==='seat'&&Number.isInteger(message.seat)&&message.seat>=0&&message.seat<PALETTES.length){
      assigned=message.seat;
    }else if(assigned!==null&&isSnapshot(message,assigned)){
      if(!ready){
        clearTimeout(attemptTimer);
        ready=true;
        seat=assigned;
        sequence=0;
        if(target===alternate)[preferred,alternate]=[alternate,preferred];
        lastPacketAt=performance.now();
        latency('已连接',true);
        stallTimer=setTimeout(checkStall,STALL_TIME);
      }
      updateState(message);
    }else if(message.type==='latency'&&ready&&Number.isFinite(message.ms)&&message.ms>=0&&message.ms<15000){
      measure(Math.round(message.ms));
    }else if(message.type==='ended'){
      terminalNotice(MATCH_CLOSE_TEXT[message.code]??'对局已结束');
    }
  };
  live.onerror=failed;
  live.onclose=event=>{
    if(!active())return;
    if(event.code===4001){terminalNotice('该席位已在另一个标签页打开');return;}
    if(event.code===1008){terminalNotice('原席位已失效');return;}
    failed();
  };
}

$('retry').onclick=()=>{
  clearTimeout(retryTimer);
  disconnect();
  overlay('对局连接','正在重新连接');
  connect();
};
$('return').addEventListener('click',()=>{
  transmit({type:'leave'});
  stopped=true;
  try{sessionStorage.removeItem(savedKey);}catch{}
});
const heartbeat=setInterval(input,130);
window.addEventListener('pagehide',()=>{
  stopped=true;
  clearInterval(heartbeat);
  clearTimeout(retryTimer);
  disconnect();
});
window.addEventListener('pageshow',event=>{if(event.persisted)location.reload();});
if(access){
  preferred=matchEndpoint(access.ws);
  if(legacy){
    alternate=new URL(baseEndpoint);
    if(preferred.port===baseEndpoint.port)alternate.port=legacy;
  }
  connect();
}else terminalNotice('请先从大厅进入对局');

function frame(now){
  const positions=frameState?.players.map(player=>{
    const old=previousPlayers.get(player.seat);
    if(!old?.active||!player.active||Math.hypot(old.x-player.x,old.y-player.y)>120)return player;
    const t=Math.max(0,Math.min(1,(now-lastPacketAt)/frameState.interpMs));
    return {...player,x:old.x+(player.x-old.x)*t,y:old.y+(player.y-old.y)*t};
  })??[];
  display.paint(positions,seat,now);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
