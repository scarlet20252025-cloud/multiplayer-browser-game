import {DECOR,FLOAT_PIECES} from './decor.mjs';
const cfg=window.__LOBBY_CONFIG__;
if(typeof window.__LOBBY_BOOT_ATTEMPT__==='string'&&
    new URL(import.meta.url).searchParams.get('entry')!==window.__LOBBY_BOOT_ATTEMPT__)throw Error('大厅加载已重试');
// 允许本机回环与局域网地址（服务端可绑定 0.0.0.0 并对外公布内网 IP）
if(!cfg||!/^wss?:\/\/[A-Za-z0-9._-]+:\d+\/lobby$/.test(cfg.wsUrl))
  throw Error('大厅配置无效');
const apiBase=cfg.sameOriginLobby?'':cfg.wsUrl.replace(/^ws/,'http').replace(/\/lobby$/,'');
const viewerLobbyUrl=new URL('/lobby',location.href);
viewerLobbyUrl.protocol=location.protocol==='https:'?'wss:':'ws:';
const lobbySockets=cfg.primaryWsUrl===viewerLobbyUrl.href&&cfg.primaryWsUrl!==cfg.wsUrl
  ?[cfg.primaryWsUrl,cfg.wsUrl]:[cfg.wsUrl];
const {lanOrigin,wanOrigin}=cfg;
const onLan=location.origin===lanOrigin,onWan=location.origin===wanOrigin;
let lanReachability='checking',lanProbe=null,lanProbeStarted=false;
const app=document.getElementById('app');
const $=selector=>app.querySelector(selector);
const esc=value=>String(value??'').replace(/[&<>"']/g,ch=>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
// 容量来自 manifest 的 seats 字段，缺省 2；广场卡片与聊天在线数都用它。
const gameSeats=game=>Number.isInteger(game?.seats)&&game.seats>0?game.seats:2;
const roomCapacity=item=>Number.isInteger(item?.capacity)&&item.capacity>0?item.capacity:2;
const gameSeatRange=game=>game.minSeats<gameSeats(game)?`${game.minSeats}–${gameSeats(game)}`:gameSeats(game);
const seatLabel=seat=>Number.isInteger(seat)?'P'+(seat+1):'未分配';
// 面向玩家的称呼优先用游客昵称，没有昵称时退回席位标签。
const seatName=seat=>{
  const entry=Array.isArray(room?.seats)?room.seats.find(item=>item.seat===seat):null;
  return entry?.name||seatLabel(seat);
};
const seatCapacity=()=>{
  if(Number.isInteger(room?.capacity)&&room.capacity>0)return room.capacity;
  return Array.isArray(room?.connected)?room.connected.length:2;
};
const seatEntries=()=>{
  if(Array.isArray(room?.seats)&&room.seats.length)
    return room.seats.map(item=>({...item,label:item.label||seatLabel(item.seat)}));
  return Array.from({length:seatCapacity()},(_,index)=>({
    seat:index,label:seatLabel(index),occupied:Boolean(room?.connected?.[index]),
    connected:Boolean(room?.connected?.[index]),name:null}));
};
const readyToPlay=()=>room?.canStart??room?.bothConnected;
const typeName=type=>type==='speed'?'限时':type==='puzzle'?'解谜':'普通';
const levelName=id=>id===0?'教学关':'第 '+id+' 关';
const versusRuntimes=new Set(['browser-lockstep','bvn33-online','tank-arena','platform-brawl']);
function versusModeName(game,level){
  if(level?.type&&level.type!=='general')return level.type;
  if(game?.id==='bomb-it-7')return '大乱斗';
  return gameSeats(game)===2?'双人对战':'多人对战';
}
const tokenKey=name=>'fb-lobby-token:'+name;
const profileKey='fb-guest-profile';
const catalogKey='fb-lobby-catalog-v2';
const matchEntries=new Map([
  ['bvn33',{path:'/bvn33/',header:'X-BVN33-Entry',title:'死神 vs 火影'}],
  ['tank-trouble',{path:'/tank-arena/index.html',header:'X-Tank-Arena-Entry',title:'坦克动荡'}],
  ['platform-brawl',{path:'/platform-brawl/index.html',header:'X-Platform-Brawl-Entry',title:'云台乱斗'}],
]);
const params=new URLSearchParams(location.search);
const glortonGame={id:'glorton',title:'疯狂小人乱斗'};
const legacyGlortonRequest=params.get('glorton');
const explicitGlortonRoom=params.get('game')===glortonGame.id?params.get('room'):null;
const glortonRequest=legacyGlortonRequest??explicitGlortonRoom;
const glortonCodePattern=/^[A-HJ-NP-Z2-9]{6}$/;
const inviteRoom=glortonRequest===null?(params.get('room')??''):'';
const watchMessages=new Map([
  ['player-left','有玩家离开，观战已结束。'],
  ['room-closed','对局已结束或房间已关闭，已退出观战。'],
  ['disconnected','观战连接中断，已返回大厅。'],
  ['unavailable','当前对局已无法观战。'],
]);
const watchNotice=watchMessages.get(params.get('watchEnded'));
if(params.has('watchEnded')){
  const url=new URL(location.href);
  url.searchParams.delete('watchEnded');
  history.replaceState(null,'',url.pathname+url.search+url.hash);
}
const AVATARS=['🐟','🔥','💧','🐱','🐶','🦊','🐼','🐸','🦄','👾','🤖','🐯'];
const AVATAR_COLORS=['#2ecc71','#3498db','#e67e22','#9b59b6','#e74c3c','#f1c40f','#1abc9c','#34495e'];
const GAME_STYLE={
  forest:{emoji:'🔥',color:'#167249',cover:'forest'},
  light:{emoji:'☀️',color:'#a65b0a',cover:'light'},
  ice:{emoji:'❄️',color:'#15588f',cover:'ice'},
  crystal:{emoji:'💎',color:'#6e32ab',cover:'crystal'},
  shanyi:{emoji:'⭐',color:'#922461',cover:'shanyi'},
  'tank-trouble':{emoji:'🛡️',color:'#16686f',cover:'tank-trouble'},
  'platform-brawl':{emoji:'☁️',color:'#54359e',cover:'platform-brawl'},
  'bomb-it-7':{emoji:'💣',color:'#203f88',cover:'bomb-it-7'},
  'bleach-vs-naruto':{emoji:'⚔️',color:'#722f68',cover:'bvn33'},
  bvn33:{emoji:'⚔️',color:'#722f68',cover:'bvn33'},
  glorton:{emoji:'🎮',color:'#3f246a',cover:'glorton'},
};
const styleFor=id=>GAME_STYLE[id]??{emoji:'🎮',color:'#5d36a4'};
const art='/__lobby__/art/';
const availableCovers=Array.isArray(cfg.availableCovers)?new Set(cfg.availableCovers):null;
const icon=(name,cls='')=>`<svg class="icon ${cls}" aria-hidden="true" focusable="false"><use href="${art}sprite.svg#${name}"/></svg>`;
const coverImage=(id,cls='')=>{
  const {cover}=styleFor(id);
  return cover&&(!availableCovers||availableCovers.has(cover))
    ?`<img class="${cls}" src="${art}covers/${cover}.webp" alt="" loading="lazy" decoding="async">`:'';
};
const cachedCatalog=readCatalog();
let games=cachedCatalog.games,room=null,seat=null,ws=null,view='auth',
  createGameId=null,plazaRooms=cachedCatalog.rooms,joinTarget=null,
  gamesReadFailed=false,roomsReadFailed=false,roomsConfirmed=false,gamesRequest=null,roomsRequest=null,
  createForm={name:inviteRoom,password:''},joinForm={password:''},
  plazaQuery='',selectedGame=null,joinError='',focusJoin=false,busy=null,navigating=false,
  connectingRoom='',connectionTimer=null,reconnectTimer=null,toastTimer=null,lastError='',
  profile=readProfile(),profileDraft=profile?{...profile}:{name:randomGuestName(),avatar:'🐟',bg:'#2ecc71'},
  profileOpen=false,avatarPicker=false;
let matchEntry=null,matchNavigation=false;
let glortonMode=glortonRequest===null?null:legacyGlortonRequest?.toLowerCase()==='host'?'host':'join';
let glortonRoomQuery=glortonMode==='join'?glortonRoomReference(glortonRequest):'';
let glortonHealth=null,glortonProbe=null,focusGlorton=Boolean(glortonMode);
let glortonRoomName='',glortonPassword='',glortonError='',glortonBusy=false;

function toast(text){
  lastError=text;
  let node=document.getElementById('lobby-toast');
  if(!node){node=document.createElement('div');node.id='lobby-toast';node.className='toast';document.body.appendChild(node);}
  node.textContent=text;clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>node.remove(),4200);
}
function storeToken(name,token,seat){
  try{sessionStorage.setItem(tokenKey(name),JSON.stringify({token,seat}));}catch{}
}
function readToken(name){
  try{return JSON.parse(sessionStorage.getItem(tokenKey(name))||'null');}catch{return null;}
}
function clearToken(name){
  try{sessionStorage.removeItem(tokenKey(name));}catch{}
}
function randomGuestName(){return 'Guest'+(10+Math.floor(Math.random()*90));}
function readProfile(){
  try{
    const value=JSON.parse(localStorage.getItem(profileKey)||'null');
    if(value&&typeof value.name==='string'&&value.name.trim()&&
       typeof value.avatar==='string'&&AVATARS.includes(value.avatar)&&
       typeof value.bg==='string'&&AVATAR_COLORS.includes(value.bg))return value;
  }catch{}
  return null;
}
function readCatalog(){
  try{
    const cache=JSON.parse(sessionStorage.getItem(catalogKey)||'null');
    if(Array.isArray(cache?.games)&&Array.isArray(cache?.rooms))return cache;
  }catch{}
  return {games:[],rooms:[]};
}
function cacheCatalog(){
  try{sessionStorage.setItem(catalogKey,JSON.stringify({games,rooms:plazaRooms}));}catch{}
}
function saveProfile(value){
  try{localStorage.setItem(profileKey,JSON.stringify(value));}catch{}
  profile=value;
}
function ensureProfile(){
  if(!profile)saveProfile({name:randomGuestName(),avatar:'🐟',bg:'#2ecc71'});
}
function chatTime(value){
  const date=new Date(value);
  if(Number.isNaN(date.valueOf()))return '';
  return date.toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
}
const SEAT_COLORS=['#c35911','#1d70a4','#8054a1','#137e6b','#a93459','#746116'];
function seatColor(value){
  return Number.isInteger(value)&&value>=0?SEAT_COLORS[value%SEAT_COLORS.length]:'#7c8c85';
}
async function fetchJson(url,options={}){
  const headers=new Headers(options.headers);
  if(options.body&&!headers.has('content-type'))headers.set('content-type','application/json');
  const response=await fetch(url,{...options,headers});
  let body;
  try{body=await response.json();}catch{}
  if(!response.ok)throw Object.assign(Error(body?.message||body?.error||('连接暂时不可用（HTTP '+response.status+'）')), {code:body?.error});
  if(!body||typeof body!=='object'||Array.isArray(body))throw Error('大厅返回的数据不完整，请重试。');
  return body;
}

function topbar(){
  return `<header class="topbar"><div class="topbar-inner">
    <button class="brand" type="button" data-action="home">${icon('gamepad')}<span class="brand-text">肥鱼乐园</span></button>
    ${view==='auth'? `<nav class="top-nav" aria-label="大厅导航"><button type="button" class="current" data-action="home">${icon('home')}联机大厅</button><a href="#games">${icon('grid')}游戏列表</a><a href="#rooms">${icon('room')}房间列表</a></nav>` : ''}
    <div class="top-actions">
      ${profile
        ?`<button type="button" class="profile-chip" data-action="open-profile"><span class="avatar" style="--avatar-bg:${esc(profile.bg)}">${esc(profile.avatar)}</span><span class="profile-name">${esc(profile.name)}</span></button>`
        :joinTarget?'':`<button type="button" class="profile-chip guest" data-action="save-profile">${icon('user')}游客进入</button>`}
    </div>
  </div></header>`;
}
function profileModal(){
  if(!profileOpen)return '';
  const draft=profileDraft??{name:randomGuestName(),avatar:'🐟',bg:'#2ecc71'};
  return `<div class="modal-mask"><div class="welcome-modal" role="dialog" aria-modal="true" aria-label="游客登录">
    <div class="welcome-art"><div class="welcome-avatar" style="--avatar-bg:${esc(draft.bg)}">${esc(draft.avatar)}
      <button type="button" class="avatar-refresh" data-action="random-avatar" title="换一个">↻</button></div></div>
    <div class="welcome-body">
      <h2>${profile?'你的游客资料':'欢迎！'}</h2>
      <p>${profile?'随时修改昵称和造型，聊天时朋友会看到。':'这就是你。随便改改，或者直接开玩。'}</p>
      <label class="field-label" for="profile-name">昵称</label>
      <input id="profile-name" class="input" maxlength="16" autocomplete="off" value="${esc(draft.name)}" placeholder="Guest00">
      <div class="welcome-actions">
        <button type="button" class="welcome-quiet" data-action="toggle-avatars">👕 更多造型</button>
        <button type="button" class="welcome-quiet" data-action="random-avatar">🎲 随机造型</button>
      </div>
      ${avatarPicker?`<div class="avatar-picker">
        <div class="avatar-grid">${AVATARS.map(a=>`<button type="button" class="avatar-choice ${draft.avatar===a?'active':''}" data-action="pick-avatar" data-avatar="${a}">${a}</button>`).join('')}</div>
        <div class="color-grid">${AVATAR_COLORS.map(c=>`<button type="button" class="color-choice ${draft.bg===c?'active':''}" data-action="pick-avatar-bg" data-bg="${c}" style="--swatch:${c}" title="${c}"></button>`).join('')}</div>
      </div>`:''}
      <button type="button" class="welcome-play" data-action="save-profile">${profile?'保存并继续':'以游客身份游玩 →'}</button>
      ${profile?'<button type="button" class="welcome-link" data-action="close-profile">取消</button>':''}
      <div class="welcome-terms">使用条款 · 隐私 · 本机游客模式，无需邮箱</div>
    </div>
  </div></div>`;
}
function wallpaper(){
  const pieces=FLOAT_PIECES.map(([name,x,y,size,duration],index)=>
    `<img class="float-piece" src="${DECOR[name]}" alt="" decoding="async" style="--x:${x}%;--y:${y}%;--size:${size}px;--duration:${duration}s;--delay:-${index%5}s">`).join('');
  return `<div class="lobby-wall" aria-hidden="true"><div class="lobby-wall-art"></div><div class="float-layer">${pieces}</div></div>`;
}
function shell(inner){
  return `${wallpaper()}${topbar()}<main class="site-main">${inner}</main>
    <footer class="site-footer">肥鱼乐园 <span>·</span> ${onLan?'局域网大厅':onWan?'公网大厅':'联机大厅'}</footer>
    ${profileModal()}`;
}

function hero(){
  return `<section class="hero" aria-labelledby="hero-title">
    <h1 id="hero-title"><img src="${art}title.webp" alt="联机大厅" fetchpriority="high" decoding="async"></h1>
    ${['boy','corgi','sprout','girl'].map(name=>`<img class="hero-${name}" src="${art}${name}.webp" alt="" decoding="async">`).join('')}
  </section>`;
}

function saveSummary(saves){
  const entries=Object.entries(saves??{});
  if(!entries.length)return '尚无存档';
  const shown=entries.slice(0,2).map(([id,save])=>{
    const title=games.find(game=>game.id===id)?.title??id;
    return title+' '+levelName(save?.levelId);
  });
  return shown.join(' · ')+(entries.length>shown.length?' …':'');
}
function roomCard(item,game){
  const running=['starting','playing'].includes(item.phase);
  const playing=item.phase==='playing';
  const count=running?item.participants||item.connected:item.connected;
  const saved=game?item.saves?.[game.id]:null;
  const status=playing?'进行中':running?'正在开局':item.connected?(item.available?'等候玩家':'已满'):'已保存';
  const joinLabel=item.midMatch?(item.available?'加入对局':'对局已满'):running?'对局中':'加入';
  const hasSeat=Boolean(readToken(item.name)?.token);
  const canShowSpectate=game?.runtime==='bvn33-online'&&running;
  const watchable=roomsConfirmed&&playing&&item.spectatable===true;
  const joinAction=hasSeat
    ?`<button type="button" data-action="recent-room" data-room="${esc(item.name)}">返回房间</button>`
    :`<button type="button" data-action="pick-room" data-key="${esc(item.key)}" ${item.available?'':'disabled'}>${joinLabel}</button>`;
  const action=canShowSpectate
    ?`<div class="catalog-room-actions">${hasSeat?joinAction:''}<button type="button" class="primary" data-action="spectate-room" data-key="${esc(item.key)}" ${watchable?'':'disabled'}>观战</button></div>`
    :joinAction;
  return `<li class="catalog-room ${running?'live':''}" style="--game-color:${styleFor(game?.id).color}">
    <span class="room-thumbnail">${coverImage(game?.id)}</span><div class="catalog-room-copy"><b>${esc(item.name)}</b><small>${status} · ${count}/${roomCapacity(item)} ${playing?'参赛':'在线'}${saved?' · '+esc(levelName(saved.levelId)):''}</small>${canShowSpectate&&!watchable?`<small class="spectate-status">${roomsConfirmed?'双方开战后开放观战':'正在确认观战状态'}</small>`:''}</div>${action}</li>`;
}
function glortonRoomCard(item){
  const playing=item.phase==='playing';
  const finished=item.phase==='finished';
  const capacity=roomCapacity(item);
  const full=item.occupied>=capacity;
  const returning=Boolean(readGlortonSeat(item.code));
  const status=finished?'结算中':item.paused?'等待重连':playing?'进行中':full?'已满':item.connected?'等候玩家':'等待房主进入';
  const buttonLabel=returning?'返回房间':item.available?'加入':finished?'结算中':playing?'对局中':item.paused?'等待重连':full?'已满':'暂不可加入';
  return `<li class="catalog-room ${playing?'live':''}" style="--game-color:${styleFor(glortonGame.id).color}">
    <span class="room-thumbnail glorton-room-thumbnail">${coverImage(glortonGame.id)||icon('gamepad')}</span>
    <div class="catalog-room-copy"><b><span class="room-game-tag">[${esc(glortonGame.title)}]</span>${esc(item.name)}</b>
    <small>${status} · ${Number(item.connected)||0}/${capacity} 在线</small></div>
    <button type="button" data-action="join-glorton-room" data-key="${esc(item.key)}" ${item.available||returning?'':'disabled'}>${buttonLabel}</button>
  </li>`;
}
function filteredRooms(){
  const query=plazaQuery.trim().toLocaleLowerCase('en-US');
  return plazaRooms.filter(item=>item.listed!==false&&(!selectedGame||item.gameId===selectedGame)&&
      (!query||[item.name,item.code].some(value=>String(value??'').toLocaleLowerCase('en-US').includes(query))))
    .sort((a,b)=>Number(b.phase==='playing')-Number(a.phase==='playing')||b.connected-a.connected);
}
function catalogHtml(){
  const cards=listedGames().map(game=>`<article class="catalog-game game-card" data-game="${esc(game.id)}" style="--game-color:${styleFor(game.id).color}">
    <button type="button" class="game-select" data-action="filter-game" data-game="${esc(game.id)}" aria-pressed="${selectedGame===game.id}">
      ${coverImage(game.id,'card-art')}
      <div class="game-caption"><strong>${esc(game.title)}</strong><small>${icon('users')} ${gameSeatRange(game)} 人 <span>${versusRuntimes.has(game.runtime)?'对战':'合作'}</span></small></div>
    </button>
    <button type="button" class="game-create" data-action="focus-create" data-game="${esc(game.id)}" aria-label="创建${esc(game.title)}房间" title="创建房间">${icon('plus')}</button>
  </article>`).join('');
  return (cards||'<p class="catalog-empty">正在读取游戏目录…</p>')+`<article class="catalog-game game-card glorton-card" data-game="${glortonGame.id}" style="--game-color:${styleFor(glortonGame.id).color}">
    <button type="button" class="game-select" data-action="filter-game" data-game="${glortonGame.id}" aria-pressed="${selectedGame===glortonGame.id}" aria-label="筛选疯狂小人乱斗房间">
      ${coverImage(glortonGame.id,'card-art')||`<span class="glorton-card-art" aria-hidden="true">${icon('gamepad')}</span>`}
      <span class="game-caption"><strong>${glortonGame.title}</strong><small>${icon('users')} 2–4 人 <span>网页对战</span></small></span>
    </button>
    <button type="button" class="game-create" data-action="open-glorton" aria-haspopup="dialog" aria-label="打开疯狂小人乱斗联机" title="创建疯狂小人乱斗房间">${icon('plus')}</button>
  </article>`;
}

function glortonRoomReference(value){
  return String(value??'').normalize('NFC').trim().replace(/\s+/g,' ');
}
function roomNameKey(value){return glortonRoomReference(value).normalize('NFKC').toLocaleLowerCase('en-US');}
function readGlortonSeat(code){
  if(!glortonCodePattern.test(code??''))return null;
  try{
    const token=sessionStorage.getItem('glorton-browser-seat:'+code);
    return /^[A-Za-z0-9_-]{32}$/.test(token??'')?token:null;
  }catch{return null;}
}
function setGlortonSearch(mode,reference){
  const url=new URL(location.href);
  url.searchParams.delete('glorton');
  if(url.searchParams.get('game')===glortonGame.id||mode){
    url.searchParams.delete('game');
    url.searchParams.delete('room');
  }
  if(mode==='host')url.searchParams.set('glorton','host');
  if(mode==='join'&&reference){
    url.searchParams.set('room',reference);
    url.searchParams.set('game',glortonGame.id);
  }
  history.replaceState(null,'',url.pathname+url.search+url.hash);
}
function glortonPanel(){
  if(!glortonMode)return '';
  const host=glortonMode==='host';
  return `<div class="modal-mask"><section class="dialog glorton-dialog" role="dialog" aria-modal="true" aria-labelledby="glorton-title" tabindex="-1">
    <div class="dialog-head">
      <span class="dialog-icon">${icon('gamepad')}</span>
      <div><h2 id="glorton-title">疯狂小人乱斗</h2><p>2–4 人网页对战</p></div>
      <button class="glorton-close" type="button" data-action="close-glorton" aria-label="关闭疯狂小人乱斗" ${glortonBusy?'disabled':''}>${icon('close')}</button>
    </div>
    <div class="glorton-health" id="glorton-health" data-status="checking">
      <span id="glorton-health-text" role="status">正在检测联机服务…</span>
      <button type="button" class="network-retry" data-action="check-glorton" hidden>重新检测</button>
    </div>
    <div class="glorton-modes" role="group" aria-label="房间操作">
      <button type="button" data-action="glorton-host" aria-pressed="${host}" ${glortonBusy?'disabled':''}>${icon('plus')}创建房间</button>
      <button type="button" data-action="glorton-join" aria-pressed="${!host}" ${glortonBusy?'disabled':''}>${icon('room')}加入房间</button>
    </div>
    <form id="glorton-form" class="create-grid" novalidate>
      ${host?`<div class="field"><label for="glorton-room-name">房间名（选填）</label><input class="input" id="glorton-room-name" type="text" maxlength="24" autocomplete="off" value="${esc(glortonRoomName)}" placeholder="例如 2333，留空时自动命名" ${glortonBusy?'disabled':''}></div>`
        :`<div class="field"><label for="glorton-room-query">房间名或房间码</label><input class="input" id="glorton-room-query" type="text" maxlength="24" autocomplete="off" spellcheck="false" value="${esc(glortonRoomQuery)}" placeholder="输入房主创建的房间名" ${glortonBusy?'disabled':''}></div>`}
      <div class="field"><label for="glorton-password">房间密码</label><input class="input" id="glorton-password" type="password" maxlength="64" autocomplete="${host?'new-password':'off'}" value="${esc(glortonPassword)}" placeholder="${host?'至少 4 位':'输入房主提供的密码'}" ${glortonBusy?'disabled':''}></div>
      ${host?'<p class="glorton-step">用房间名或邀请链接邀请好友。2–4 位玩家在线并准备后自动开局。</p>':''}
      <p id="glorton-error" class="notice error" role="alert" ${glortonError?'':'hidden'}>${esc(glortonError)}</p>
      <div class="dialog-actions"><button type="submit" class="primary" data-action="enter-glorton" ${glortonHealth&&!glortonBusy?'':'disabled'}>${glortonBusy?'<span class="spinner"></span> ':''}${host?'创建并进入':'进入对局'}</button></div>
    </form>
  </section></div>`;
}
function showGlortonHealth(){
  const banner=$('#glorton-health');
  if(!banner)return;
  banner.dataset.status=glortonProbe?'checking':glortonHealth?'online':'offline';
  $('#glorton-health-text').textContent=glortonProbe?'正在检测联机服务…':glortonHealth?'联机服务可用':'联机服务暂不可用';
  $('[data-action="check-glorton"]').hidden=Boolean(glortonProbe||glortonHealth);
  $('[data-action="enter-glorton"]').disabled=Boolean(glortonProbe||!glortonHealth||glortonBusy);
}
function checkGlorton(){
  if(glortonProbe)return;
  glortonProbe=(async()=>{
    for(let attempt=0;attempt<2;attempt++){
      try{
        const status=await fetchJson('/glorton-online/browser-health',{cache:'no-store',signal:AbortSignal.timeout(5000)});
        if(status.ok===true){glortonHealth=true;return;}
      }catch{}
      if(!glortonMode)break;
    }
    glortonHealth=false;
  })();
  void glortonProbe.finally(()=>{glortonProbe=null;showGlortonHealth();});
  showGlortonHealth();
}
function openGlorton(mode,reference){
  if(view!=='auth'||busy||glortonBusy)return;
  const alreadyOpen=Boolean(glortonMode);
  if(mode!==glortonMode||reference!==undefined){glortonError='';glortonPassword='';}
  if(reference!==undefined)glortonRoomQuery=reference;
  glortonMode=mode;
  focusGlorton=true;
  setGlortonSearch(mode,glortonRoomReference(glortonRoomQuery));
  renderAuth();
  if(!alreadyOpen)checkGlorton();
}
function closeGlorton(){
  if(glortonBusy)return;
  glortonMode=null;
  glortonRoomName='';glortonRoomQuery='';glortonPassword='';glortonError='';
  setGlortonSearch(null);
  renderAuth();
  $('[data-action="open-glorton"]')?.focus({preventScroll:true});
}
function glortonProblem(message){
  glortonError=message;
  const node=$('#glorton-error');
  if(node){node.hidden=!message;node.textContent=message;}
}
async function submitGlorton(){
  if(glortonBusy||!glortonMode||!glortonHealth)return;
  const host=glortonMode==='host';
  const reference=glortonRoomReference(glortonRoomQuery);
  if(!host&&(Array.from(reference).length<2||Array.from(reference).length>24)){
    glortonProblem('请输入房间名或房间码。');$('#glorton-room-query')?.focus();return;
  }
  if(glortonPassword.trim().length<4||glortonPassword.length>64){
    glortonProblem('请输入 4–64 位房间密码。');$('#glorton-password')?.focus();return;
  }
  ensureProfile();
  const known=host?null:plazaRooms.find(item=>item.gameId===glortonGame.id&&
    [item.name,item.code].some(value=>roomNameKey(value)===roomNameKey(reference)));
  const priorSeat=host?null:readGlortonSeat(known?.code??reference.normalize('NFKC').toUpperCase());
  const body={name:profile.name,password:glortonPassword,...(host?{roomName:glortonRoomName.trim(),roster:'auto'}
    :{room:reference,...(priorSeat?{seat:priorSeat}:{})})};
  glortonBusy=true;glortonError='';renderAuth();
  try{
    const result=await fetchJson('/glorton-online/'+(host?'rooms':'join'),{
      method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(8000),
    });
    launchGlorton(result,host?glortonRoomName.trim():reference);
    glortonPassword='';
  }catch(error){
    glortonBusy=false;
    glortonError=error.name==='TimeoutError'?'进入房间超时，请重试。':error.message;
    renderAuth();$('#glorton-password')?.focus();
  }
}
function launchGlorton(result,fallbackName){
  if(result.renderMode!=='local'||!glortonCodePattern.test(result.room)||!/^[-_a-zA-Z0-9]{32}$/.test(result.seat??''))
    throw Error('房间凭证无效，请重试。');
  const name=result.roomName||fallbackName||result.room;
  navigating=true;
  location.assign('/glorton-local/index.html#'+new URLSearchParams({room:result.room,seat:result.seat,name}));
}
function plazaListHtml(){
  const rooms=filteredRooms();
  if(!rooms.length)return `<p class="catalog-empty">${plazaQuery.trim()?'没有匹配的房间':roomsReadFailed?'正在重新连接…':'暂无房间，创建一间邀请好友吧。'}</p>`;
  return rooms.map(item=>{
    const card=item.gameId===glortonGame.id?glortonRoomCard(item):roomCard(item,games.find(game=>game.id===item.gameId));
    return `<ul class="catalog-rooms catalog-game" data-game="${esc(item.gameId)}">${card}</ul>`;
  }).join('');
}
function renderPlazaList(){
  const list=document.getElementById('plaza-list');
  if(list)list.innerHTML=plazaListHtml();
  renderPlazaCount();
}
function renderPlazaCount(){
  const count=document.getElementById('plaza-count');
  if(count)count.textContent=filteredRooms().length+' 个房间';
  const filter=$('#clear-game-filter');
  if(filter){
    const label=selectedGame===glortonGame.id?glortonGame.title:games.find(game=>game.id===selectedGame)?.title;
    filter.hidden=!label;
    filter.textContent=label?label+' ×':'';
  }
}
function joinModal(){
  if(!joinTarget)return '';
  const game=games.find(item=>item.id===joinTarget.gameId);
  const watching=joinTarget.spectate===true;
  const caption=watching?'进入观战':joinTarget.midMatch?'加入对局':'加入房间';
  return `<div class="modal-mask"><div class="dialog join-dialog" role="dialog" aria-modal="true" aria-labelledby="join-title">
    <div class="dialog-head"><span class="dialog-icon">${icon('lock')}</span><div><h3 id="join-title">${esc(joinTarget.name)}</h3>${game?`<p>${esc(game.title)}${watching?' · 观战':''}</p>`:''}</div></div>
    ${profile?'':`<button type="button" class="join-guest" data-action="save-profile">${icon('user')} 使用游客昵称</button>`}
    <label class="field-label" for="join-password">房间密码</label>
    <input id="join-password" class="input" type="password" maxlength="64" autocomplete="current-password" value="${esc(joinForm.password)}" placeholder="至少 4 位">
    <div id="join-status" class="notice error" role="status" ${joinError?'':'hidden'}>${esc(joinError)}</div>
    <div class="dialog-actions"><button type="button" data-action="cancel-pick" ${busy?'disabled':''}>取消</button>
      ${!watching&&joinError&&readToken(joinTarget.name)?.token?'<button type="button" data-action="retry-room-connection">重试连接</button>':''}
      <button type="button" class="primary" data-action="confirm-join" ${busy||joinTarget.missing||(watching&&!joinTarget.spectatable)?'disabled':''}>${busy==='join'?'<span class="spinner"></span>':''}${caption}</button></div>
  </div></div>`;
}
function lanStatusText(){
  if(!lanOrigin)return '未配置';
  if(lanReachability==='checking')return '正在检测本设备的连接…';
  if(lanReachability==='reachable')return onLan?'当前入口 · 已连通':'已连通，可切换';
  return '当前浏览器无法验证连接';
}
function renderNetworkChoice(){
  if(!lanOrigin&&!wanOrigin)return '';
  return `<nav class="lobby-networks" aria-label="大厅入口">
    <button type="button" class="network-choice" data-action="switch-lan" data-reachability="${lanReachability}"
      ${onLan?'aria-current="page"':''} ${lanReachability!=='reachable'||onLan?'disabled':''}>
      ${icon('monitor')}<span><b>局域网大厅</b><small id="lan-reachability" role="status">${lanStatusText()}</small></span></button>
    <button type="button" class="network-choice" data-action="switch-wan"
      ${onWan?'aria-current="page"':''} ${!wanOrigin||onWan?'disabled':''}>
      ${icon('globe')}<span><b>公网大厅</b><small>${onWan?'当前入口':wanOrigin?'通过互联网与好友联机':'未配置'}</small></span></button>
  </nav>`;
}
function updateLanChoice(){
  const button=$('[data-action="switch-lan"]');
  if(!button)return;
  button.disabled=lanReachability!=='reachable'||onLan;
  button.dataset.reachability=lanReachability;
  $('#lan-reachability').textContent=lanStatusText();
  const retry=$('[data-action="verify-lan"]');
  if(retry)retry.disabled=Boolean(lanProbe);
}
function verifyLan(){
  if(lanProbe)return lanProbe;
  const probe=(async()=>{
    try{
      const nonce=Array.from(crypto.getRandomValues(new Uint8Array(12)),byte=>byte.toString(16).padStart(2,'0')).join('');
      const url=new URL('/__lobby__/reachability',lanOrigin);
      url.searchParams.set('nonce',nonce);
      const response=await fetch(url,{mode:'cors',cache:'no-store',credentials:'omit',
        redirect:'error',signal:AbortSignal.timeout(4500)});
      if(!response.ok||response.url!==url.href)return false;
      const proof=await response.json();
      return proof.kind==='lobby-reachability'&&proof.origin===lanOrigin&&proof.nonce===nonce;
    }catch{return false;}
  })();
  lanReachability='checking';
  lanProbe=probe.then(reachable=>{
    lanReachability=reachable?'reachable':'unavailable';
    lanProbe=null;
    updateLanChoice();
    return reachable;
  });
  updateLanChoice();
  return lanProbe;
}
function switchLobby(origin){
  if(!origin||view!=='auth'||busy||navigating||location.origin===origin)return;
  const url=new URL('/',origin);
  const requestedRoom=new URLSearchParams(location.search).get('room');
  if(requestedRoom)url.searchParams.set('room',requestedRoom);
  navigating=true;
  location.assign(url.href);
}
function renderAuth(){
  view='auth';room=null;seat=null;
  const choices=listedGames();
  const createGame=choices.find(game=>game.id===createGameId);
  app.innerHTML=shell(`<div class="lobby-content">
    ${hero()}
    ${renderNetworkChoice()}
    <div class="carnival-board">
      ${watchNotice?`<div class="notice board-notice" role="status">${watchNotice}</div>`:''}
      <div id="catalog-connection" class="notice catalog-connection board-notice" role="status" hidden></div>
      ${lastError&&!createGame?`<div class="notice error board-notice">${esc(lastError)}</div>`:''}
      <section class="games-column" id="games" aria-labelledby="games-title">
        <div class="gallery-head"><h2 id="games-title">${icon('gamepad')}选择游戏</h2>
          ${lanOrigin?`<button type="button" class="network-retry" data-action="verify-lan" ${lanProbe?'disabled':''}>${icon('refresh')}检测局域网</button>`:''}</div>
        <div id="game-catalog" class="catalog-grid">${catalogHtml()}</div>
      </section>
      <aside class="rooms-column" id="rooms" aria-labelledby="rooms-title">
        <button type="button" class="create-main" data-action="open-create" ${choices.length?'':'disabled'}>${icon('plus')}创建房间</button>
        <section class="room-browser">
          <header class="room-browser-head"><h2 id="rooms-title">${icon('users')}房间列表</h2><span id="plaza-count">0 个房间</span></header>
          <div class="room-search"><label>${icon('search')}<input id="plaza-search" maxlength="24" autocomplete="off" value="${esc(plazaQuery)}" placeholder="搜索房间名或房间码" aria-label="搜索房间名或房间码"></label>
            <button type="button" data-action="refresh-plaza" aria-label="刷新房间" title="刷新房间">${icon('refresh')}</button>
          </div>
          <button id="clear-game-filter" class="filter-chip" type="button" data-action="filter-game" hidden></button>
          <div id="plaza-list">${plazaListHtml()}</div>
        </section>
      </aside>
    </div>
    ${createGame?`<div class="modal-mask"><section id="create-room-card" class="dialog create-panel" role="dialog" aria-modal="true" aria-labelledby="create-title">
      <div class="dialog-head"><span class="dialog-icon">${icon('gamepad')}</span><h2 id="create-title">创建房间</h2></div>
      ${lastError?`<p class="notice error" role="alert">${esc(lastError)}</p>`:''}
      <form id="create-form" class="create-grid">
        <div class="field"><label for="create-game">游戏</label><select id="create-game" ${busy?'disabled':''}>${choices.map(game=>`<option value="${esc(game.id)}" ${game.id===createGame.id?'selected':''}>${esc(game.title)}</option>`).join('')}</select></div>
        <div class="field"><label for="create-name">房间名</label><input id="create-name" class="input" maxlength="24" autocomplete="off" value="${esc(createForm.name)}" placeholder="2–24 个字符"></div>
        <div class="field"><label for="create-password">房间密码</label><input id="create-password" class="input" type="password" maxlength="64" autocomplete="new-password" value="${esc(createForm.password)}" placeholder="至少 4 位"></div>
        <div class="dialog-actions"><button type="button" data-action="cancel-create" ${busy?'disabled':''}>取消</button><button type="submit" class="primary" data-action="create-room" ${busy?'disabled':''}>${busy==='create'?'<span class="spinner"></span>':''}创建并进入</button></div>
      </form>
    </section></div>`:''}
    ${joinModal()}
    ${glortonPanel()}
  </div>`);
  renderCatalogStatus();
  const search=$('#plaza-search'),createName=$('#create-name'),createPassword=$('#create-password'),joinPassword=$('#join-password');
  search?.addEventListener('input',()=>{plazaQuery=search.value;renderPlazaList();});
  createName?.addEventListener('input',()=>{createForm.name=createName.value;});
  createPassword?.addEventListener('input',()=>{createForm.password=createPassword.value;});
  $('#create-game')?.addEventListener('change',event=>{createGameId=event.target.value;});
  joinPassword?.addEventListener('input',()=>{joinForm.password=joinPassword.value;});
  joinPassword?.addEventListener('keydown',event=>{if(event.key==='Enter')void submitJoin();});
  if(glortonMode){
    if(glortonHealth===null)checkGlorton();
    else showGlortonHealth();
    if(focusGlorton){
      focusGlorton=false;
      $(glortonMode==='host'?'#glorton-room-name':glortonRoomQuery?'#glorton-password':'#glorton-room-query')?.focus({preventScroll:true});
    }
  }
  if(joinTarget&&focusJoin){focusJoin=false;joinPassword?.focus();}
  if(lanOrigin&&!lanProbeStarted){lanProbeStarted=true;void verifyLan();}
}
function renderCatalogStatus(){
  renderPlazaCount();
  const notice=$('#catalog-connection');
  if(!notice)return;
  notice.hidden=!gamesReadFailed&&!roomsReadFailed;
  notice.textContent=games.length?'暂时无法更新大厅，正在自动重试。':'正在重新连接大厅…';
}
function chatMessagesHtml(messages){
  const list=Array.isArray(messages)?messages:[];
  if(!list.length)return '<div class="chat-empty">还没有消息，打个招呼吧 👋</div>';
  return list.map(message=>{
    const mine=message.seat===seat;
    return `<div class="chat-msg ${mine?'mine':''}">
      <span class="chat-avatar" style="--avatar-bg:${seatColor(message.seat)}">${esc(message.avatar||'🐟')}</span>
      <div class="chat-body"><div class="chat-meta"><b>${esc(message.name||seatName(message.seat))}</b><time>${chatTime(message.at)}</time></div>
        <div class="chat-bubble">${esc(message.text)}</div></div></div>`;
  }).join('');
}
function chatPanel(onlineStatus){
  return `<aside class="chat-card" id="room-chat">
    <div class="chat-head"><div><h3>房间聊天</h3><span id="chat-status">${onlineStatus}</span></div><span class="live-dot"></span></div>
    <div class="chat-log" id="chat-log">${chatMessagesHtml(room?.chat)}</div>
    <form class="chat-form" id="chat-form"><input id="chat-input" maxlength="500" autocomplete="off" aria-label="房间聊天消息" placeholder="发送消息…"><button type="submit" class="chat-send">发送</button></form>
  </aside>`;
}
function listedGames(){return games.filter(game=>game.listed!==false);}
function currentGame(){return games.find(game=>game.id===room?.gameId)??null;}
function inviteLink(){return (cfg.viewerOrigin||location.origin)+'/?room='+encodeURIComponent(room?.name??'');}
function bombItOutfitPanel(outfit,locked){
  const parts=[['clothId','服装'],['hatId','帽子'],['expId','表情']];
  const options=['默认','款式 1','款式 2','款式 3'];
  return `<section class="content-card" aria-labelledby="outfit-title">
    <div class="card-head"><div><h2 id="outfit-title">角色装扮</h2><p>${locked?'本局装扮已锁定。':'选择你在对局中使用的原版装扮。'}</p></div></div>
    <fieldset class="outfit-fields" aria-labelledby="outfit-title" ${locked?'disabled':''}>
      ${parts.map(([part,label])=>`<div><label for="outfit-${part}">${label}</label><select id="outfit-${part}" data-outfit-part="${part}">
        ${options.map((name,value)=>`<option value="${value}" ${outfit[part]===value?'selected':''}>${name}</option>`).join('')}
      </select></div>`).join('')}
    </fieldset>
  </section>`;
}
const bombItPreviewRoot='/__lobby__/art/bomb-it-7';
const bombItMapNames={FashionShop:'时装店',Cake:'蛋糕店',Classroom:'教室',Forest:'森林',Race:'赛道',
  Ranch:'牧场',ToyShop:'玩具店',Christmas:'圣诞村',Sand:'沙滩'};
const bombItModeNames={kill:'大乱斗',collect:'抢星星',pacMan:'吃金币',frozen:'冰冻大战'};
function bombItPortrait({robotId=0,clothId=0,hatId=0,expId=0}){
  const variant=clothId*16+hatId*4+expId;
  const offsetX=(variant%8)*100/7;
  const offsetY=Math.floor(variant/8)*100/7;
  return `<span class="bomb-it-portrait" aria-hidden="true" style="--portrait:url('${bombItPreviewRoot}/wardrobe/robot-${robotId}.webp');--portrait-x:${offsetX}%;--portrait-y:${offsetY}%"></span>`;
}
function bombItWardrobe(outfit,seats,locked){
  const choice=(part,value,label,portrait,taken)=>`<button type="button" class="bomb-it-choice" id="bombit-${part}-${value}"
    data-action="bomb-it-outfit" data-outfit-part="${part}" data-outfit-value="${value}"
    aria-pressed="${outfit[part]===value}" ${locked||taken?'disabled':''} ${taken?`aria-label="${label} · ${esc(taken.label)} 使用中"`:''}>
    ${bombItPortrait(portrait)}<span>${label}</span></button>`;
  const characters=Array.from({length:8},(_,robotId)=>choice('robotId',robotId,`角色 ${robotId+1}`,{robotId},
    seats.find(item=>item.seat!==seat&&item.outfit?.robotId===robotId)));
  const parts=[['clothId','服装'],['hatId','帽子'],['expId','表情']];
  return `<section class="content-card" aria-labelledby="bombit-wardrobe-title">
    <div class="card-head"><h2 id="bombit-wardrobe-title">角色与装扮</h2></div>
    <div class="bomb-it-wardrobe">
      <figure class="bomb-it-current">${bombItPortrait(outfit)}<figcaption>角色 ${outfit.robotId+1} · 当前装扮</figcaption></figure>
      <div class="bomb-it-character-grid" role="group" aria-label="选择角色">${characters.join('')}</div>
      ${parts.map(([part,label])=>`<section class="bomb-it-part"><h3>${label}</h3><div class="bomb-it-part-grid" role="group" aria-label="选择${label}">
        ${Array.from({length:4},(_,value)=>choice(part,value,value?'款式 '+value:'默认',{...outfit,[part]:value})).join('')}
      </div></section>`).join('')}
    </div>
  </section>`;
}
function bombItRules(settings,locked){
  const editable=settings.hostSeat===seat&&!locked;
  const group=(ids,names,directory,part,label)=>{
    const items=ids.filter(id=>Object.hasOwn(names,id)).map(id=>{
      const title=names[id];
      const selected=settings[part]===id;
      const card=`<img src="${bombItPreviewRoot}/${directory}/${id}.webp" alt="" loading="lazy" width="112" height="70"><span>${title}</span>`;
      return editable?`<button type="button" class="bomb-it-rule" id="bombit-${part}-${id}" data-action="bomb-it-setting" data-bomb-it-setting="${part}" data-bomb-it-value="${id}" aria-pressed="${selected}">${card}</button>`
        :`<div class="bomb-it-rule${selected?' active':''}" ${selected?'aria-current="true"':''}>${card}</div>`;
    });
    return `<section class="bomb-it-rule-group"><h3>${label}<small>已选 ${esc(names[settings[part]]??'')}</small></h3>
      <div class="bomb-it-rule-strip" id="bombit-${directory}" data-bomb-it-scroll tabindex="0" role="group" aria-label="${label}预览">${items.join('')}</div></section>`;
  };
  return `<section class="content-card" aria-labelledby="bombit-rules-title">
    <div class="card-head"><div><h2 id="bombit-rules-title">地图与模式</h2><p>${editable?'由房主选择本局规则，变更后所有玩家重新准备。':'房主选择地图和模式后，同步给所有玩家。'}</p></div></div>
    ${group(settings.availableMaps??[],bombItMapNames,'maps','mapId','地图')}
    ${group(settings.availableModes??[],bombItModeNames,'modes','modeId','模式')}
  </section>`;
}
function bombItReadyPanel(seats,settings,locked){
  const me=seats.find(item=>item.seat===seat);
  const players=seats.filter(item=>item.occupied);
  const ready=players.filter(item=>item.ready).length;
  const watching=players.some(item=>!item.connected);
  const message=players.length<2?'至少 2 位玩家才能开局。':watching?'正在等待玩家重连，席位保留 20 秒。':'所有玩家准备后自动开局。';
  return `<section class="content-card bomb-it-ready-panel" aria-labelledby="bombit-ready-title">
    <div class="card-head"><div><h2 id="bombit-ready-title">开局准备</h2><p>${esc(bombItModeNames[settings.modeId]??'')} · ${esc(bombItMapNames[settings.mapId]??'')} · ${ready}/${players.length} 已准备</p></div>
      <button type="button" class="${me?.ready?'':'primary'}" id="bombit-ready" data-action="bomb-it-ready" ${locked?'disabled':''}>${me?.ready?'取消准备':'准备'}</button></div>
    ${locked?'':`<p class="bomb-it-ready-note">${message}</p>`}
  </section>`;
}
function renderRoom(){
  view='room';
  const game=currentGame();
  const proposal=room?.proposal;
  const confirmations=proposal?.confirmations??[proposal?.bySeat];
  const voted=proposal&&confirmations.includes(seat);
  const needsConfirmation=proposal&&!voted;
  const waiting=!readyToPlay();
  const starting=room?.phase==='starting';
  const playing=room?.phase==='playing';
  const canSelectLevel=!(waiting||starting||playing||proposal);
  const levels=game?game.levels:[];
  const versus=versusRuntimes.has(game?.runtime);
  const arena=game?.runtime==='tank-arena';
  const canResume=game?.id==='bvn33'||game?.runtime==='platform-brawl';
  const proposalLabel=arena?'迷宫对战':versus
    ? versusModeName(game,levels.find(level=>level.id===proposal?.levelId))
    : levelName(proposal?.levelId);
  const saves=room?.saves??{};
  const phaseText=playing?'游戏进行中':starting?'正在启动':'等候开局';
  const seats=seatEntries();
  const outfit=game?.id==='bomb-it-7'?seats.find(item=>item.seat===seat)?.outfit:null;
  const outfitLocked=Boolean(starting||playing||proposal);
  const bombItSettings=outfit?room.bombItSettings:null;
  const bombItLocked=room.phase!=='select';
  const onlineLabel=playing?'大厅在线':'在线';
  const onlineStatus=`${seats.filter(item=>item.connected).length}/${seatCapacity()} ${onlineLabel}`;
  const awaiting=seats.filter(item=>item.connected&&!confirmations.includes(item.seat))
    .map(item=>item.name||item.label).join('、');
  const banner=voted?`<div class="banner"><div>已确认 <b>${esc(proposalLabel)}</b>，等待 ${esc(awaiting)}。</div><button type="button" data-action="cancel-proposal">${proposal.bySeat===seat?'撤回提议':'取消开局'}</button></div>`:'';
  const waitingBanner=waiting&&!starting&&!playing?`<div class="banner soft">至少 ${room.minimumSeats??seatCapacity()} 人在线才能开局。可复制邀请链接给好友。</div>`:'';
  const joinActive=matchEntry?'':arena?'加入当前对局':canResume?'继续进入对局':'';
  const playingBanner=playing?`<div class="banner soft"><div>当前对局进行中。</div>${joinActive?`<button type="button" data-action="join-active">${joinActive}</button>`:''}</div>`:'';
  const matchEntryBanner=matchEntry?`<div class="banner match-entry" role="status">
    <div>${matchEntry.checking?`正在检查${esc(matchEntry.settings.title)}的对战入口…`:'对战入口暂时无法连接，房间席位已保留。'}</div>
    ${matchEntry.checking?'':'<button type="button" data-action="retry-match-entry">重试进入对局</button>'}
  </div>`:'';
  const chatField=$('#chat-input');
  const chatDraft=chatField?.value??'';
  const restoreChat=chatField&&document.activeElement===chatField;
  const activeControl=document.activeElement;
  const focusedBombIt=bombItSettings&&activeControl?.id.startsWith('bombit-')?activeControl.id:null;
  const bombItScroll=bombItSettings?Array.from(app.querySelectorAll('[data-bomb-it-scroll]'),el=>[el.id,el.scrollLeft]):[];
  const focusedOutfit=outfit&&!outfitLocked&&!bombItSettings?activeControl?.dataset.outfitPart:null;
  const lastLog=$('#chat-log');
  const previousScroll=lastLog&&lastLog.scrollHeight-lastLog.scrollTop-lastLog.clientHeight>16?lastLog.scrollTop:null;
  app.innerHTML=shell(`
    <header class="room-banner" style="--game-color:${styleFor(game?.id).color}">
      ${coverImage(game?.id,'room-banner-art')}
      <div class="room-title-block"><span class="eyebrow">${icon('room')} ${phaseText}</span><h1>${esc(room?.name??'')}</h1>
        <p>${esc(game?.title??'等待选择游戏')} · ${onlineStatus}</p></div>
      <div class="room-banner-actions"><button type="button" class="danger" data-action="leave">退出房间</button></div>
    </header>
    ${waitingBanner}${playingBanner}${matchEntryBanner}${banner}
    <div class="room-layout">
      <aside class="room-left">
        <section class="side-card"><h3>${icon('users')}房间玩家</h3>
          ${seats.map(item=>{
            const isMe=item.seat===seat;
            const avatar=isMe?esc(profile?.avatar??'🐟'):'🎮';
            const name=isMe?(profile?.name??'游客'):(item.name||item.label);
            const readyStatus=item.ready?'已准备':'未准备';
            const note=bombItSettings&&!bombItLocked&&item.occupied
              ? `${item.connected?'':'重连中 · '}${readyStatus}`
              : item.connected?onlineLabel:item.occupied?'席位保留':'空席';
            return `<div class="player-row seat-pill seat-${item.seat} ${item.connected?'on':''}"><span class="player-mini-avatar ${isMe?'':'opponent'}" style="--avatar-bg:${isMe?esc(profile?.bg??seatColor(item.seat)):seatColor(item.seat)}">${avatar}<i class="dot" aria-hidden="true"></i></span><div><b>${esc(name)}${isMe?'（你）':''}</b><small>${esc(item.label)} · ${esc(note)}</small></div></div>`;
          }).join('')}
        </section>
        <section class="side-card"><h3>${icon('plus')}邀请好友</h3>
          <div class="invite-box"><input aria-label="邀请链接" readonly value="${esc(inviteLink())}"><button type="button" data-action="copy-invite">复制链接</button></div></section>
      </aside>
      <section class="room-center">
        ${!room.boundGameId?`<section class="content-card"><div class="card-head"><div><h2>选择此房间的游戏</h2><p>选择后，房间将归入对应的游戏，原有存档继续保留。</p></div></div>
          <div class="room-game-grid legacy-games">${listedGames().map(item=>`<button type="button" data-action="select-game" data-game="${esc(item.id)}" ${starting||playing?'disabled':''}>${styleFor(item.id).emoji} ${esc(item.title)}</button>`).join('')}</div></section>`:''}
        ${bombItSettings?bombItReadyPanel(seats,bombItSettings,bombItLocked)+bombItWardrobe(outfit,seats,bombItLocked)+bombItRules(bombItSettings,bombItLocked):''}
        ${outfit&&!bombItSettings?bombItOutfitPanel(outfit,outfitLocked):''}
        ${game&&!bombItSettings?`<section class="content-card room-play"><div class="card-head"><div><h2>${icon('play')}${versus?'开始对战':'选择关卡'}</h2><p>${arena?'在线玩家确认后开局，模式在对局内投票。':'发起提议，在线玩家确认后开始。'}</p></div>${Object.keys(saves).length?`<span class="save-state">${esc(saveSummary(saves))}</span>`:''}</div>
          <div class="level-grid">${levels.map(level=>{
            const save=saves?.[game.id];
            const flash=game.runtime==='flash-ruffle';
            // external 游戏（坦克动荡）没有关卡概念：唯一一项就是「开一局」，
            // 由服务端分配 4 位房间码。
            const external=game.runtime==='html5-external';
            return `<button type="button" class="level-card ${canSelectLevel?'':'disabled'} ${save?.levelId===level.id?'saved':''}" data-action="level" data-level="${level.id}" data-game="${esc(game.id)}" ${canSelectLevel?'':'disabled'}>
              ${save?.levelId===level.id?'<span class="level-mark">存档</span>':''}
              <span class="level-n">${arena?'开局':versus?esc(versusModeName(game,level)):external||flash?'开始':level.id===0?'教学':level.id}</span>
              <span class="level-t">${external?'新建 4 位房间码':versus?`${gameSeatRange(game)} 人对战`:flash?'联机':typeName(level.type)}</span></button>`;
          }).join('')}</div></section>`:''}
      </section>
      ${chatPanel(onlineStatus)}
    </div>
    ${starting?`<div class="modal-mask"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="starting-title" tabindex="-1"><h3 id="starting-title"><span class="spinner"></span>正在启动游戏</h3><p>准备完成后会自动进入对局。</p></div></div>`:''}
    ${needsConfirmation&&!starting?`<div class="modal-mask"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-title"><div class="dialog-head"><span class="dialog-icon">${icon('gamepad')}</span><div><h3 id="proposal-title">${esc(seatName(proposal.bySeat))} 请求开始</h3><p><b>${esc(game?.title??'')} · ${game?.runtime==='flash-ruffle'?'进入游戏':esc(proposalLabel)}</b></p></div></div>
      <p>已确认 ${confirmations.length} / ${room.connectedCount??seats.filter(item=>item.connected).length} 人</p>
      <div class="dialog-actions"><button type="button" data-action="cancel-proposal">取消</button><button type="button" class="primary" data-action="confirm-level">确定开始</button></div></div></div>`:''}
  `);
  const nextChat=$('#chat-input');
  if(nextChat){
    nextChat.value=chatDraft;
    if(restoreChat&&!starting&&!needsConfirmation){
      nextChat.focus({preventScroll:true});
      nextChat.setSelectionRange(chatField.selectionStart,chatField.selectionEnd);
    }
  }
  const log=$('#chat-log');
  if(log)log.scrollTop=previousScroll??log.scrollHeight;
  if(focusedOutfit)app.querySelector(`[data-outfit-part="${CSS.escape(focusedOutfit)}"]`)?.focus({preventScroll:true});
  for(const [id,offset] of bombItScroll){
    const strip=document.getElementById(id);
    if(strip)strip.scrollLeft=offset;
  }
  if(focusedBombIt)document.getElementById(focusedBombIt)?.focus({preventScroll:true});
}
function render(){
  if(view==='room'&&room)renderRoom();
  else if(view==='connecting')app.innerHTML=shell(`<div class="boot">
    <p role="status">正在连接房间「${esc(connectingRoom)}」…</p>
    <button type="button" data-action="cancel-room-connection">取消</button>
  </div>`);
  else renderAuth();
}
function typingInApp(){
  const active=document.activeElement;
  return Boolean(active&&app.contains(active)&&active.tagName==='INPUT');
}
async function loadPlaza({render=true}={}){
  if(!roomsRequest){
    roomsRequest=(async()=>{
      try{
        const {rooms}=await fetchJson(apiBase+'/api/rooms',{signal:AbortSignal.timeout(5800)});
        if(!Array.isArray(rooms))throw Error('房间列表无效');
        plazaRooms=rooms;roomsReadFailed=false;roomsConfirmed=true;
        cacheCatalog();
        if(joinTarget&&!joinTarget.manual){
          const latest=rooms.find(item=>item.key===joinTarget.key);
          if(joinTarget.spectate){
            joinTarget={...(latest??joinTarget),spectate:true,spectatable:latest?.spectatable===true};
            if(!joinTarget.spectatable)joinError='当前对局已结束或暂停，暂时无法观战。';
          }else{
            joinTarget=latest??{...joinTarget,missing:true};
            if(!latest)joinError='这个房间已关闭。';
          }
        }
      }catch{roomsReadFailed=true;roomsConfirmed=false;}
      finally{roomsRequest=null;}
    })();
  }
  await roomsRequest;
  if(render&&view==='auth'&&!busy&&!joinTarget&&!createGameId&&!profileOpen){renderPlazaList();renderCatalogStatus();}
}
async function loadGames(){
  if(!gamesRequest){
    gamesRequest=(async()=>{
      try{
        const body=await fetchJson(apiBase+'/api/games',{signal:AbortSignal.timeout(5800)});
        if(!Array.isArray(body.games))throw Error('游戏目录无效');
        games=body.games;gamesReadFailed=false;
        cacheCatalog();
      }catch{gamesReadFailed=true;}
      finally{gamesRequest=null;}
    })();
  }
  await gamesRequest;
}
async function refreshLobby(all=false){
  if(view!=='auth'||busy||(!all&&document.hidden))return;
  if(glortonMode&&!glortonHealth)checkGlorton();
  const before=JSON.stringify(games);
  await Promise.all([loadPlaza({render:false}),all||!games.length||gamesReadFailed?loadGames():null]);
  if(view!=='auth'||busy||createGameId||profileOpen)return;
  if(joinTarget){
    const submit=$('[data-action="confirm-join"]');
    if(submit)submit.disabled=Boolean(joinTarget.missing||(joinTarget.spectate&&!joinTarget.spectatable));
    const status=$('#join-status');
    if(status){status.hidden=!joinError; status.textContent=joinError;}
  }
  if(before!==JSON.stringify(games)){
    $('#game-catalog').innerHTML=catalogHtml();
    $('[data-action="open-create"]').disabled=!listedGames().length;
  }
  renderPlazaList();
  renderCatalogStatus();
}
function setRoomUrl(name){
  try{
    const url=new URL(location.href);
    if(name)url.searchParams.set('room',name);else url.searchParams.delete('room');
    history.replaceState(null,'',url.pathname+url.search+url.hash);
  }catch{}
}
function enterRoom(result){
  if(!result?.room?.name||typeof result.token!=='string')throw Error('大厅没有返回可用的房间席位，请重试。');
  storeToken(result.room.name,result.token,result.seat);
  games=result.games??games;
  createGameId=null; createForm={name:'',password:''};
  joinTarget=null;joinForm.password='';joinError='';focusJoin=false;
  busy=null;lastError='';
  if(result.session&&!matchEntries.has(result.session.gameId)){
    setRoomUrl(result.room.name);
    navigateToGame(result.session);
  }else connect(result.room.name,result.token,{joinActive:Boolean(result.session)});
}
function showJoin(name,message=''){
  const known=plazaRooms.find(item=>item.gameId!==glortonGame.id&&item.name===name);
  joinTarget=known??{name,key:name.toLocaleLowerCase('en-US'),available:true,manual:true};
  joinForm.password='';joinError=message;lastError='';focusJoin=true;renderAuth();
}
function reenterRecent(name){
  const stored=readToken(name);
  if(stored?.token)connect(name,stored.token);
  else showJoin(name);
}
async function submitCreate(){
  if(busy||!createGameId)return;
  const name=(createForm.name||'').trim(),password=createForm.password||'';
  if(name.length<2){toast('请输入 2-24 个字符的房间名');return;}
  if(password.length<4){toast('密码至少 4 个字符');return;}
  ensureProfile();
  busy='create';lastError='';renderAuth();
  try{const result=await fetchJson(apiBase+'/api/rooms',{method:'POST',signal:AbortSignal.timeout(7500),body:JSON.stringify({name,password,gameId:createGameId})});enterRoom(result);}
  catch(error){busy=null;lastError=error.message;toast(error.message);renderAuth();}
}
async function submitJoin(){
  if(busy||!joinTarget||joinTarget.missing)return;
  const {name,spectate,spectatable}=joinTarget;
  if(spectate&&!spectatable)return;
  const password=joinForm.password||'';
  if(password.length<4){toast('密码至少 4 个字符');return;}
  ensureProfile();
  busy='join';joinError='';lastError='';renderAuth();
  try{
    const endpoint=spectate?'/api/rooms/spectate':'/api/rooms/join';
    const body=spectate?{name,password,nickname:profile?.name}:{name,password,profile};
    let result;
    try{result=await fetchJson(apiBase+endpoint,{method:'POST',body:JSON.stringify(body),signal:AbortSignal.timeout(7500)});}
    catch(error){
      // An unqualified invite can arrive while the shared room list is unavailable.
      if(spectate||!joinTarget.manual||error.code!=='ROOM_NOT_FOUND')throw error;
      const pending=await fetchJson('/glorton-online/join',{method:'POST',
        body:JSON.stringify({room:name,password,name:profile.name}),signal:AbortSignal.timeout(7500)});
      launchGlorton(pending,name);
      return;
    }
    if(!spectate){enterRoom(result);return;}
    const launch=new URL(result.launchUrl);
    if(!['http:','https:'].includes(launch.protocol)||launch.username||launch.password)
      throw Error('观战地址无效，请重试。');
    navigating=true;
    joinForm.password='';
    location.assign(launch);
  }
  catch(error){busy=null;joinError=error.message;toast(error.message);
    if(error.code==='ROOM_NOT_FOUND'){lastError=error.message;joinError='';joinTarget=null;joinForm.password='';void loadPlaza({render:false});}else void loadPlaza({render:false});
    renderAuth();}
}
function sendChat(){
  const input=$('#chat-input');const text=(input?.value||'').trim();
  if(!text)return;
  if(!profile){profileDraft={name:randomGuestName(),avatar:'🐟',bg:'#2ecc71'};profileOpen=true;render();return;}
  if(ws?.readyState!==WebSocket.OPEN){toast('大厅连接未建立，暂时无法发送');return;}
  ws.send(JSON.stringify({type:'chat',text,name:profile.name,avatar:profile.avatar}));
  if(input)input.value='';
}
// 把游客昵称同步给服务端席位，投票提示才能显示"谁请求了什么"。
function sendProfile(){
  if(!profile||ws?.readyState!==WebSocket.OPEN)return;
  ws.send(JSON.stringify({type:'profile',name:profile.name,avatar:profile.avatar}));
}
function closeLobbyConnection(){
  clearTimeout(connectionTimer);clearTimeout(reconnectTimer);
  connectionTimer=null;reconnectTimer=null;
  const previous=ws;
  ws=null;
  previous?.close();
}
function recoverRoom(name,message,{discardToken=false}={}){
  clearMatchEntry();
  closeLobbyConnection();
  if(discardToken)clearToken(name);
  showJoin(name,message);
  void (games.length?loadPlaza():loadGames().then(()=>loadPlaza()));
}
function connect(name,token,{attempt=0,joinActive=false,target=0}={}){
  closeLobbyConnection();
  connectingRoom=name;view='connecting';setRoomUrl(name);render();
  const socket=new WebSocket(lobbySockets[target]+'?token='+encodeURIComponent(token));
  ws=socket;
  let welcomed=false;
  const current=()=>ws===socket&&!navigating;
  const rejectToken=()=>recoverRoom(name,'房间凭证已失效，请输入密码重新加入。',{discardToken:true});
  const hasAlternate=lobbySockets.length>1;
  function retryConnection(timedOut=false){
    if(!current())return;
    closeLobbyConnection();
    if(!welcomed&&(timedOut&&!hasAlternate||attempt>=(hasAlternate?1:2))){
      recoverRoom(name,timedOut?'连接大厅超时，请重试。':'无法连接大厅，请重试。');
      return;
    }
    const nextTarget=(target+1)%lobbySockets.length;
    connectingRoom=name;view='connecting';render();
    reconnectTimer=setTimeout(()=>connect(name,token,{attempt:welcomed?0:attempt+1,
      joinActive,target:nextTarget}),welcomed?1200:hasAlternate?300:650*(attempt+1));
  }
  connectionTimer=setTimeout(()=>retryConnection(true),hasAlternate?4000:6000);
  socket.onmessage=event=>{
    if(!current())return;
    let message;try{message=JSON.parse(event.data);}catch{return;}
    if(!message||typeof message!=='object')return;
    if(message.type==='welcome'){
      clearTimeout(connectionTimer);connectionTimer=null;welcomed=true;
      seat=message.seat;room=message.room;games=message.games??games;
      checkMatchRoom();
      setRoomUrl(room.name);lastError='';view='room';render();sendProfile();
      if(joinActive&&room.phase==='playing')requestActiveMatch();
      joinActive=false;
      return;}
    if(message.type==='lobby-error'){
      if(['LOBBY_TOKEN_INVALID','LOBBY_TOKEN_EXPIRED'].includes(message.code))rejectToken();
      else toast(message.message||message.code);
      return;
    }
    if(!welcomed)return;
    if(message.type==='state'){room=message.room;checkMatchRoom();
      if(view==='room')renderRoom();return;}
    if(message.type==='session-start'){navigateToGame(message.session);return;}
    if(message.type==='session-ended'){
      clearMatchEntry();
      if(view==='room')renderRoom();
      toast('游戏会话已结束：'+message.reason);return;
    }
  };
  socket.onclose=event=>{
    if(!current())return;
    clearTimeout(connectionTimer);connectionTimer=null;
    if(event.code===4003){rejectToken();return;}
    if(event.code===4001){
      recoverRoom(name,'该席位已在其他标签页使用，请输入密码重新加入。',{discardToken:true});
      return;
    }
    retryConnection();
  };
}
function requestActiveMatch(){
  if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'join-active'}));
}
function clearMatchEntry(){
  matchEntry?.controller?.abort();
  matchEntry=null;
}
function checkMatchRoom(){
  if(matchEntry&&(room?.name!==matchEntry.roomName||room.gameId!==matchEntry.gameId||room.phase==='select'))clearMatchEntry();
}
async function verifyMatchEntry(){
  const entry=matchEntry;
  if(!entry||entry.checking||navigating)return;
  entry.checking=true;
  const controller=new AbortController();
  entry.controller=controller;
  if(view==='room')renderRoom();
  const checkUrl=new URL(entry.settings.path,location.origin);
  for(const delay of [0,350,750]){
    if(delay)await new Promise(resolve=>setTimeout(resolve,delay));
    if(matchEntry!==entry||navigating)return;
    try{
      const response=await fetch(checkUrl,{cache:'no-store',redirect:'error',
        signal:AbortSignal.any([controller.signal,AbortSignal.timeout(3000)])});
      if(!response.ok||response.headers.get(entry.settings.header)!=='1')continue;
      await response.arrayBuffer();
    }catch{continue;}
    if(matchEntry!==entry||navigating)return;
    if(view!=='room'||room?.name!==entry.roomName||ws?.readyState!==WebSocket.OPEN)break;
    matchNavigation=true;
    navigating=true;
    clearMatchEntry();
    location.assign(entry.launch);
    return;
  }
  if(matchEntry!==entry)return;
  entry.checking=false;
  if(view==='room')renderRoom();
}
function navigateToGame(session){
  if(!navigating&&session?.launchUrl){
    let launch;
    try{launch=new URL(session.launchUrl,location.origin);}catch{return;}
    if(!['http:','https:'].includes(launch.protocol)||launch.username||launch.password)return;
    const settings=matchEntries.get(session.gameId);
    if(settings&&launch.origin===location.origin&&launch.pathname===settings.path&&room){
      if(matchEntry?.launch.href!==launch.href){
        clearMatchEntry();
        matchEntry={launch,gameId:session.gameId,roomName:room.name,settings,checking:false};
      }
      void verifyMatchEntry();
      return;
    }
    navigating=true;
    location.assign(launch);
    return;
  }
  if(navigating||!session?.wsUrl||!session?.entryPath)return;navigating=true;
  // external 游戏（坦克动荡）的 entryPath 自带 ?tank=create&code=XXXX&ws=...，
  // 再拼参数必须用 & 续接，否则会变成两个问号，参数全废。
  const [base,existing='']=session.entryPath.split('?');
  const query=new URLSearchParams(existing);
  query.set('room',session.roomName??room?.name??'');
  query.set('game',session.gameId);
  query.set('level',String(session.levelId));
  if(!session.lockstep){
    query.set('ws',session.wsUrl);
    query.set('token',session.token);
  }
  query.set('seat',String(session.seat??seat));
  // 把各席位昵称带进游戏页，游戏内"请求返回选关"等提示才能显示玩家名。
  try{
    const names=seatEntries().map(item=>item.name||'');
    if(names.some(Boolean))query.set('names',names.join('|'));
  }catch{}
  if(session.roomCode)query.set('code',session.roomCode);
  const fragment=session.lockstep?'#'+new URLSearchParams({token:session.token}):'';
  location.href=base+'?'+query.toString()+fragment;
}
function updateProfileDraft(patch){profileDraft={...(profileDraft??{name:randomGuestName(),avatar:'🐟',bg:'#2ecc71'}),...patch};}
app.addEventListener('input',event=>{
  if(event.target.id==='profile-name')updateProfileDraft({name:event.target.value});
  if(event.target.id==='glorton-room-query'){
    glortonRoomQuery=event.target.value;
    glortonProblem('');
  }
  if(event.target.id==='glorton-password'){glortonPassword=event.target.value;glortonProblem('');}
  if(event.target.id==='glorton-room-name'){glortonRoomName=event.target.value;glortonProblem('');}
});
app.addEventListener('submit',event=>{
  if(event.target.id==='chat-form'){event.preventDefault();sendChat();}
  if(event.target.id==='create-form'){event.preventDefault();void submitCreate();}
  if(event.target.id==='glorton-form'){event.preventDefault();void submitGlorton();}
});
app.addEventListener('change',event=>{
  const part=event.target.dataset.outfitPart;
  if(!part||view!=='room'||room?.gameId!=='bomb-it-7'||room.phase!=='select'||room.proposal)return;
  if(ws?.readyState!==WebSocket.OPEN){renderRoom();toast('房间连接中，请连上后再更换装扮。');return;}
  ws.send(JSON.stringify({type:'set-outfit',part,value:Number(event.target.value)}));
});
document.addEventListener('keydown',event=>{
  const modal=Array.from(app.querySelectorAll('.modal-mask [role="dialog"]')).at(-1);
  if(event.key==='Tab'&&modal){
    const controls=Array.from(modal.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]')).filter(node=>node.getClientRects().length);
    const first=controls[0],last=controls.at(-1),active=document.activeElement;
    if(!modal.contains(active)||active===(event.shiftKey?first:last)||!first){
      event.preventDefault();
      (event.shiftKey?last??modal:first??modal).focus();
    }
  }
  if(event.key!=='Escape'||busy)return;
  if(profileOpen){profileOpen=false;render();}
  else if(view!=='auth')return;
  else if(glortonMode)closeGlorton();
  else if(joinTarget){joinTarget=null;joinForm.password='';joinError='';renderAuth();}
  else if(createGameId){createGameId=null;createForm.password='';lastError='';renderAuth();}
});
async function copyInvite(){
  const field=$('.invite-box input');
  if(navigator.clipboard){
    try{await navigator.clipboard.writeText(inviteLink());toast('邀请链接已复制');return;}catch{}
  }
  field?.focus();
  field?.select();
  if(field&&document.execCommand('copy'))toast('邀请链接已复制');
  else toast('请复制已选中的邀请链接。');
}
app.addEventListener('click',event=>{
  const target=event.target.closest('[data-action]');if(!target||target.disabled)return;
  const action=target.dataset.action;
  if(action==='open-glorton'||action==='glorton-host'){openGlorton('host');return;}
  if(action==='glorton-join'){openGlorton('join');return;}
  if(action==='join-glorton-room'){
    const entry=plazaRooms.find(item=>item.gameId===glortonGame.id&&item.key===target.dataset.key);
    if(entry&&(entry.available||readGlortonSeat(entry.code)))openGlorton('join',entry.name);
    return;
  }
  if(action==='close-glorton'){closeGlorton();return;}
  if(action==='check-glorton'){checkGlorton();return;}
  if(action==='home'){if(view==='room'){clearMatchEntry();try{ws?.send(JSON.stringify({type:'leave'}));}catch{}if(room)clearToken(room.name);navigating=true;location.href='/';}else window.scrollTo({top:0,behavior:'smooth'});return;}
  if(action==='verify-lan'){void verifyLan();return;}
  if(action==='switch-lan'){
    if(lanReachability==='reachable'&&!busy)void verifyLan().then(reachable=>{if(reachable)switchLobby(lanOrigin);});
    return;
  }
  if(action==='switch-wan'){switchLobby(wanOrigin);return;}
  if(action==='open-profile'){profileDraft=profile?{...profile}:{name:randomGuestName(),avatar:'🐟',bg:'#2ecc71'};avatarPicker=false;profileOpen=true;render();$('#profile-name')?.focus();return;}
  if(action==='close-profile'){profileOpen=false;avatarPicker=false;render();return;}
  if(action==='toggle-avatars'){avatarPicker=!avatarPicker;render();return;}
  if(action==='pick-avatar'){updateProfileDraft({avatar:target.dataset.avatar});render();return;}
  if(action==='pick-avatar-bg'){updateProfileDraft({bg:target.dataset.bg});render();return;}
  if(action==='random-avatar'){updateProfileDraft({avatar:AVATARS[Math.floor(Math.random()*AVATARS.length)],bg:AVATAR_COLORS[Math.floor(Math.random()*AVATAR_COLORS.length)]});render();return;}
  if(action==='save-profile'){const draft=profileDraft??{};const name=String(draft.name??'').trim()||randomGuestName();
    if(name.length<2||name.length>16){toast('昵称需要 2-16 个字符');return;}
    saveProfile({name,avatar:AVATARS.includes(draft.avatar)?draft.avatar:'🐟',bg:AVATAR_COLORS.includes(draft.bg)?draft.bg:'#2ecc71'});
    if(joinTarget)focusJoin=true;
    profileOpen=false;avatarPicker=false;sendProfile();render();return;}
  if(action==='filter-game'){
    selectedGame=selectedGame===target.dataset.game?null:(target.dataset.game??null);
    for(const card of app.querySelectorAll('[data-action="filter-game"][data-game]'))
      card.setAttribute('aria-pressed',String(card.dataset.game===selectedGame));
    renderPlazaList();
    if(target.dataset.game&&matchMedia('(max-width: 780px)').matches)$('#rooms').scrollIntoView({block:'start'});
    return;
  }
  if(action==='focus-create'||action==='open-create'){
    if(busy)return;
    const choices=listedGames();
    const gameId=target.dataset.game??selectedGame;
    if(gameId===glortonGame.id){openGlorton('host');return;}
    createGameId=choices.find(game=>game.id===gameId)?.id??choices[0]?.id;
    lastError='';renderAuth();
    $('#create-name')?.focus({preventScroll:true});return;
  }
  if(action==='cancel-create'){createGameId=null;createForm.password='';lastError='';renderAuth();return;}
  if(action==='confirm-join'){void submitJoin();return;}
  if(action==='pick-room'||action==='spectate-room'){
    const picked=plazaRooms.find(item=>item.key===target.dataset.key);
    const spectate=action==='spectate-room';
    if(!picked||(spectate&&(!roomsConfirmed||!picked.spectatable)))return;
    joinTarget=spectate?{...picked,spectate:true}:picked;
    joinForm.password='';joinError='';lastError='';focusJoin=true;renderAuth();return;
  }
  if(action==='recent-room'){reenterRecent(target.dataset.room);return;}
  if(action==='retry-room-connection'){if(joinTarget&&!busy)reenterRecent(joinTarget.name);return;}
  if(action==='cancel-room-connection'){
    clearMatchEntry();closeLobbyConnection();joinTarget=null;joinForm.password='';joinError='';lastError='';setRoomUrl('');renderAuth();
    void loadPlaza();return;
  }
  if(action==='cancel-pick'){joinTarget=null;joinForm.password='';joinError='';focusJoin=false;renderAuth();return;}
  if(action==='refresh-plaza'){void refreshLobby(true);return;}
  if(action==='select-game'){if(view==='room'&&room&&!room.boundGameId&&ws?.readyState===WebSocket.OPEN&&room.phase==='select')ws.send(JSON.stringify({type:'select-game',gameId:target.dataset.game}));return;}
  if(action==='level'){if(ws?.readyState!==WebSocket.OPEN||!readyToPlay()||room.phase!=='select'||room.proposal)return;ws.send(JSON.stringify({type:'propose-level',gameId:target.dataset.game,levelId:Number(target.dataset.level)}));return;}
  if(action==='cancel-proposal'){if(room?.proposal&&ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'cancel-proposal',proposalId:room.proposal.id}));return;}
  if(action==='confirm-level'){if(room?.proposal&&ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify({type:'confirm-level',proposalId:room.proposal.id}));return;}
  if(action==='bomb-it-ready'||action==='bomb-it-outfit'||action==='bomb-it-setting'){
    const settings=room?.bombItSettings;
    if(!settings||room.phase!=='select'||ws?.readyState!==WebSocket.OPEN)return;
    if(action==='bomb-it-ready'){
      const ready=!seatEntries().find(item=>item.seat===seat)?.ready;
      ws.send(JSON.stringify({type:'set-bomb-it-ready',ready,revision:settings.revision}));
    }
    if(action==='bomb-it-outfit'){
      const {outfitPart,outfitValue}=target.dataset;
      ws.send(JSON.stringify({type:'set-outfit',part:outfitPart,value:Number(outfitValue)}));
    }
    if(action==='bomb-it-setting'&&settings.hostSeat===seat){
      const {bombItSetting,bombItValue}=target.dataset;
      ws.send(JSON.stringify({type:'set-bomb-it-settings',mapId:settings.mapId,modeId:settings.modeId,
        [bombItSetting]:bombItValue,revision:settings.revision}));
    }
    return;
  }
  if(action==='join-active'||action==='retry-match-entry'){requestActiveMatch();return;}
  if(action==='copy-invite'){void copyInvite();return;}
  if(action==='leave'){clearMatchEntry();try{ws?.send(JSON.stringify({type:'leave'}));}catch{}if(room)clearToken(room.name);navigating=true;location.href='/';return;}
});
window.addEventListener('beforeunload',()=>{navigating=true;clearMatchEntry();closeLobbyConnection();});
window.addEventListener('pageshow',event=>{if(event.persisted&&matchNavigation)location.reload();});
(async()=>{
  const stored=inviteRoom?readToken(inviteRoom):null;
  if(stored?.token)connect(inviteRoom,stored.token);
  else{
    renderAuth();
    await Promise.all([loadGames(),loadPlaza({render:false})]);
    if(view==='auth'&&!busy&&!navigating){
      if(inviteRoom&&!joinTarget){
        const key=roomNameKey(inviteRoom);
        const invited=plazaRooms.find(item=>roomNameKey(item.name)===key)??
          plazaRooms.find(item=>item.gameId===glortonGame.id&&roomNameKey(item.code)===key);
        if(invited?.gameId===glortonGame.id){openGlorton('join',invited.name);}
        else if(invited){joinTarget=invited;focusJoin=true;}
        else if(!lastError){showJoin(inviteRoom);}
      }
      if(glortonMode){
        $('#game-catalog').innerHTML=catalogHtml();
        $('[data-action="open-create"]').disabled=!listedGames().length;
        renderPlazaList();
        renderCatalogStatus();
      }else if(!typingInApp())renderAuth();
    }
  }
  setInterval(()=>void refreshLobby(),6000);
})();
window.addEventListener('online',()=>void refreshLobby(true));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)void refreshLobby();});

// 背景视差：参数与部署包一致（背景 12/10 px、装饰 22/18 px），
// 指针移动只在下一帧写一次自定义属性，减少布局抖动。
{
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  let frame = 0, lastX = 0, lastY = 0;
  document.body.classList.toggle('tab-hidden', document.hidden);
  document.addEventListener('visibilitychange', () => {
    document.body.classList.toggle('tab-hidden', document.hidden);
    if (document.hidden && frame) { cancelAnimationFrame(frame); frame = 0; }
  });
  window.addEventListener('pointermove', (event) => {
    if (reduceMotion.matches || document.hidden || event.pointerType === 'touch') return;
    lastX = event.clientX / innerWidth - .5;
    lastY = event.clientY / innerHeight - .5;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const style = document.documentElement.style;
      style.setProperty('--wall-x', `${lastX * 12}px`);
      style.setProperty('--wall-y', `${lastY * 10}px`);
      style.setProperty('--decor-x', `${lastX * 22}px`);
      style.setProperty('--decor-y', `${lastY * 18}px`);
    });
  }, {passive: true});
}
