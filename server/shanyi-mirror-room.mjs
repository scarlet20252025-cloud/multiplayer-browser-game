/**
 * Loopback input-mirror session for Flash/Ruffle games.
 *
 * Both players run the same local SWF in their own tab; this server only
 * relays input edges (keys and menu clicks) between the two seats. There is
 * no authoritative simulation, no snapshots and no video: the game state is
 * best-effort on each client. Reports /health in the shape room-lobby expects.
 */
import http from 'node:http';
import {WebSocketServer,WebSocket} from 'ws';

const fail=(code,message)=>Object.assign(Error(message??code),{code});
const HOSTS=new Set(['127.0.0.1','localhost']);
const isLocalOrPrivateHost=name=>HOSTS.has(name)||
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)||
  /^192\.168\.\d{1,3}\.\d{1,3}$/.test(name)||
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(name);

export async function startShanyiMirrorRoom({
  port=0,publicPort=null,allowedViewerOrigins=[],wsToken=null,gameId='shanyi',levelId=null,
  bindHost='127.0.0.1',publicHost=null,seats:requestedSeats=2,
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

  const seats=new Array(capacity).fill(null);
  const ready=new Array(capacity).fill(false);
  let closed=false,closing;
  let returnRequestedBy=null;
  const returnVotes=new Set();
  const resetReturn=()=>{returnRequestedBy=null;returnVotes.clear();};
  const broadcastReturn=(type,extra={})=>{
    for(const holder of seats)if(holder)send(holder.ws,{type,requestedBy:returnRequestedBy,votes:returnVotes.size,...extra});
  };

  const send=(ws,message)=>{
    if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(message));
  };
  /** Every seat except this one; for the default two seats that is one peer. */
  const peerSeats=seat=>seats.map((_,index)=>index).filter(index=>index!==seat);
  const connected=()=>seats.map(holder=>Boolean(holder));
  const allReady=()=>seats.every((holder,index)=>Boolean(holder)&&ready[index]);
  const notifyConnection=()=>{
    for(let seat=0;seat<seats.length;seat++){
      const holder=seats[seat];
      if(holder)send(holder.ws,{type:'peer-connection',
        connected:peerSeats(seat).every(index=>Boolean(seats[index]))});
    }
  };
  const readyState=()=>({type:'ready-state',ready:[...ready],bothReady:allReady(),
    capacity,seats:seats.map((holder,index)=>({seat:index,label:'P'+(index+1),
      occupied:Boolean(holder),ready:ready[index]===true}))});
  const notifyReady=()=>{
    const state=readyState();
    for(const holder of seats)if(holder)send(holder.ws,state);
  };

  const server=http.createServer((req,res)=>{
    const okay=req.url==='/health'&&['GET','HEAD'].includes(req.method);
    const body=JSON.stringify({
      mirrorInput:true,noVideo:true,gameId,levelId,failed:false,
      room:{connected:connected(),bothConnected:connected().every(Boolean),
        capacity,ready:[...ready],bothReady:allReady(),
        suspendedReason:null},
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
    let requestUrl=null,requestedSeat=null;
    try{requestUrl=new URL(req.url,'http://'+hostHeader);}catch{}
    const seatRaw=requestUrl?.searchParams.get('seat')??null;
    if(seatRaw!==null&&/^\d{1,2}$/.test(seatRaw)){
      const parsed=Number(seatRaw);
      if(parsed>=0&&parsed<capacity)requestedSeat=parsed;
    }
    const tokenOkay=wsToken===null||requestUrl?.searchParams.get('token')===wsToken;
    const originOkay=!req.headers.origin||req.headers.origin===`http://${hostHeader}`||
      origins.has(req.headers.origin);
    if(!requestUrl||requestUrl.pathname!=='/ws'||!hostOkay||!tokenOkay||
      (seatRaw!==null&&requestedSeat===null)||!originOkay||closed){
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;
    }
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,requestedSeat));
  });

  wss.on('connection',(ws,requestedSeat)=>{
    let seat=requestedSeat;
    if(seat===null){
      seat=seats.findIndex(holder=>!holder);
      if(seat<0){
        send(ws,{type:'mirror-error',code:'ROOM_FULL',
          message:'房间里已有 '+capacity+' 位玩家'});
        ws.close(4000,'full');return;
      }
    }else if(seats[seat]){
      const previous=seats[seat];
      seats[seat]=null;
      try{previous.ws.close(4001,'replaced');}catch{}
    }
    seats[seat]={ws};
    ready[seat]=false;
    ws.seat=seat;
    ws.alive=true;
    ws.on('pong',()=>{ws.alive=true;});
    const currentReady=readyState();
    send(ws,{type:'welcome',seat,peerConnected:peerSeats(seat).every(index=>Boolean(seats[index])),
      capacity,gameId,levelId,mirrorInput:true,noVideo:true,
      ready:currentReady.ready,bothReady:currentReady.bothReady});
    notifyConnection();
    notifyReady();
    ws.on('error',()=>{});
    ws.on('message',buffer=>{
      let message;
      try{message=JSON.parse(buffer.toString());}
      catch{return send(ws,{type:'mirror-error',code:'BAD_JSON'});}
      if(!message||typeof message!=='object'||Array.isArray(message))
        return send(ws,{type:'mirror-error',code:'BAD_MESSAGE'});
      const peerWs=peerSeats(seat).map(index=>seats[index]?.ws).filter(Boolean);
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
          ready[seat]=true;
          notifyReady();
          return;
        }
        if(message.type==='presence'){
          const page=typeof message.page==='string'?message.page.slice(0,120):'';
          for(const target of peerWs)send(target,{type:'peer-presence',page});
          return;
        }
        if(message.type==='return.request'){
          if(returnRequestedBy===null){
            returnRequestedBy=seat;
            returnVotes.add(seat);
            broadcastReturn('return-request');
          }else if(returnRequestedBy===seat){
            send(ws,{type:'return-state',requestedBy:returnRequestedBy,votes:returnVotes.size});
          }else{
            send(ws,{type:'mirror-error',code:'RETURN_VOTE_PENDING',message:'对方已发起返回请求'});
          }
          return;
        }
        if(message.type==='return.confirm'){
          if(returnRequestedBy===null)throw fail('NO_RETURN_VOTE','当前没有返回请求');
          if(seat===returnRequestedBy)throw fail('CANNOT_CONFIRM_OWN','不能确认自己的返回请求');
          returnVotes.add(seat);
          if(returnVotes.size>=capacity){broadcastReturn('return-approved');resetReturn();}
          else broadcastReturn('return-state');
          return;
        }
        if(message.type==='return.cancel'){
          if(returnRequestedBy===null)return;
          const cancelledBy=seat;
          resetReturn();
          broadcastReturn('return-cancelled',{cancelledBy});
          return;
        }
        if(message.type==='ping'){send(ws,{type:'pong',id:message.id});return;}
        send(ws,{type:'mirror-error',code:'UNKNOWN_MESSAGE'});
      }catch(error){
        send(ws,{type:'mirror-error',code:error.code??'MIRROR_REJECTED',
          message:error.message});
      }
    });
    ws.on('close',()=>{
      if(seats[seat]?.ws===ws){
        seats[seat]=null;
        ready[seat]=false;
        if(returnRequestedBy===seat){resetReturn();broadcastReturn('return-cancelled',{cancelledBy:seat});}
        notifyConnection();
        notifyReady();
      }
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
    url:`http://${advertiseHost}:${displayPort}`,gameId,levelId,seatCount:capacity,
    localUrl:`http://${bindAddress==='0.0.0.0'||bindAddress==='::'?'127.0.0.1':bindAddress}:${actualPort}`,
    sourceSha256:null,servedSha256:null,
    close(){
      closing??=(async()=>{
        closed=true;clearInterval(heartbeat);
        for(const ws of wss.clients)ws.terminate();
        await new Promise(resolve=>wss.close(resolve));
        await new Promise(resolve=>server.close(resolve));
      })();
      return closing;
    },
  };
}
