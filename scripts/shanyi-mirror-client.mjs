/**
 * Browser-side Shanyi mirror-input client.
 *
 * Each tab runs the original Flash package under Ruffle. Keys and menu clicks
 * are injected locally and relayed to the other seat. Seat P1 drives the fire
 * hero (WASD), seat P2 drives the water hero (arrow keys). Experimental: there
 * is no authoritative simulation, snapshot or video stream.
 */
// 席位上限与 server/game-adapter.mjs 的 MAX_SEATS 保持一致（1–4）。
const MAX_SEATS=4;
const config=window.__SHANYI_CONFIG__;
if(!config?.wrapperUrl||!config?.coreUrl)throw Error('缺少闪翼双星运行配置');
const query=new URLSearchParams(location.search);
const loopbackNames=new Set(['127.0.0.1','localhost','::1']);
function reachableWs(raw,fallback){
  if(typeof raw!=='string'||!/^wss?:\/\//.test(raw))return fallback??'';
  try{
    const url=new URL(raw);
    if(loopbackNames.has(url.hostname)&&!loopbackNames.has(location.hostname))
      url.hostname=location.hostname;
    return url.href;
  }catch{return fallback??'';}
}
const configWs=typeof config.wsUrl==='string'?reachableWs(config.wsUrl,null):null;
const wsUrl=reachableWs(query.get('ws'),configWs)||configWs||'';
const token=query.get('token')??null;
const roomName=query.get('room')??config.roomName??'';
// 席位续租票：刷新/断线后带回来坐回原席位，服务端保留 20 秒。
const resumeKey='shanyi-resume:'+location.pathname+location.search;
let resumeToken=(()=>{try{return sessionStorage.getItem(resumeKey);}catch{return null;}})();
let resumeDeadline=0,resumeAttempt=0;
const seatParam=query.get('seat');
// Seat index is a platform concept (P1..P4); the game itself still has two heroes.
const parsedSeat=seatParam!==null&&/^\d{1,2}$/.test(seatParam)?Number(seatParam):null;
const expectedSeat=parsedSeat!==null&&parsedSeat>=0&&parsedSeat<MAX_SEATS?parsedSeat:null;
// 大厅通过 ?names= 传入各席位昵称（按席位序号，空位留空），用于提示"谁请求了什么"。
const seatNames=(()=>{
  const raw=query.get('names');
  if(typeof raw!=='string'||!raw)return [];
  return raw.split('|').map(value=>value.trim());
})();
if(!/^ws:\/\/[A-Za-z0-9._-]+:\d+\/ws$/.test(wsUrl))throw Error('联机地址无效，请从房间大厅进入');
const statusEl=document.getElementById('shanyi-status');
const roomEl=document.getElementById('shanyi-room');
const peerEl=document.getElementById('shanyi-peer');
const backButton=document.getElementById('shanyi-back');
const gate=document.getElementById('shanyi-gate');
const gateText=document.getElementById('shanyi-gate-text');
// 加载条换成缤纷嘉年华星星组件；实例就绪前先把状态记下来。
const gateMount=document.getElementById('shanyi-gate-loader');
let gateLoader=null,gateView=null;
import('/loader/carnival-loader.mjs')
  .then(module=>module.createCarnivalLoader(gateMount,{layout:'inline',compact:true}))
  .then(instance=>{gateLoader=instance;if(gateView)instance.show(gateView);})
  .catch(()=>{});
function gateShow(title,detail,percent){
  gateView={phase:'running',stage:'initialize',title,detail,percent};
  gateLoader?.show(gateView);
}
// 原版 SWF 没有可读的加载进度：按阶段推进，数字只向前，等真正就绪再补满。
let gateShown=8,gateTarget=8;
gateShow('正在加载游戏', '正在等待 Ruffle 运行时。', gateShown);
const gateCreep=setInterval(()=>{
  if(localBooted||closed){clearInterval(gateCreep);return;}
  gateTarget=Math.min(90,gateTarget+1.4);
  gateShow('正在加载游戏', '正在等待 Ruffle 运行时。', gateTarget);
},520);
const FIRE_KEYS=new Set([87,83,65,68]);
const ICE_KEYS=new Set([38,40,37,39]);
const CONTROL_KEYS=new Set([...FIRE_KEYS,...ICE_KEYS]);
const TOUCH_KEYS={KeyW:[87,38],KeyS:[83,40],KeyA:[65,37],KeyD:[68,39]};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let seat=expectedSeat,player=null,call=null,canvas=null,ws=null;
let peerConnected=false,peerPage='',localPage='',closed=false;
let heroStateBusy=false,bothReady=false,localBooted=false,readySent=false;
const pressed=new Set();
const keyboardPressed=new Set(),touchPressed=new Set(),peerPressed=new Set();
let touchControls=null;
const gameCenter=document.getElementById('game-center');
if(gameCenter&&matchMedia('(any-pointer: coarse)').matches){
  void import('/__research__/touch.mjs').then(({mountTouchControls})=>{
    touchControls=mountTouchControls(gameCenter,'shanyi',codes=>{
      touchPressed.clear();
      if(bothReady)for(const code of codes){
        const mapped=TOUCH_KEYS[code]?.[seat];
        if(mapped!==undefined)touchPressed.add(mapped);
      }
      syncControls();
    });
  }).catch(()=>{});
}

if(roomEl)roomEl.textContent=roomName?('房间：'+roomName):'';
if(backButton)backButton.addEventListener('click',()=>{
  if(!bothReady){if(statusEl)statusEl.textContent='请等待所有玩家都进入游戏后再返回大厅';return;}
  if(ws?.readyState===WebSocket.OPEN){
    ws.send(JSON.stringify({type:'return.request'}));
    if(statusEl)statusEl.textContent='已请求返回大厅，等待其他玩家确认…';
  }
});
window.addEventListener('beforeunload',()=>{clearControls();closed=true;try{ws?.close();}catch{}});

// 席位标签用 P1/P2；"火男/水女"是闪翼双星自己的角色名，只在括号里说明操作键。
const seatLabel=value=>Number.isInteger(value)?'P'+(value+1):'未分配';
// 投票/提示里优先用玩家自己设置的昵称，退回席位标签。
const playerName=value=>Number.isInteger(value)&&seatNames[value]?seatNames[value]:seatLabel(value);
// 闪翼双星只有两个英雄，所以席位到英雄的映射是 0↔1；这不是房间容量假设，
// 而是这款游戏自身的角色数量。其他游戏由各自的 adapter 决定席位如何映射。
const heroIndex=value=>value===0?0:value===1?1:null;
const peerHeroIndex=value=>value===0?1:value===1?0:null;
const heroName=value=>value===1?'水女（方向键）':value===0?'火男（WASD）':null;
const roleName=()=>{
  const hero=heroName(seat??expectedSeat);
  const label=Number.isInteger(seat??expectedSeat)?seatLabel(seat??expectedSeat):'正在分配席位';
  return hero?label+' · '+hero:label;
};
function renderStatus(){
  if(!statusEl)return;
  const mirror=peerConnected?'其他玩家已连接':'等待其他玩家连接';
  const peerInfo=peerPage?(' · 其他玩家页面：'+peerPage.split('::').pop()):'';
  statusEl.textContent='你控制 '+roleName()+' · '+mirror+peerInfo;
  if(peerEl)peerEl.textContent=localPage?('本页：'+localPage.split('::').pop()):'';
}
function renderGate(){
  if(!gate)return;
  gate.hidden=bothReady;
  if(gateText)
    gateText.textContent=bothReady?'':(localBooted?'等待其他玩家进入游戏…':'正在加载游戏与对手状态…');
  if(!bothReady) gateShow(
    localBooted?'等待玩家就位':'正在加载游戏',
    localBooted?'本机游戏已就绪，正在等其他玩家进入。':'正在等待 Ruffle 运行时与对手状态。',
    localBooted?100:Math.max(8,gateTarget),
  );
}
function sendReady(){
  if(!localBooted||readySent||ws?.readyState!==WebSocket.OPEN)return;
  readySent=true;
  ws.send(JSON.stringify({type:'ready'}));
}
function myKeys(){
  const active=seat??expectedSeat;
  if(active===1)return ICE_KEYS;
  if(active===0)return FIRE_KEYS;
  return new Set();
}
function inject(name,...args){
  if(!call)return null;
  try{return call(name,...args);}catch{return null;}
}
async function queryPage(){
  if(!call)return null;
  try{
    const value=await call('shanyiPage');
    return typeof value==='string'?value:null;
  }catch{return null;}
}
function publishHeroState(){
  if(heroStateBusy||!bothReady||!call||seat===null||seat===undefined)return;
  const hero=heroIndex(seat);
  if(hero===null)return;
  heroStateBusy=true;
  Promise.resolve(call('shanyiHeroState',hero)).then(raw=>{
    if(typeof raw!=='string'||raw==='none'||raw.startsWith('no-')||raw.startsWith('error:'))return;
    const [x,y,vx,vy]=raw.split(',').map(Number);
    if([x,y,vx,vy].every(Number.isFinite))relay({type:'hero-state',x,y,vx,vy});
  }).catch(()=>{}).finally(()=>{heroStateBusy=false;});
}
function injectKey(code,down){
  inject('shanyiKey',code,down);
}
// 输入按 16ms 一帧成批应用：两端都只在帧边界吃边沿，同一帧内的按键顺序固定
// （P1 先、P2 后），避免「一边已按下、一边还在上一帧」的错位造成机关/跳跃分叉。
let pendingLocalEdges=[];
let pendingPeerEdges=[];
function syncControls(){
  const active=new Set([...keyboardPressed,...touchPressed]);
  for(const code of pressed){
    if(active.has(code))continue;
    pressed.delete(code);pendingLocalEdges.push({code,down:false});
  }
  for(const code of active){
    if(pressed.has(code))continue;
    pressed.add(code);pendingLocalEdges.push({code,down:true});
  }
}
function applyEdge(edge,fromPeer){
  if(fromPeer){
    if(edge.down)peerPressed.add(edge.code);
    else peerPressed.delete(edge.code);
  }
  injectKey(edge.code,edge.down);
}
function flushInputTick(){
  if(!bothReady){
    pendingLocalEdges.length=0;pendingPeerEdges.length=0;
    return;
  }
  if(!pendingLocalEdges.length&&!pendingPeerEdges.length)return;
  const own=pendingLocalEdges;pendingLocalEdges=[];
  const peer=pendingPeerEdges;pendingPeerEdges=[];
  if((seat??expectedSeat)===0){
    for(const edge of own)applyEdge(edge,false);
    for(const edge of peer)applyEdge(edge,true);
  }else{
    for(const edge of peer)applyEdge(edge,true);
    for(const edge of own)applyEdge(edge,false);
  }
  if(own.length)relay({type:'input-batch',edges:own});
}
setInterval(flushInputTick,16);
function clearControls(){
  keyboardPressed.clear();touchPressed.clear();touchControls?.clear();
  syncControls();
}
function setBothReady(ready){
  const wasReady=bothReady;
  bothReady=ready;
  if(!ready||!wasReady)clearControls();
  if(!ready){
    for(const code of peerPressed)injectKey(code,false);
    peerPressed.clear();
  }
  renderGate();
}
function injectClick(x,y){
  inject('shanyiClickAt',x,y);
}

function attachCanvas(){
  if(!player||canvas)return;
  const container=player.shadowRoot?.getElementById?.('container');
  const found=container?.querySelector?.('canvas');
  if(!found)return;
  canvas=found;
  canvas.addEventListener('pointerup',event=>{
    if(!call||!bothReady)return;
    const rect=canvas.getBoundingClientRect();
    const width=player.metadata?.width||800;
    const height=player.metadata?.height||600;
    const x=((event.clientX-rect.left)*width)/Math.max(1,rect.width);
    const y=((event.clientY-rect.top)*height)/Math.max(1,rect.height);
    injectClick(x,y);
    relay({type:'click',x,y});
  });
}

async function bootRuffle(){
  const ruffle=window.RufflePlayer?.newest?.();
  if(!ruffle)throw Error('Ruffle 运行时未加载');
  gateProgressTo(46);
  player=ruffle.createPlayer();
  player.style.width='100%';
  player.style.height='100%';
  player.style.display='block';
  document.getElementById('player')?.appendChild(player);
  player.config={
    autoplay:'on',unmuteOverlay:'hidden',allowScriptAccess:true,
    letterbox:'on',scale:'showAll',logLevel:'warn',maxExecutionDuration:600,
  };
  player.addEventListener('loadedmetadata',attachCanvas);
  await player.load({url:config.wrapperUrl,parameters:{game:config.coreUrl}});
  const instance=player.ruffle?.();
  if(!instance?.callExternalInterface)throw Error('Ruffle ExternalInterface 不可用');
  call=(name,...args)=>instance.callExternalInterface(name,...args);
  window.__shanyi={player,instance,call,queryPage:()=>queryPage()};
  localBooted=true;
  gateProgressTo(100);
  sendReady();
  renderGate();
  for(let attempt=0;attempt<120;attempt++){
    const page=await queryPage();
    if(page){localPage=page;break;}
    attachCanvas();
    await delay(250);
  }
  attachCanvas();
  if(statusEl)statusEl.textContent='Ruffle 已启动，等待其他玩家连接…';
  renderStatus();
}

function relay(message){
  if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(message));
}

function connect(){
  if(closed)return;
  try{ws?.close();}catch{}
  const target=new URL(wsUrl);
  if(token)target.searchParams.set('token',token);
  if(seat!==null&&seat!==undefined)target.searchParams.set('seat',String(seat));
  if(resumeToken)target.searchParams.set('resume',resumeToken);
  ws=new WebSocket(target.href);
  ws.onopen=()=>{readySent=false;renderStatus();sendReady();};
  ws.onmessage=event=>{
    let message;
    try{message=JSON.parse(event.data);}catch{return;}
    if(message.type==='welcome'){
      if(seat===null||seat===undefined)seat=message.seat;
      if(typeof message.resumeToken==='string'){
        resumeToken=message.resumeToken;
        resumeDeadline=0;resumeAttempt=0;
        try{sessionStorage.setItem(resumeKey,resumeToken);}catch{}
      }
      peerConnected=message.peerConnected===true;
      setBothReady(message.bothReady===true);
      renderStatus();
      if(message.resumed&&statusEl)
        statusEl.textContent='已恢复原席位 '+seatLabel(seat)+'，等待其他玩家…';
      return;
    }
    if(message.type==='ready-state'){
      setBothReady(message.bothReady===true);return;
    }
    if(message.type==='peer-connection'){
      peerConnected=message.connected===true;
      if(!peerConnected)setBothReady(false);
      renderStatus();return;
    }
    if(message.type==='peer-input'){
      const {code,down}=message;
      if(!bothReady||!CONTROL_KEYS.has(code)||typeof down!=='boolean')return;
      pendingPeerEdges.push({code,down});
      return;
    }
    if(message.type==='peer-input-batch'){
      if(!bothReady||!Array.isArray(message.edges))return;
      for(const edge of message.edges.slice(0,16)){
        if(!edge||!CONTROL_KEYS.has(edge.code)||typeof edge.down!=='boolean')continue;
        pendingPeerEdges.push({code:edge.code,down:edge.down});
      }
      return;
    }
    if(message.type==='peer-click'){
      if(!bothReady)return;
      if(Number.isFinite(message.x)&&Number.isFinite(message.y))
        injectClick(message.x,message.y);
      return;
    }
    if(message.type==='peer-hero-state'){
      if(!bothReady||seat===null||seat===undefined)return;
      // Different page/area coordinates use different local camera spaces;
      // applying them would drag the peer body and camera into empty space.
      if(localPage&&peerPage&&localPage!==peerPage)return;
      const x=Number(message.x),y=Number(message.y);
      const vx=Number(message.vx),vy=Number(message.vy);
      if([x,y,vx,vy].every(Number.isFinite)){
        const peerHero=peerHeroIndex(seat);
        if(peerHero!==null)inject('shanyiApplyHero',peerHero,x,y,vx,vy);
      }
      return;
    }
    if(message.type==='peer-presence'){
      peerPage=typeof message.page==='string'?message.page:'';
      renderStatus();return;
    }
    if(message.type==='return-request'){
      if(message.requestedBy!==seat){
        const agreed=window.confirm(playerName(message.requestedBy)+' 请求返回大厅，是否同意？');
        if(ws?.readyState===WebSocket.OPEN)
          ws.send(JSON.stringify({type:agreed?'return.confirm':'return.cancel'}));
        if(statusEl)statusEl.textContent=agreed?'已同意返回，等待所有玩家确认…':'已取消返回请求，继续游戏';
      }
      return;
    }
    if(message.type==='return-state'){
      if(statusEl)statusEl.textContent='返回大厅投票：'+(message.votes??0)+'/'+(message.capacity??2);
      return;
    }
    if(message.type==='return-approved'){
      closed=true;try{ws?.close();}catch{}
      location.href='/?room='+encodeURIComponent(roomName);
      return;
    }
    if(message.type==='return-cancelled'){
      if(statusEl)statusEl.textContent='返回请求已取消，继续游戏';
      return;
    }
    if(message.type==='mirror-error'&&statusEl)
      statusEl.textContent='房间提示：'+(message.message||message.code);
  };
  ws.onclose=()=>{
    peerConnected=false;setBothReady(false);readySent=false;
    renderStatus();
    if(closed)return;
    // 服务端保留席位 20 秒：在这之内带票重连就能坐回原位，超时才提示返回大厅。
    if(!resumeDeadline)resumeDeadline=Date.now()+20_000;
    if(Date.now()>=resumeDeadline){
      if(statusEl)statusEl.textContent='与房间的连接已断开，席位已释放，请返回大厅重新进入。';
      return;
    }
    resumeAttempt++;
    const wait=Math.min(3000,600*resumeAttempt);
    if(statusEl)statusEl.textContent='连接中断，正在恢复原席位…（'+Math.ceil((resumeDeadline-Date.now())/1000)+' 秒）';
    setTimeout(connect,wait);
  };
  ws.onerror=()=>{};
}

window.addEventListener('keydown',event=>{
  if(!CONTROL_KEYS.has(event.keyCode))return;
  event.preventDefault();
  event.stopPropagation();
  if(!bothReady||!myKeys().has(event.keyCode)||keyboardPressed.has(event.keyCode))return;
  keyboardPressed.add(event.keyCode);
  syncControls();
},true);
window.addEventListener('keyup',event=>{
  if(!CONTROL_KEYS.has(event.keyCode))return;
  event.preventDefault();
  event.stopPropagation();
  if(keyboardPressed.delete(event.keyCode))syncControls();
},true);
window.addEventListener('blur',clearControls);
window.addEventListener('pagehide',clearControls);
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearControls();});

(async()=>{
  connect();
  try{
    await bootRuffle();
  }catch(error){
    if(statusEl)statusEl.textContent='闪翼双星启动失败：'+String(error.message??error);
    if(gateText)gateText.textContent='游戏加载失败：'+String(error.message??error);
    clearInterval(gateCreep);
    gateLoader?.show({phase:'error',stage:'initialize',title:'游戏加载失败',detail:String(error.message??error)});
    return;
  }
  setInterval(async()=>{
    const page=await queryPage();
    if(page){
      localPage=page;
      relay({type:'presence',page});
    }
    renderStatus();
  },2500);
  setInterval(publishHeroState,30);
  setInterval(()=>relay({type:'ping',id:Date.now()}),10000);
})();
