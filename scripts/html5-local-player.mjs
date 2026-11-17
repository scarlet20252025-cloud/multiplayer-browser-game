/** Browser-side local two-tab launch. Authored UI; never runs game physics rules. */
const configNode=document.getElementById('research-player-config');
const output=document.getElementById('research-player-status');
const restart=document.getElementById('research-player-restart');
if(!configNode||!output||!restart)throw Error('Local player UI is incomplete');
const config=JSON.parse(configNode.textContent);
if(typeof config.wsUrl!=='string'||!/^ws:\/\/127\.0\.0\.1:\d+\/ws$/.test(config.wsUrl)||
   !Number.isSafeInteger(config.levelId)||config.levelId<1)
  throw Error('Invalid local loopback room configuration');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,limit=45000){
  const end=Date.now()+limit;
  while(Date.now()<end){
    if(predicate())return true;
    await delay(45);
  }
  throw Error('Native game menu/level did not initialize');
}
let player;
function renderStatus(status){
  const seat=status.seat;
  const role=seat===0?'火娃':seat===1?'水娃':'正在分配角色';
  const room=status.room;
  let phase='连接房间中';
  if(status.lastError)phase='错误：'+status.lastError;
  else if(status.resetting)phase='原生关卡重建中';
  else if(status.lifecycle||room?.suspendedReason)
    phase='关卡结束：'+(status.lifecycle?.reason??room.suspendedReason);
  else if(room?.effectivePaused)phase=room?.bothReady?'房间暂停':'等待另一位玩家';
  else if(room?.bothReady)phase='正在游戏';
  output.textContent=role+' · 第 '+String((status.roundNumber??0)+1)+' 轮 · '+phase;
  restart.disabled=!(status.lifecycle||room?.suspendedReason)||status.resetting;
}
try{
  await until(()=>window.__game?.state?.current==='menu',60000);
  const game=window.__game;
  const temple=game.progress?.get('temples')?.find(x=>x.id==='forest');
  if(!temple)throw Error('Original Forest Temple menu unavailable');
  game.state.states[game.state.current].startTemple(temple);
  await until(()=>game.state.current==='levelMenu'&&!game.state.fading&&
    game.state.states.levelMenu.buttons);
  const menu=game.state.states.levelMenu;
  const target=menu.templeData.levels.find(x=>Number(x.id)===config.levelId);
  if(!target||!(target.state>0))throw Error('Requested official level is locked or absent');
  menu.startLevel({data:target});
  await until(()=>game.state.current==='level'&&game.level?.levelStarted&&
    game.level.pers1?.body&&game.level.pers2?.body&&
    !game.paused&&!game.physics.box2d.paused&&!game.state.fading);
  const {connectHtml5Spectator}=await import('/adapters/fireboy-html5/spectator-client.mjs');
  player=connectHtml5Spectator({game,wsUrl:config.wsUrl,devices:window.Devices});
  window.__localHtml5Player=player;
  const unsubscribe=player.onStatus(renderStatus);
  renderStatus(player.status());
  restart.addEventListener('click',()=>player.requestRestart());
  window.addEventListener('pagehide',()=>{unsubscribe();player.close();},{once:true});
}catch(error){
  output.textContent='本地双人研究室启动失败：'+error.message;
  restart.disabled=true;
  console.error('HTML5_LOCAL_PLAYER_FAILED',error);
}
