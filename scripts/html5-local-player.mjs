/** Browser-side local two-tab launch. Authored UI; never runs game physics rules. */
// 席位上限与 server/game-adapter.mjs 的 MAX_SEATS 保持一致（1–4）。
const MAX_SEATS=4;
const configNode=document.getElementById('research-player-config');
const output=document.getElementById('research-player-status');
const roomLine=document.getElementById('research-player-room');
const restart=document.getElementById('research-player-restart');
const advance=document.getElementById('research-player-next');
const vote=document.getElementById('research-vote');
const voteTitle=document.getElementById('research-vote-title');
const voteText=document.getElementById('research-vote-text');
const voteConfirm=document.getElementById('research-vote-confirm');
const voteCancel=document.getElementById('research-vote-cancel');
const returnStart=document.getElementById('research-player-return');
const returnVote=document.getElementById('research-return-vote');
const returnTitle=document.getElementById('research-return-title');
const returnText=document.getElementById('research-return-text');
const returnConfirm=document.getElementById('research-return-confirm');
const returnCancel=document.getElementById('research-return-cancel');
if(!configNode||!output||!restart||!advance||!vote||!voteTitle||!voteText||!voteConfirm||!voteCancel||
   !returnStart||!returnVote||!returnTitle||!returnText||!returnConfirm||!returnCancel)
  throw Error('Local player UI is incomplete');
const config=JSON.parse(configNode.textContent);
const query=new URLSearchParams(location.search);
const loopbackNames=new Set(['127.0.0.1','localhost','::1']);
function reachableWs(raw,fallback){
  if(typeof raw!=='string'||!/^wss?:\/\//.test(raw))return fallback??'';
  try{
    const url=new URL(raw);
    // Old session URLs embedded 127.0.0.1. On a LAN client that points at
    // the client itself, so rewrite to the host used to open this page.
    if(loopbackNames.has(url.hostname)&&!loopbackNames.has(location.hostname))
      url.hostname=location.hostname;
    return url.href;
  }catch{return fallback??'';}
}
const configWs=typeof config.wsUrl==='string'?reachableWs(config.wsUrl,null):null;
const queryWs=reachableWs(query.get('ws'),configWs);
const wsUrl=queryWs||configWs||'';
const token=query.get('token')??config.token??null;
const roomName=query.get('room')??config.roomName??null;
const levelId=Number(query.get('level')??config.levelId);
const seatParam=query.get('seat');
const parsedSeat=seatParam!==null&&/^\d{1,2}$/.test(seatParam)?Number(seatParam):null;
const expectedSeat=parsedSeat!==null&&parsedSeat>=0&&parsedSeat<MAX_SEATS?parsedSeat:null;
const templeId=config.templeId??'forest';
if(!/^ws:\/\/[A-Za-z0-9._-]+:\d+\/ws$/.test(wsUrl))
  throw Error('联机地址无效，请从房间大厅进入');
if(!Number.isInteger(levelId)||levelId<0)
  throw Error('关卡参数无效，请从房间大厅进入');
if(!/^[a-z][a-z-]{1,31}$/.test(templeId))throw Error('神殿参数无效');
if(roomLine)roomLine.textContent=roomName?('房间：'+roomName):'';
const lobbyTarget=roomName?('/?room='+encodeURIComponent(roomName)):'/';
const lobbyButton=document.getElementById('research-player-lobby');
if(lobbyButton)lobbyButton.href=lobbyTarget;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,limit=45000){
  const end=Date.now()+limit;
  while(Date.now()<end){
    if(predicate())return true;
    await delay(45);
  }
  throw Error('Native game menu/level did not initialize');
}
let player=null,touchControls=null,voteKind=null,dismissedKey=null,ownVoteKey=null,lastLifecycleKey=null;
let returnMode=null,navigating=false;
const gameCenter=document.getElementById('game-center');
if(gameCenter&&matchMedia('(any-pointer: coarse)').matches){
  void import('/__research__/touch.mjs').then(({mountTouchControls})=>{
    touchControls=mountTouchControls(gameCenter,'temple',keys=>player?.setTouchInput(keys));
  }).catch(()=>{});
}
// 席位标签是平台概念：P1/P2/P3/P4；游戏内角色名由游戏自己决定。
const seatLabel=seat=>Number.isInteger(seat)?'P'+(seat+1):'未分配';
// 大厅通过 ?names= 传入各席位昵称（按席位序号，空位留空），用于投票提示。
const seatNames=(()=>{
  const raw=query.get('names');
  if(typeof raw!=='string'||!raw)return [];
  return raw.split('|').map(value=>value.trim());
})();
const playerName=seat=>{
  if(Number.isInteger(seat)&&seatNames[seat])return seatNames[seat];
  return seatLabel(seat);
};
const SEAT_COLORS=['#e67e22','#3498db','#9b59b6','#16a085'];
const escHtml=value=>String(value??'').replace(/[&<>"']/g,ch=>
  ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const seatList=document.getElementById('research-player-seats');
// 左栏席位条按房间容量渲染 P1..Pn；有昵称时显示昵称，否则只显示席位号。
function renderSeats(status){
  if(!seatList)return;
  const room=status?.room;
  const seats=Array.isArray(room?.seats)&&room.seats.length
    ? room.seats
    : Array.from({length:seatCount(status)},(_,index)=>({
        seat:index,label:seatLabel(index),occupied:false,connected:false,name:null}));
  seatList.innerHTML=seats.map(item=>{
    const label=item.label||seatLabel(item.seat);
    const name=item.name||seatNames[item.seat]||label;
    const mine=item.seat===status?.seat;
    const color=SEAT_COLORS[item.seat%SEAT_COLORS.length];
    const online=item.connected??item.occupied;
    return '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:999px;'+
      'background:'+(online?'rgba(46,204,113,.22)':'rgba(255,255,255,.08)')+';border:1px solid '+color+
      ';color:#fff;font-size:10px">'+escHtml(name)+(mine?'（你）':'')+'</span>';
  }).join('');
}
const role=()=>{
  const seat=player?.status?.().seat;
  return Number.isInteger(seat)?seatLabel(seat):'正在分配席位';
};
function lifecycleKey(status){
  const reason=status.lifecycle?.reason??status.room?.suspendedReason??null;
  return reason?reason+':'+(status.lifecycle?.levelEpoch??status.roundNumber):null;
}
function isWin(status){
  return (status.lifecycle?.reason??status.room?.suspendedReason)==='LEVEL_WON';
}
function isDeath(status){
  const reason=status.lifecycle?.reason??status.room?.suspendedReason;
  return reason==='CHARACTER_DEAD'||reason==='CHARACTER_DYING';
}
function showVote(kind,status){
  voteKind=kind;
  vote.hidden=false;vote.style.display='flex';
  const reason=status.lifecycle?.reason??status.room?.suspendedReason;
  const restartBy=status.room?.restartRequestedBy;
  if(kind==='advance'){
    voteTitle.textContent='通关！';
    voteText.textContent='所有玩家确认后进入下一关；取消则留在当前关卡。';
    voteConfirm.textContent='确定进入下一关';
  }else{
    voteTitle.textContent=reason==='CHARACTER_DEAD'||reason==='CHARACTER_DYING'?'角色死亡':'关卡结束';
    if(restartBy!==null&&restartBy!==undefined)
      voteTitle.textContent=restartBy===status.seat?'等待其他玩家确认重开':playerName(restartBy)+' 请求重开';
    voteText.textContent='所有玩家确认后重开当前关卡；取消后关卡保持暂停，可再次发起重开。';
    voteConfirm.textContent='确定重开';
  }
  voteCancel.hidden=false;voteCancel.style.display='';
  voteConfirm.disabled=false;
  ownVoteKey=null;
}
function closeVote(){
  vote.hidden=true;vote.style.display='none';voteKind=null;
}
function openReturnVote(mode){
  returnMode=mode;
  returnVote.hidden=false;returnVote.style.display='flex';
}
function closeReturnVote(){
  returnVote.hidden=true;returnVote.style.display='none';returnMode=null;
}
function goToLobby(){
  if(navigating)return;
  navigating=true;
  closeVote();closeReturnVote();
  output.textContent='正在返回选关…';
  location.assign(lobbyTarget);
}
// 投票分母来自房间真实席位数量，不再是写死的 2。
const seatCount=status=>{
  const room=status?.room;
  if(Number.isInteger(room?.capacity)&&room.capacity>0)return room.capacity;
  if(Array.isArray(room?.connected)&&room.connected.length)return room.connected.length;
  return 2;
};
const voteFraction=(status,votes)=>votes+'/'+seatCount(status);
function renderReturnVote(status){
  if(status.returning||status.room?.returnApproved===true){goToLobby();return;}
  const requestedBy=status.room?.returnRequestedBy;
  if(requestedBy===null||requestedBy===undefined){
    if(returnMode!==null)closeReturnVote();
    return;
  }
  const votes=status.room?.returnVotes??0;
  if(requestedBy===status.seat){
    openReturnVote('wait');
    returnTitle.textContent='等待其他玩家确认';
    returnText.textContent='你已请求返回选关，等待其他玩家确认…（当前 '+voteFraction(status,votes)+'）';
    returnConfirm.hidden=true;returnConfirm.disabled=true;
    returnCancel.hidden=false;returnCancel.disabled=false;returnCancel.textContent='取消请求';
  }else{
    openReturnVote('confirm');
    returnTitle.textContent=playerName(requestedBy)+' 请求返回选关';
    returnText.textContent='所有玩家确认后一起回到选关界面；取消则继续游戏。（当前 '+voteFraction(status,votes)+'）';
    returnConfirm.hidden=false;returnConfirm.disabled=false;
    returnCancel.hidden=false;returnCancel.disabled=false;returnCancel.textContent='继续游戏';
  }
}
function updateVote(status){
  if(!voteKind)return;
  const votes=status.room?.restartVotes??0;
  const pending=status.room?.restartPending===true;
  const restartBy=status.room?.restartRequestedBy;
  if(voteKind==='restart'&&restartBy!==null&&restartBy!==undefined&&!pending)
    voteTitle.textContent=restartBy===status.seat?'等待其他玩家确认重开':playerName(restartBy)+' 请求重开';
  if(pending){
    voteText.textContent='所有玩家已确认，正在重建原生关卡…';
    voteConfirm.disabled=true;voteCancel.hidden=true;
    return;
  }
  if(ownVoteKey===lifecycleKey(status)){
    voteText.textContent='你已确认，等待其他玩家确认…（当前 '+voteFraction(status,votes)+'）';
    voteConfirm.disabled=true;voteCancel.hidden=true;
    return;
  }
  if(votes>0){
    voteText.textContent='其他玩家已确认，等待你确认。（当前 '+voteFraction(status,votes)+'）';
  }
}
function renderStatus(status){
  if(!status.room?.bothReady||status.room.effectivePaused||status.readyState!==WebSocket.OPEN||
     status.lifecycle||status.resetting||status.returning){
    touchControls?.clear();
  }
  const phaseRoom=status.room;
  let phase='连接房间中';
  if(status.lastError)phase='错误：'+status.lastError;
  else if(status.resetting)phase='原生关卡重建中';
  else if(status.lifecycle||phaseRoom?.suspendedReason)
    phase='关卡结束：'+(status.lifecycle?.reason??phaseRoom.suspendedReason);
  else if(phaseRoom?.effectivePaused)phase=phaseRoom?.bothReady?'房间暂停':'等待其他玩家';
  else if(phaseRoom?.bothReady)phase='正在游戏';
  output.textContent=role()+' · 第 '+String((status.roundNumber??0)+1)+' 轮 · '+phase;
  renderSeats(status);
  const suspended=status.lifecycle?.reason??phaseRoom?.suspendedReason??null;
  restart.disabled=!suspended||status.resetting||isDeath(status);
  advance.disabled=suspended!=='LEVEL_WON'||status.resetting;
  returnStart.disabled=!phaseRoom||status.resetting||status.returning||
    phaseRoom.returnApproved===true;
  renderReturnVote(status);
  const key=lifecycleKey(status);
  if(isDeath(status)){
    // Death is a short native rebuild, not a two-player decision. Keep the
    // sidebar informative and let the authority schedule the automatic retry.
    if(voteKind)closeVote();
    lastLifecycleKey=key;
    output.textContent=role()+' · 第 '+String((status.roundNumber??0)+1)+' 轮 · 角色死亡，正在自动重开…';
  }else if(suspended&&status.seat!==null&&status.seat!==undefined){
    if(key&&key!==lastLifecycleKey){
      lastLifecycleKey=key;
      if(key!==dismissedKey)showVote(suspended==='LEVEL_WON'?'advance':'restart',status);
    }
  }else if(!suspended){
    lastLifecycleKey=null;
    if(voteKind)closeVote();
  }
  updateVote(status);
}
voteConfirm.addEventListener('click',()=>{
  if(!player||!voteKind)return;
  const status=player.status();
  ownVoteKey=lifecycleKey(status);
  const sent=voteKind==='advance'?player.requestAdvance():player.requestRestart();
  if(!sent){
    ownVoteKey=null;
    voteText.textContent='无法提交投票，请确认房间仍处于结束/暂停状态。';
    return;
  }
  voteConfirm.disabled=true;voteCancel.hidden=true;
  voteText.textContent='已提交，等待其他玩家确认…';
});
voteCancel.addEventListener('click',()=>{
  dismissedKey=lifecycleKey(player?.status?.()??{});
  closeVote();
});
restart.addEventListener('click',()=>{
  if(!player)return;
  const status=player.status();
  showVote(isWin(status)?'advance':'restart',status);
});
advance.addEventListener('click',()=>{
  if(!player)return;
  showVote('advance',player.status());
});
returnStart.addEventListener('click',()=>{
  if(!player)return;
  const status=player.status();
  const requestedBy=status.room?.returnRequestedBy;
  if(requestedBy!==null&&requestedBy!==undefined){renderReturnVote(status);return;}
  const sent=player.requestReturn();
  if(!sent){output.textContent='无法发起返回投票，请确认大厅连接仍然正常。';return;}
  output.textContent='已请求返回选关，等待其他玩家确认…';
});
returnConfirm.addEventListener('click',()=>{
  if(!player||returnMode!=='confirm')return;
  returnConfirm.disabled=true;
  returnText.textContent='已确认，等待所有玩家一起返回…';
  if(!player.confirmReturn())returnConfirm.disabled=false;
});
returnCancel.addEventListener('click',()=>{
  if(!player)return;
  if(player.cancelReturn()){
    closeReturnVote();
    output.textContent='已取消返回选关，继续游戏。';
  }
});
try{
  await until(()=>window.__game?.state?.current==='menu',60000);
  const game=window.__game;
  const temple=game.progress?.get('temples')?.find(x=>x.id===templeId);
  if(!temple)throw Error('Original temple menu unavailable: '+templeId);
  game.state.states[game.state.current].startTemple(temple);
  await until(()=>game.state.current==='levelMenu'&&!game.state.fading&&
    game.state.states.levelMenu.buttons);
  const menu=game.state.states.levelMenu;
  const target=menu.templeData.levels.find(x=>Number(x.id)===levelId);
  if(!target||!(target.state>0))throw Error('Requested official level is locked or absent');
  menu.startLevel({data:target});
  await until(()=>game.state.current==='level'&&game.level?.levelStarted&&
    game.level.pers1?.body&&game.level.pers2?.body&&
    !game.paused&&!game.physics.box2d.paused&&!game.state.fading);
  const {connectHtml5Spectator}=await import('/adapters/fireboy-html5/spectator-client.mjs');
  const wsTarget=new URL(wsUrl);
  if(token)wsTarget.searchParams.set('token',token);
  if(expectedSeat!==null)wsTarget.searchParams.set('seat',String(expectedSeat));
  // 席位续租票：服务端保留 20 秒，刷新后带回去坐回原席位。
  const resumeKey='fb-resume:'+location.pathname+location.search;
  let resumeTicket=null;
  try{resumeTicket=sessionStorage.getItem(resumeKey);}catch{}
  if(resumeTicket)wsTarget.searchParams.set('resume',resumeTicket);
  player=connectHtml5Spectator({game,wsUrl:wsTarget.href,devices:window.Devices,
    smooth:config.smooth!==false,smoothingMs:55,resumeKey,
    expectedSeat,expectedServedSha256:config.servedSha256??null,expectedLevelId:levelId});
  window.__localHtml5Player=player;
  const unsubscribe=player.onStatus(renderStatus);
  renderStatus(player.status());
  window.addEventListener('pagehide',()=>{unsubscribe();player.close();},{once:true});
}catch(error){
  output.textContent='本地联机启动失败：'+error.message;
  restart.disabled=true;
  advance.disabled=true;
  console.error('HTML5_LOCAL_PLAYER_FAILED',error);
}
