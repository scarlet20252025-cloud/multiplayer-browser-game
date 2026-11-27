/**
 * 闪翼双星：Flash/Ruffle 输入镜像房间。
 *
 * 两名（或更多）玩家各自在标签页里跑同一份 SWF，服务器只转发输入边沿、
 * 点击、在线状态和英雄位置/速度；没有权威模拟、没有快照、没有画面传输。
 *
 * 房间域（席位、准备、返回投票）复用 `Html5RoomCore`，和冰火人、合作关卡
 * 用同一套状态机；断线席位由 `SeatPresence` 保留 20 秒，带票回来坐回原位。
 * 这样闪翼不再是一套单独手写的房间逻辑。
 */
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {WebSocketServer,WebSocket} from 'ws';
import {Html5RoomCore} from './html5-room-core.mjs';
import {DEFAULT_RESUME_GRACE_MS,SeatPresence} from './seat-presence.mjs';

const fail=(code,message)=>Object.assign(Error(message??code),{code});
const HOSTS=new Set(['127.0.0.1','localhost']);
const isLocalOrPrivateHost=name=>HOSTS.has(name)||
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)||
  /^192\.168\.\d{1,3}\.\d{1,3}$/.test(name)||
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(name);

export async function startShanyiMirrorRoom({
  port=0,publicPort=null,allowedViewerOrigins=[],wsToken=null,gameId='shanyi',levelId=null,
  bindHost='127.0.0.1',publicHost=null,seats:requestedSeats=2,
  resumeGraceMs=DEFAULT_RESUME_GRACE_MS,
}={}){
  if(!Number.isInteger(port)||port<0||port>65535||(port>0&&port<1024))
    throw fail('MIRROR_INVALID_PORT','Invalid mirror port');
  if(publicPort!==null&&(!Number.isInteger(publicPort)||publicPort<1||publicPort>65535))
    throw fail('MIRROR_INVALID_PUBLIC_PORT','Invalid public mirror port');
  // Capacity is declared by the game manifest; 2 remains the default so the
  // existing dual-tab flow is untouched.
  const capacity=Number.isInteger(requestedSeats)&&requestedSeats>=1&&requestedSeats<=4
    ?requestedSeats:2;
  if(wsToken!==null&&(typeof wsToken!=='string'||wsToken.length<16))
    throw fail('MIRROR_INVALID_TOKEN','Invalid session token');
  const bindAddress=['127.0.0.1','localhost','0.0.0.0','::'].includes(bindHost)||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(bindHost)?bindHost:'127.0.0.1';
  const advertiseHost=typeof publicHost==='string'&&publicHost.trim()?publicHost.trim():bindAddress;
  let displayPort=publicPort;
  const allowedHostNames=new Set([advertiseHost,'127.0.0.1','localhost']);
  const origins=new Set(allowedViewerOrigins.filter(origin=>{
    try{const url=new URL(origin);return url.protocol==='http:'&&(url.hostname===advertiseHost||isLocalOrPrivateHost(url.hostname));}
    catch{return false;}
  }));

  const roomEpoch=randomBytes(16).toString('hex');
  const core=new Html5RoomCore({roomEpoch,seats:capacity});
  /** 每个 socket 对应一个 memberId；席位由 core 分配。 */
  const peers=new Map();
  const socketsBySlot=new Map();
  let closed=false,closing;
  let commandSeq=0;

  const presence=new SeatPresence({capacity,graceMs:resumeGraceMs,onExpire:slot=>{
    if(closed)return;
    notifyConnection();
    notifyReady();
    console.info(`[${gameId}] seat ${slot+1} released after resume window`);
  }});

  const send=(ws,message)=>{
    if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(message));
  };
  const broadcast=(message)=>{
    const payload=JSON.stringify(message);
    for(const ws of peers.keys())if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<256*1024)ws.send(payload);
  };
  /** Every seat except this one. */
  const peerSeats=seat=>Array.from({length:capacity},(_,index)=>index).filter(index=>index!==seat);
  const peerConnectedFor=seat=>peerSeats(seat).every(index=>core.members[index]);
  const connected=()=>core.members.map(Boolean);

  const readyState=()=>{
    const state=core.publicState();
    return {type:'ready-state',ready:state.ready,bothReady:state.bothReady,
      capacity,seats:state.seats.map((entry,index)=>({...entry,
        reserved:presence.isReserved(index)}))};
  };
  const notifyReady=()=>broadcast(readyState());
  const notifyConnection=()=>{
    for(const [ws,peer] of peers)
      send(ws,{type:'peer-connection',connected:peerConnectedFor(peer.slot),
        reserved:presence.reservedSlots()});
  };

  const server=http.createServer((req,res)=>{
    const okay=req.url==='/health'&&['GET','HEAD'].includes(req.method);
    const state=core.publicState();
    const body=JSON.stringify({
      mirrorInput:true,noVideo:true,gameId,levelId,failed:false,roomEpoch,
      room:{connected:connected(),bothConnected:connected().every(Boolean),
        capacity,ready:state.ready,bothReady:state.bothReady,
        reserved:presence.reservedSlots(),suspendedReason:null},
    });
    res.writeHead(okay?200:404,{'content-type':'application/json; charset=utf-8',
      'cache-control':'no-store','content-length':Buffer.byteLength(body)});
    res.end(req.method==='HEAD'?undefined:body);
  });

  const wss=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
  server.on('upgrade',(req,socket,head)=>{
    const hostHeader=req.headers.host??'';
    const portActual=displayPort??server.address()?.port;
    const hostName=String(hostHeader).replace(/:\d+$/,'');
    const hostOkay=allowedHostNames.has(hostName)&&String(hostHeader).endsWith(':'+portActual);
    let requestUrl=null,requestedSeat=null,resumeToken=null;
    try{requestUrl=new URL(req.url,'http://'+hostHeader);}catch{}
    const seatRaw=requestUrl?.searchParams.get('seat')??null;
    if(seatRaw!==null&&/^\d{1,2}$/.test(seatRaw)){
      const parsed=Number(seatRaw);
      if(parsed>=0&&parsed<capacity)requestedSeat=parsed;
    }
    resumeToken=requestUrl?.searchParams.get('resume')??null;
    const tokenOkay=wsToken===null||requestUrl?.searchParams.get('token')===wsToken;
    const originOkay=!req.headers.origin||req.headers.origin===`http://${hostHeader}`||
      origins.has(req.headers.origin);
    if(!requestUrl||requestUrl.pathname!=='/ws'||!hostOkay||!tokenOkay||
      (seatRaw!==null&&requestedSeat===null)||!originOkay||closed){
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;
    }
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,{requestedSeat,resumeToken}));
  });

  wss.on('connection',(ws,{requestedSeat,resumeToken})=>{
    const memberId=randomBytes(16).toString('hex');
    // 1) 带票回来：优先坐回原席位。
    let slot=null,resumed=false;
    const claimed=presence.claim(resumeToken);
    if(claimed!==null){
      try{
        slot=core.attach(memberId,claimed);
        resumed=true;
      }catch{slot=null;}
    }
    if(slot===null&&requestedSeat!==null&&core.members[requestedSeat]){
      // 显式点名同一席位：顶掉旧连接，保持原来的「刷新即接管」行为。
      const previous=socketsBySlot.get(requestedSeat);
      const previousMember=core.members[requestedSeat]?.id;
      if(previousMember)core.detach(previousMember);
      presence.release(requestedSeat);
      try{previous?.close(4001,'replaced');}catch{}
      socketsBySlot.delete(requestedSeat);
    }
    if(slot===null){
      try{slot=core.attach(memberId,requestedSeat);}
      catch{
        send(ws,{type:'mirror-error',code:'ROOM_FULL',
          message:'房间里已有 '+capacity+' 位玩家'});
        ws.close(4000,'full');return;
      }
    }
    presence.release(slot);
    const resumeTokenOut=presence.issue(slot);
    peers.set(ws,{memberId,slot});
    socketsBySlot.set(slot,ws);
    ws.alive=true;
    ws.on('pong',()=>{ws.alive=true;});
    const state=core.publicState();
    send(ws,{type:'welcome',seat:slot,peerConnected:peerConnectedFor(slot),
      capacity,gameId,levelId,mirrorInput:true,noVideo:true,roomEpoch,
      resumeToken:resumeTokenOut,resumed,resumeGraceMs,
      ready:state.ready,bothReady:state.bothReady,
      reserved:presence.reservedSlots()});
    notifyConnection();
    notifyReady();

    ws.on('error',()=>{});
    ws.on('message',buffer=>{
      let message;
      try{message=JSON.parse(buffer.toString());}
      catch{return send(ws,{type:'mirror-error',code:'BAD_JSON'});}
      if(!message||typeof message!=='object'||Array.isArray(message))
        return send(ws,{type:'mirror-error',code:'BAD_MESSAGE'});
      const peerWs=peerSeats(slot).map(index=>socketsBySlot.get(index)).filter(Boolean);
      try{
        if(message.type==='input'){
          const code=Number(message.code),down=message.down===true;
          if(!Number.isInteger(code)||code<0||code>255)
            throw fail('INPUT_INVALID','按键编号无效');
          for(const target of peerWs)send(target,{type:'peer-input',code,down});
          return;
        }
        if(message.type==='click'){
          const x=Number(message.x),y=Number(message.y);
          if(!Number.isFinite(x)||!Number.isFinite(y)||Math.abs(x)>10000||Math.abs(y)>10000)
            throw fail('CLICK_INVALID','点击坐标无效');
          for(const target of peerWs)
            send(target,{type:'peer-click',x:Math.round(x),y:Math.round(y)});
          return;
        }
        if(message.type==='hero-state'){
          const x=Number(message.x),y=Number(message.y);
          const vx=Number(message.vx),vy=Number(message.vy);
          if(![x,y,vx,vy].every(Number.isFinite)||[x,y,vx,vy].some(value=>Math.abs(value)>100000))
            throw fail('HERO_STATE_INVALID','角色状态无效');
          for(const target of peerWs)send(target,{type:'peer-hero-state',x,y,vx,vy});
          return;
        }
        if(message.type==='ready'){
          try{core.markReady(memberId,0);}
          catch(error){
            throw fail(error.message==='WRONG_ROUND'?'WRONG_ROUND':'ROOM_SUSPENDED');
          }
          notifyReady();
          return;
        }
        if(message.type==='presence'){
          const page=typeof message.page==='string'?message.page.slice(0,120):'';
          for(const target of peerWs)send(target,{type:'peer-presence',page});
          return;
        }
        if(['return.request','return.confirm','return.cancel'].includes(message.type)){
          const command=message.type;
          const result=core.voteReturn(memberId,{type:'room-command',command,roomEpoch,
            roundNumber:core.roundNumber,commandId:'mirror-'+(++commandSeq)});
          if(!result.accepted)throw fail(result.code);
          if(command==='return.cancel'){
            broadcast({type:'return-cancelled',requestedBy:null,votes:0,cancelledBy:slot});
            return;
          }
          const payload={requestedBy:result.returnRequestedSeat,votes:result.returnVotes};
          if(result.execute)broadcast({type:'return-approved',...payload});
          else broadcast({type:command==='return.request'?'return-request':'return-state',...payload});
          return;
        }
        if(message.type==='leave'){ws.leaving=true;ws.close(4002,'left');return;}
        if(message.type==='ping'){send(ws,{type:'pong',id:message.id});return;}
        send(ws,{type:'mirror-error',code:'UNKNOWN_MESSAGE'});
      }catch(error){
        send(ws,{type:'mirror-error',code:error.code??'MIRROR_REJECTED',
          message:error.message});
      }
    });
    ws.on('close',()=>{
      const owner=peers.get(ws);
      if(!owner)return;
      peers.delete(ws);
      if(socketsBySlot.get(owner.slot)===ws)socketsBySlot.delete(owner.slot);
      const wasRequester=core.returnRequestedBy!==null &&
        core.returnRequestedBy===core.members[owner.slot]?.id;
      core.detach(owner.memberId);
      if(wasRequester&&!closed)
        broadcast({type:'return-cancelled',requestedBy:null,votes:0,cancelledBy:owner.slot});
      // 主动离开立刻放人；意外断开才保留 20 秒。
      if(!closed){
        if(ws.leaving)presence.release(owner.slot);
        else presence.hold(owner.slot);
      }
      notifyConnection();
      notifyReady();
    });
  });

  const heartbeat=setInterval(()=>{
    for(const ws of wss.clients){
      if(!ws.alive){ws.terminate();continue;}
      ws.alive=false;ws.ping();
    }
  },10000);
  heartbeat.unref();

  await new Promise((resolve,reject)=>{
    const onError=error=>reject(error);
    server.once('error',onError);
    server.listen(port,bindAddress,()=>{
      server.off('error',onError);
      displayPort=publicPort??server.address().port;
      resolve();
    });
  });
  const actualPort=server.address().port;
  return {
    url:`http://${advertiseHost}:${displayPort}`,gameId,levelId,seatCount:capacity,roomEpoch,
    localUrl:`http://${bindAddress==='0.0.0.0'||bindAddress==='::'?'127.0.0.1':bindAddress}:${actualPort}`,
    sourceSha256:null,servedSha256:null,room:core,
    close(){
      closing??=(async()=>{
        closed=true;clearInterval(heartbeat);
        presence.dispose();
        for(const ws of wss.clients)ws.terminate();
        await new Promise(resolve=>wss.close(resolve));
        await new Promise(resolve=>server.close(resolve));
      })();
      return closing;
    },
  };
}
