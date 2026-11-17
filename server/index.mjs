import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { InputBuffer, BUILD_ID, GAME_ID, STEP_HZ, PROTOCOL, MAX_INPUTS_PER_SECOND, percentile, validateSnapshot } from './protocol.mjs';
import { launchAuthorityBrowser, createRuffleAuthority } from './ruffle-authority.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mime = {'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8',
  '.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8',
  '.wasm':'application/wasm','.swf':'application/x-shockwave-flash','.json':'application/json; charset=utf-8'};
const json = (res, status, body) => { res.writeHead(status, {'content-type':'application/json; charset=utf-8'}); res.end(JSON.stringify(body)); };
const token = () => randomBytes(24).toString('base64url');
const catalog = [
  {id:GAME_ID, title:'AS3 双人链路实验', status:'available', players:2,
    detail:'自写 AS3 测试程序；用于验证权威服务器与本地显示，不是两款原游戏。'},
  {id:'fireboy-original', title:'森林冰火人 · 原版', status:'needs-original-runtime', players:2,
    detail:'已定位输入与物理循环；当前附件缺 SWF 与素材，原版运行和联机未验证。'},
  {id:'shanyi-original', title:'闪翼双星 · 正传', status:'needs-original-runtime', players:2,
    detail:'已完成输入、时钟及反编译质量审计；需补齐 SWF 和资源后验证。'},
];

export async function startServer(options = {}) {
  const host = options.host ?? process.env.HOST ?? '127.0.0.1';
  const port = options.port ?? Number(process.env.PORT || 8780);
  const maxRooms = options.maxRooms ?? Number(process.env.MAX_ROOMS || 4);
  const reconnectMs = options.reconnectMs ?? 15000;
  const rooms = new Map();
  const sockets = new Set();
  const resumptions = new Map();
  const metrics = {createdRooms:0, rejectedMessages:0, staleInputs:0, droppedSnapshots:0,
    statePayloadBytes:0, stateMessages:0, stepMs:[], missedTickSlots:0, inputMessages:0};
  let browser;
  let browserLaunch;
  let closing = false;
  let closePromise;
  let baseUrl;
  const roomClosures = new Set();
  // Tests can inject a controllable authority; the default always runs server-side Ruffle.
  const authorityFactory = options.authorityFactory ?? (async ({signal}) => {
    browserLaunch ??= launchAuthorityBrowser().then(value => {
      browser=value;return value;
    }, error => {browserLaunch=undefined;throw error;});
    const activeBrowser=await browserLaunch;
    signal.throwIfAborted();
    return createRuffleAuthority(activeBrowser,baseUrl);
  });

  const server = http.createServer(async (req, res) => {
    try {
      if (!['GET','HEAD'].includes(req.method)) return json(res,405,{error:'METHOD_NOT_ALLOWED'});
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (pathname === '/health') return json(res,200,{ok:true,protocol:PROTOCOL,build:BUILD_ID,
        originalGamesVerified:false, probePresent:existsSync(path.join(root,'experiments/as3-probe/probe.swf')),
        activeRooms:rooms.size});
      if (pathname === '/api/catalog') return json(res,200,catalog);
      let dir, relative;
      if (pathname.startsWith('/runtime/')) {
        dir = path.join(root,'node_modules/@ruffle-rs/ruffle'); relative = pathname.slice('/runtime/'.length);
      } else if (pathname === '/experiments/as3-probe/probe.swf') {
        dir = path.join(root,'experiments/as3-probe'); relative = 'probe.swf';
      } else {
        dir = path.join(root,'public'); relative = pathname === '/' ? 'index.html' : pathname.slice(1);
      }
      const target = path.resolve(dir, relative);
      if (!target.startsWith(dir + path.sep)) return json(res,403,{error:'FORBIDDEN'});
      const info = await stat(target);
      if (!info.isFile()) return json(res,404,{error:'NOT_FOUND'});
      res.writeHead(200, {'content-type':mime[path.extname(target)] || 'application/octet-stream',
        'cache-control':'no-cache','x-content-type-options':'nosniff','referrer-policy':'no-referrer'});
      res.end(req.method === 'HEAD' ? undefined : await readFile(target));
    } catch (error) {
      if (!res.headersSent) json(res,error.code === 'ENOENT' ? 404 : 400,{error:'NOT_FOUND'});
      else res.end();
    }
  });
  const wss = new WebSocketServer({noServer:true, maxPayload:4096, perMessageDeflate:false});
  server.on('upgrade',(req,socket,head) => {
    const origin = req.headers.origin;
    const validOrigin = !origin || ['http','https'].some(scheme => origin === `${scheme}://${req.headers.host}`);
    if (req.url !== '/ws' || !validOrigin || closing) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
    wss.handleUpgrade(req,socket,head,ws => wss.emit('connection',ws,req));
  });
  function send(ws, value) {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value));
  }
  function fail(ws,code) {
    metrics.rejectedMessages++; send(ws,{type:'error',code});
  }
  function publicRoom(room) {
    return {code:room.code,game:GAME_ID,status:room.status,
      players:room.members.map((m,slot) => ({slot,name:m?.name || '',connected:!!m?.ws,ready:!!m?.ready}))};
  }
  function broadcastRoom(room) {
    const value={type:'room',room:publicRoom(room)};
    for(const member of room.members) send(member?.ws,value);
  }
  function updateRunning(room) {
    if(room.destroyed || room.status==='starting')return;
    if(room.status==='failed'){broadcastRoom(room);return;}
    const previous=room.status;
    room.status = room.members.every(m => m?.ws && m.ready) ? 'running' : 'waiting';
    if(room.status!=='running' || previous!=='running') {
      for(const m of room.members)m?.input.resetPending();
    }
    broadcastRoom(room);
  }
  function stateMessage(room) {
    return {type:'state',snapshot:room.state,serverTime:Date.now(),
      ack:room.appliedAck};
  }
  function tick(room) {
    if (room.status !== 'running' || room.destroyed || closing) return;
    if(room.stepping){metrics.missedTickSlots++;return;}
    room.stepping=true;
    room.stepTask=(async()=>{
      const started=performance.now();
      try {
        const now=Date.now();
        const sampledMembers=[...room.members];
        const inputs=sampledMembers.map(m => m.input.consume(now));
        const state=await room.authority.step(inputs);
        if(room.destroyed || closing)return;
        if(!validateSnapshot(state,room.state.tick))throw new Error('Invalid authority snapshot');
        room.state=state;
        room.appliedAck=inputs.map((input,slot)=>room.members[slot]===sampledMembers[slot]?input.seq:-1);
        metrics.stepMs.push(performance.now()-started);
        if(metrics.stepMs.length>10000)metrics.stepMs.shift();
        const message=JSON.stringify(stateMessage(room));
        for(const member of room.members) {
          if(member?.ws?.readyState!==WebSocket.OPEN)continue;
          if(member.ws.bufferedAmount>128*1024){metrics.droppedSnapshots++;continue;}
          member.ws.send(message);
          metrics.statePayloadBytes+=Buffer.byteLength(message);
          metrics.stateMessages++;
        }
      } catch(error) {
        if(room.destroyed || closing)return;
        room.status='failed';room.error=String(error.message);clearInterval(room.timer);
        for(const member of room.members){
          member?.input.resetPending();
          send(member?.ws,{type:'error',code:'AUTHORITY_FAILED'});
        }
        broadcastRoom(room);
        closeAuthority(room).catch(()=>{});
        console.error('Authority failed:',error.message);
      } finally {room.stepping=false;}
    })();
    return room.stepTask;
  }
  function closeAuthority(room) {
    if(!room.authority)return Promise.resolve();
    room.authorityClose ??= Promise.resolve().then(()=>room.authority.close());
    return room.authorityClose;
  }
  async function initializeRoom(room) {
    if(room.destroyed || closing)return;
    try {
      room.authority=await authorityFactory({baseUrl,signal:room.abort.signal,roomCode:room.code});
      if(room.destroyed || closing)return;
      room.state=room.authority.read();
      if(!validateSnapshot(room.state))throw new Error('Invalid authority initial snapshot');
      room.status='waiting';metrics.createdRooms++;
      room.timer=setInterval(()=>tick(room),1000/STEP_HZ);
      room.timer.unref();
      for(let slot=0;slot<room.members.length;slot++) {
        const member=room.members[slot];
        if(member?.ws?.readyState===WebSocket.OPEN)welcome(room,slot,member);
      }
    } catch(error) {
      if(room.destroyed || closing)return;
      for(const member of room.members)if(member)fail(member.ws,'ROOM_START_FAILED');
      console.error('Room initialization failed:',error.message);
      destroyRoom(room).catch(()=>{});
    }
  }
  function createRoom() {
    // A cancelled room still owns resources until its startup/close settles.
    if(rooms.size+roomClosures.size>=maxRooms)throw new Error('SERVER_FULL');
    let code;
    do {code=randomBytes(4).toString('hex').slice(0,6).toUpperCase();} while(rooms.has(code));
    const room={code,authority:null,members:[null,null],status:'starting',state:null,
      createdAt:Date.now(),stepping:false,destroyed:false,appliedAck:[-1,-1],abort:new AbortController()};
    // Reservation is synchronous. Other match requests can claim the second seat
    // while this room boots, without blocking controls in existing rooms.
    rooms.set(code,room);
    room.startup=Promise.resolve().then(()=>initializeRoom(room));
    return room;
  }
  function join(ws,room,slot,name,resumed=null) {
    const member=resumed || {token:token(),input:new InputBuffer(),name:String(name||`玩家 ${slot+1}`).trim().slice(0,24),ready:false};
    member.ws=ws;member.disconnectedAt=null;member.ready=false;
    member.input.resetPending();
    room.members[slot]=member;ws.member=member;ws.room=room;ws.slot=slot;
    if(!resumed)room.appliedAck[slot]=-1;
    if(room.status!=='starting')welcome(room,slot,member);
  }
  function welcome(room,slot,member) {
    const ws=member.ws;
    member.welcomed=true;
    resumptions.set(member.token,{room,slot,member});
    send(ws,{type:'welcome',protocol:PROTOCOL,build:BUILD_ID,room:publicRoom(room),slot,
      resumeToken:member.token,lastInputSeq:member.input.seq,stepHz:STEP_HZ});
    send(ws,stateMessage(room));updateRunning(room);
  }
  function detach(ws,explicit=false) {
    const {room,member,slot}=ws;
    if(!room||!member||member.ws!==ws)return;
    member.input.resetPending();member.ready=false;member.ws=null;member.disconnectedAt=Date.now();
    if(explicit || !member.welcomed){
      resumptions.delete(member.token);room.members[slot]=null;room.appliedAck[slot]=-1;
    }
    ws.room=null;ws.member=null;updateRunning(room);
    if(room.members.every(m=>!m))destroyRoom(room).catch(()=>{});
  }
  function destroyRoom(room) {
    if(room.destroyPromise)return room.destroyPromise;
    room.destroyed=true;room.status='closed';clearInterval(room.timer);rooms.delete(room.code);room.abort.abort();
    for(const member of room.members)if(member){
      resumptions.delete(member.token);member.input.resetPending();
      if(member.ws?.room===room){member.ws.room=null;member.ws.member=null;}
      member.ws=null;
    }
    room.members=[null,null];
    room.destroyPromise=(async()=>{
      await room.startup;
      await closeAuthority(room);
      await room.stepTask;
    })();
    roomClosures.add(room.destroyPromise);
    room.destroyPromise.then(()=>roomClosures.delete(room.destroyPromise),()=>roomClosures.delete(room.destroyPromise));
    return room.destroyPromise;
  }
  wss.on('connection',ws => {
    sockets.add(ws);ws.rate={time:Date.now(),count:0};ws.alive=true;
    ws.on('pong',()=>{ws.alive=true;});
    ws.on('error',()=>{});
    ws.on('close',()=>{sockets.delete(ws);detach(ws);});
    ws.on('message',(buffer,isBinary) => {
      if(closing)return;
      if(isBinary)return fail(ws,'JSON_ONLY');
      let msg;
      try{msg=JSON.parse(buffer.toString('utf8'));}catch{return fail(ws,'BAD_JSON');}
      if(!msg||typeof msg!=='object'||Array.isArray(msg))return fail(ws,'BAD_MESSAGE');
      if(msg.type==='input') {
        if(!ws.member)return fail(ws,'NOT_JOINED');
        if(ws.room.status==='failed' || ws.room.destroyed)return fail(ws,'ROOM_FAILED');
        const now=Date.now();
        if(now-ws.rate.time>=1000)ws.rate={time:now,count:0};
        if(++ws.rate.count>MAX_INPUTS_PER_SECOND)return fail(ws,'RATE_LIMIT');
        const error=ws.member.input.receive(msg,now);
        if(error==='STALE_INPUT'){metrics.staleInputs++;return;}
        if(error)return fail(ws,error);
        if(ws.room.status!=='running')ws.member.input.resetPending();
        metrics.inputMessages++;return;
      }
      if(msg.type==='ping'){send(ws,{type:'pong',id:msg.id,serverTime:Date.now()});return;}
      try {
        if(ws.readyState!==WebSocket.OPEN||closing)return;
        if(['create','join','match','resume'].includes(msg.type)) {
          if(ws.member)return fail(ws,'ALREADY_JOINED');
          if(msg.protocol!==PROTOCOL||msg.build!==BUILD_ID)return fail(ws,'BUILD_MISMATCH');
          if(msg.type==='resume') {
            const found=resumptions.get(msg.resumeToken);
            if(!found||found.room.destroyed||found.room.status==='failed'||found.member.ws||Date.now()-found.member.disconnectedAt>reconnectMs)return fail(ws,'RESUME_REJECTED');
            join(ws,found.room,found.slot,found.member.name,found.member);return;
          }
          if(msg.game!==GAME_ID)return fail(ws,'GAME_NOT_AVAILABLE');
          if(msg.type==='create') {
            const room=createRoom();
            join(ws,room,0,msg.name);return;
          }
          if(msg.type==='join') {
            const room=rooms.get(String(msg.code||'').toUpperCase());
            if(!room||room.destroyed)return fail(ws,'ROOM_NOT_FOUND');
            if(room.status==='failed')return fail(ws,'ROOM_FAILED');
            const slot=room.members.findIndex(m=>!m);
            if(slot<0)return fail(ws,'ROOM_FULL');
            join(ws,room,slot,msg.name);return;
          }
          let room=[...rooms.values()].find(r=>!r.destroyed&&['starting','waiting'].includes(r.status)&&r.members.some(m=>m?.ws)&&r.members.some(m=>!m));
          room??=createRoom();
          join(ws,room,room.members.findIndex(m=>!m),msg.name);return;
        }
        if(msg.type==='ready') {
          if(!ws.member)return fail(ws,'NOT_JOINED');
          if(ws.room.status==='failed' || ws.room.destroyed)return fail(ws,'ROOM_FAILED');
          if(ws.room.status==='starting')return fail(ws,'ROOM_STARTING');
          ws.member.ready=true;updateRunning(ws.room);return;
        }
        if(msg.type==='leave'){detach(ws,true);send(ws,{type:'left'});return;}
        fail(ws,'UNKNOWN_MESSAGE');
      } catch(error) {
        console.error('Room operation failed:',error.message);
        fail(ws,error.message==='SERVER_FULL'?'SERVER_FULL':'ROOM_START_FAILED');
      }
    });
  });
  const cleanup=setInterval(()=>{
    const now=Date.now();
    for(const room of rooms.values()) {
      for(let slot=0;slot<room.members.length;slot++){
        const m=room.members[slot];
        if(m&&!m.ws&&now-m.disconnectedAt>reconnectMs){
          resumptions.delete(m.token);room.members[slot]=null;room.appliedAck[slot]=-1;broadcastRoom(room);
        }
      }
      if(room.members.every(m=>!m))destroyRoom(room).catch(()=>{});
    }
  },500);cleanup.unref();
  const heartbeat=setInterval(()=>{
    for(const ws of sockets){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping();}
  },10000);heartbeat.unref();
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,resolve);});
  const address=server.address();
  baseUrl=`http://${host==='0.0.0.0'?'127.0.0.1':host}:${address.port}`;
  return {
    url:baseUrl,rooms,
    getMetrics(){return {...metrics,stepMs:undefined,stepSamples:metrics.stepMs.length,
      stepP50Ms:percentile(metrics.stepMs,.5),stepP95Ms:percentile(metrics.stepMs,.95),
      activeRooms:rooms.size,nodeRssBytes:process.memoryUsage().rss};},
    close(){
      closePromise ??= (async()=>{
        closing=true;clearInterval(cleanup);clearInterval(heartbeat);
        for(const ws of sockets)ws.terminate();
        for(const room of [...rooms.values()])destroyRoom(room).catch(()=>{});
        // Closing Chromium also cancels outstanding page evaluations and booting rooms.
        if(browserLaunch)await browserLaunch.catch(()=>{});
        if(browser)await browser.close();
        await Promise.allSettled([...roomClosures]);
        await new Promise(resolve=>wss.close(resolve));
        await new Promise(resolve=>server.close(resolve));
      })();
      return closePromise;
    },
  };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const app=await startServer();
  console.log(`AS3 multiplayer lab: ${app.url}`);
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await app.close();process.exit(0);});
}
