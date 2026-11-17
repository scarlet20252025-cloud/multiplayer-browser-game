const $=id=>document.getElementById(id);
const PROTOCOL=1, BUILD='as3-probe-1';
const statusNames={waiting:'等待另一位玩家准备',running:'双人联机中',failed:'权威实例异常'};
const errorText={BUILD_MISMATCH:'客户端版本不匹配，请刷新。',ROOM_NOT_FOUND:'房间不存在或已经结束。',ROOM_FULL:'房间已满。',SERVER_FULL:'实验服务器容量已满，请稍后重试。',RESUME_REJECTED:'重连保留时间已过，请重新加入。',ROOM_START_FAILED:'AS3 运行环境启动失败，请检查服务器日志。',AUTHORITY_FAILED:'权威实例出现错误，本局已停止。',GAME_NOT_AVAILABLE:'原游戏尚未接入，请选择实验程序。'};
let socket, member=null, api=null, playerElement=null, seq=0, receivedBytes=0, latest=null, appliedTick=-1;
let logicalWidth=640, logicalHeight=360;
let pressed=new Set(), mouseButtons=0, aimX=.5, aimY=.5, connectAttempts=0, sessionGeneration=0;
let resumeToken=sessionStorage.getItem('lab-resume-token');
const pings=new Map();
const lab={ready:false,slot:null,room:null,latestState:null,appliedTick:-1,inputSeq:-1,errors:[],lastAck:[],events:[],stateHistory:[]};
window.lab=lab;

function notice(text){$('notice').textContent=text;}
function transmit(message){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));}
function availability(){for(const id of ['create','join','match'])$(id).disabled=socket?.readyState!==WebSocket.OPEN||!!member;}
function clearInput(){pressed.clear();mouseButtons=0;sendInput();}
function paintRoom(room){
  lab.room=room;
  $('room-code').textContent=room.code;
  $('room-status').textContent=statusNames[room.status]||room.status;
  room.players.forEach((p,i)=>{$(`player${i}`).textContent=p.connected?`P${i+1} · ${p.name}${p.ready?' · 已就绪':' · 加载中'}`:`P${i+1} · 等待加入`;});
}
async function loadRenderer(generation){
  api=null;appliedTick=-1;lab.appliedTick=-1;lab.ready=false;
  $('player').replaceChildren();
  const player=window.RufflePlayer.newest().createPlayer();
  playerElement=player;
  $('player').append(player);
  const next=player.ruffle();
  next.config={autoplay:'on',unmuteOverlay:'hidden',allowScriptAccess:true,logLevel:'error'};
  await next.load({url:'/experiments/as3-probe/probe.swf',parameters:{mode:'client'},allowScriptAccess:true});
  const end=Date.now()+20000;
  let hello;
  while(!(hello=next.callExternalInterface('netHello'))){
    if(generation!==sessionGeneration)return;
    if(Date.now()>end)throw new Error('AS3 客户端桥接握手超时');
    await new Promise(requestAnimationFrame);
  }
  if(generation!==sessionGeneration)return;
  if(hello.role!=='client'||hello.version!==BUILD)throw new Error('AS3 客户端协议不匹配');
  api=next;lab.ready=true;lab.hello=hello;
  logicalWidth=hello.width;logicalHeight=hello.height;
  // Read-only observer used by the verification harness; no server authority access.
  lab.readRendered=()=>api?.callExternalInterface('netReadState');
  lab.readDisplay=()=>api?.callExternalInterface('netReadDisplay');
  lab.contentRect=contentRect;
  lab.tryLocalStep=(a,b)=>api?.callExternalInterface('netStep',a,b);
  $('placeholder').hidden=true;
  $('placeholder').style.display='none';
  transmit({type:'ready'});notice('已连接。两位玩家都加载完成后开始。');
}
function connect(){
  socket=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws`);
  socket.addEventListener('open',()=>{
    connectAttempts=0;$('connection').textContent='服务器已连接';availability();
    if(resumeToken)transmit({type:'resume',protocol:PROTOCOL,build:BUILD,resumeToken});
    else notice('创建房间，或输入朋友的六位房间码。');
  });
  socket.addEventListener('close',()=>{
    $('connection').textContent='连接中断';availability();clearInput();
    if(member)notice('正在尝试恢复原来的席位……');
    setTimeout(connect,Math.min(5000,500*2**Math.min(connectAttempts++,4)));
  });
  socket.addEventListener('error',()=>{});
  socket.addEventListener('message',async event=>{
    const message=JSON.parse(event.data);
    lab.events.push(message.type);if(lab.events.length>100)lab.events.shift();
    if(message.type==='welcome'){
      member=message;resumeToken=message.resumeToken;sessionStorage.setItem('lab-resume-token',resumeToken);
      seq=message.lastInputSeq+1;lab.slot=message.slot;latest=null;lab.latestState=null;lab.stateHistory=[];
      $('my-slot').textContent=`你是 P${message.slot+1}`;$('session').hidden=false;
      paintRoom(message.room);availability();
      try{await loadRenderer(++sessionGeneration);}catch(error){lab.errors.push(error.message);notice(error.message);}
    }else if(message.type==='room'){paintRoom(message.room);}
    else if(message.type==='state'){
      receivedBytes+=new TextEncoder().encode(event.data).length;
      $('bytes').textContent=`${(receivedBytes/1000).toFixed(1)} KB`;
      if(!latest||message.snapshot.tick>latest.tick){latest=message.snapshot;lab.latestState=latest;}
      lab.stateHistory.push(message.snapshot);if(lab.stateHistory.length>120)lab.stateHistory.shift();
      lab.lastAck=message.ack;
    }else if(message.type==='pong'){
      const sent=pings.get(message.id);if(sent!==undefined){$('rtt').textContent=`${Math.round(performance.now()-sent)} ms`;pings.delete(message.id);}
    }else if(message.type==='error'){
      lab.errors.push(message.code);notice(errorText[message.code]||`请求未接受：${message.code}`);
      if(message.code==='RESUME_REJECTED')resetSession();
    }else if(message.type==='left'){resetSession();notice('已退出，可以创建或加入另一局。');}
  });
}
function resetSession(){
  member=null;resumeToken=null;sessionStorage.removeItem('lab-resume-token');sessionGeneration++;
  api=null;playerElement=null;latest=null;lab.latestState=null;lab.ready=false;lab.slot=null;lab.room=null;pressed.clear();mouseButtons=0;
  $('session').hidden=true;$('room-status').textContent='尚未加入房间';availability();
  $('player').replaceChildren();$('placeholder').hidden=false;$('placeholder').style.display='flex';
}
function request(type){notice('正在准备 AS3 房间……');transmit({type,protocol:PROTOCOL,build:BUILD,game:'as3-probe',name:$('name').value,code:$('code').value.trim()});}
$('create').addEventListener('click',()=>request('create'));
$('join').addEventListener('click',()=>request('join'));
$('match').addEventListener('click',()=>request('match'));
$('leave').addEventListener('click',()=>{clearInput();transmit({type:'leave'});});
function sendInput(){
  if(!member||!lab.ready)return;
  const has=(...keys)=>keys.some(k=>pressed.has(k));
  const moveX=Number(has('KeyD','ArrowRight'))-Number(has('KeyA','ArrowLeft'));
  const moveY=Number(has('KeyS','ArrowDown'))-Number(has('KeyW','ArrowUp'));
  const buttons=(has('Space')?1:0)|mouseButtons;
  const current=seq++;lab.inputSeq=current;
  transmit({type:'input',seq:current,moveX,moveY,buttons,aimX,aimY});
}
const gameKeys=new Set(['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space']);
window.addEventListener('keydown',event=>{
  if(!member||!gameKeys.has(event.code)||['INPUT','TEXTAREA'].includes(event.target.tagName))return;
  event.preventDefault();if(!pressed.has(event.code)){pressed.add(event.code);sendInput();}
});
window.addEventListener('keyup',event=>{if(gameKeys.has(event.code)){pressed.delete(event.code);if(member)event.preventDefault();sendInput();}});
window.addEventListener('blur',clearInput);
document.addEventListener('visibilitychange',()=>{if(document.hidden)clearInput();});
function contentRect(){
  const bounds=(playerElement||$('stage')).getBoundingClientRect();
  // The authored SWF uses SHOW_ALL and TOP_LEFT: preserve its logical aspect ratio.
  const scale=Math.min(bounds.width/logicalWidth,bounds.height/logicalHeight);
  return {x:bounds.x,y:bounds.y,width:logicalWidth*scale,height:logicalHeight*scale,scale};
}
$('stage').addEventListener('pointermove',event=>{
  const bounds=contentRect();
  aimX=Math.max(0,Math.min(1,(event.clientX-bounds.x)/bounds.width));
  aimY=Math.max(0,Math.min(1,(event.clientY-bounds.y)/bounds.height));
});
$('stage').addEventListener('pointerdown',event=>{if(event.button===0){mouseButtons|=2;sendInput();}});
window.addEventListener('pointerup',event=>{if(event.button===0){mouseButtons&=~2;sendInput();}});
setInterval(sendInput,1000/30);
setInterval(()=>{if(socket?.readyState!==WebSocket.OPEN)return;const id=Date.now();pings.set(id,performance.now());if(pings.size>8)pings.delete(pings.keys().next().value);transmit({type:'ping',id});},1500);
function render(){
  if(api&&latest&&latest.tick>appliedTick){
    const result=api.callExternalInterface('netApplyState',latest);
    if(result){appliedTick=latest.tick;lab.appliedTick=appliedTick;}
    $('tick').textContent=`${latest.tick} / ${appliedTick}`;
  }
  requestAnimationFrame(render);
}
requestAnimationFrame(render);connect();
