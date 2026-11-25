/**
 * 外部权威游戏服务（html5-external）的生命周期与房间探测。
 *
 * 这类游戏自带服务端（例如 TankTrouble 的 Colyseus 房间），大厅不代理对局
 * 数据，只负责：确保服务在跑、给双方发同一个房间码、并周期确认房间还在。
 *
 * 设计要点：
 * - **复用优先**：先用 /health 探测，已经有人在跑就直接复用，绝不重复 spawn
 *   （否则第二个进程会因端口占用直接退出，看起来像「大厅挂了」）。
 * - **谁启动谁负责**：只有本进程 spawn 出来的子进程才会在 close() 时被杀掉；
 *   复用别人起的服务时 close() 是空操作。
 * - **失败要清晰**：探测与启动都带超时，错误码直接给大厅转成中文提示。
 */
import {spawn} from 'node:child_process';

const HEALTH_TIMEOUT_MS=1500;
const START_TIMEOUT_MS=20000;
const POLL_INTERVAL_MS=250;

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function healthOk(baseUrl){
  try{
    const response=await fetch(baseUrl.replace(/\/$/,'')+'/health',
      {signal:AbortSignal.timeout(HEALTH_TIMEOUT_MS)});
    if(!response.ok)return false;
    const body=await response.json().catch(()=>null);
    // TankTrouble 返回 {ok:true,version}；其他实现只要 200 就算活着。
    return body===null?true:body.ok!==false;
  }catch{return false;}
}

/**
 * 确保某个 external 游戏的服务可用。
 * @param {object} options
 * @param {string} options.id 游戏 id（用于日志与错误码）
 * @param {string} options.command 可执行文件（通常是 node）
 * @param {string[]} options.args 参数
 * @param {string} options.cwd 子进程工作目录
 * @param {string} options.localUrl 本机访问地址（http://127.0.0.1:PORT）
 * @param {string} options.publicUrl 浏览器访问地址（局域网/公网）
 * @param {object} [options.env] 追加的环境变量
 * @param {string} [options.logLabel] 日志前缀
 */
export async function ensureExternalGameServer({id,command,args=[],cwd,localUrl,publicUrl=null,
  env={},logLabel=null,stdio='inherit'}={}){
  if(typeof localUrl!=='string'||!/^https?:\/\//.test(localUrl))
    throw Object.assign(Error('外部游戏服务地址无效'),{code:'EXTERNAL_SERVER_INVALID'});
  const label=logLabel??('['+id+']');
  if(await healthOk(localUrl))
    return Object.freeze({id,localUrl,publicUrl:publicUrl??localUrl,owned:false,
      reused:true,pid:null,close(){}});

  const child=spawn(command,args,{cwd,env:{...process.env,...env},stdio,
    windowsHide:true});
  let exited=null;
  child.once('exit',(code,signal)=>{exited={code,signal};});
  child.once('error',error=>{exited={error};});

  const deadline=Date.now()+START_TIMEOUT_MS;
  while(Date.now()<deadline){
    if(exited)break;
    if(await healthOk(localUrl)){
      return Object.freeze({id,localUrl,publicUrl:publicUrl??localUrl,owned:true,
        reused:false,pid:child.pid??null,
        close(){
          if(exited)return;
          try{child.kill();}catch{}
        }});
    }
    await sleep(POLL_INTERVAL_MS);
  }
  try{child.kill();}catch{}
  const detail=exited?.error?.message??(exited?`退出码 ${exited.code ?? exited.signal}`:'启动超时');
  throw Object.assign(Error(`${label} 游戏服务未能在 ${localUrl} 启动（${detail}）`),
    {code:'EXTERNAL_SERVER_UNAVAILABLE'});
}

/**
 * 探测某个 external 房间是否还活着。
 *
 * 先试 /rooms/all（不过滤 phase，能看见进行中的对局），失败再退回 /rooms。
 * 返回 {found, phase, playerCount, rosterSize} —— 服务本身不可达时抛错，
 * 由调用方决定是「暂时不通」还是「真的没了」。
 */
export async function probeExternalRoom(baseUrl,roomCode,{timeoutMs=2000}={}){
  const base=baseUrl.replace(/\/$/,'');
  const code=String(roomCode??'').toUpperCase();
  if(!code)return {found:false,phase:null,playerCount:0,rosterSize:0};
  const endpoints=['/rooms/all','/rooms'];
  let lastError=null;
  for(const endpoint of endpoints){
    try{
      const response=await fetch(base+endpoint,{signal:AbortSignal.timeout(timeoutMs)});
      if(!response.ok){lastError=Error('HTTP '+response.status);continue;}
      const body=await response.json();
      const rooms=Array.isArray(body?.rooms)?body.rooms:[];
      const match=rooms.find(room=>String(room?.roomCode??'').toUpperCase()===code);
      if(!match)return {found:false,phase:null,playerCount:0,rosterSize:0};
      return {found:true,phase:typeof match.phase==='string'?match.phase:'unknown',
        playerCount:Number.isFinite(match.playerCount)?match.playerCount:0,
        rosterSize:Number.isFinite(match.rosterSize)?match.rosterSize:0};
    }catch(error){lastError=error;}
  }
  throw Object.assign(Error('无法查询外部游戏房间：'+(lastError?.message??'未知错误')),
    {code:'EXTERNAL_ROOM_PROBE_FAILED'});
}

/**
 * 生成 external 房间码：去掉容易看错的 0/O、1/I，只留大写字母与数字。
 * 4 位空间足够同机单房间使用，且便于口头报码。
 */
export function makeRoomCode(alphabet='ABCDEFGHJKLMNPQRSTUVWXYZ23456789',length=4){
  const bytes=new Uint8Array(length);
  // 用 crypto 的随机源，避免 Math.random 在同一毫秒内撞码。
  globalThis.crypto.getRandomValues(bytes);
  let out='';
  for(const byte of bytes)out+=alphabet[byte%alphabet.length];
  return out;
}
