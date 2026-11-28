import {WebSocket,WebSocketServer} from 'ws';

export const GLORTON_HEALTH_PATH='/glorton-online/health';
export const GLORTON_SOCKET_PATH='/glorton-online/ws';
const CONNECT_TIMEOUT=3000;
const FIRST_MESSAGE_TIMEOUT=8000;
const MAX_TUNNELS=24;
const MAX_CLIENT_MESSAGE=16_384;
const MAX_SERVER_MESSAGE=1_048_576;
const jsonType='application/json; charset=utf-8';

function reject(socket,status,reason){
  if(!socket.destroyed)socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createGlortonViewerProxy(serviceUrl,viewerOrigins){
  const service=new URL(serviceUrl);
  if(service.protocol!=='http:'||service.hostname!=='127.0.0.1'||service.pathname!=='/'||
    service.username||service.password||service.search||service.hash)throw Error('Expected a loopback Glorton service origin');
  const origins=new Set(viewerOrigins.filter(Boolean).map(value=>new URL(value).origin));
  const healthUrl=new URL('/health',service);
  const socketUrl=new URL('/ws',service);
  socketUrl.protocol='ws:';
  const hub=new WebSocketServer({noServer:true,clientTracking:false,maxPayload:MAX_CLIENT_MESSAGE});
  const tunnels=new Set();
  const acceptsOrigin=req=>!req.headers.origin||origins.has(req.headers.origin);

  async function handleHealth(req,reply){
    if(!acceptsOrigin(req))return reply(403,jsonType,'{"ok":false}');
    try{
      const response=await fetch(healthUrl,{signal:AbortSignal.timeout(CONNECT_TIMEOUT),redirect:'error'});
      if(response.ok){
        const status=await response.json();
        if(status.ok===true&&status.protocol===1)return reply(200,jsonType,'{"ok":true,"protocol":1}');
      }else await response.body?.cancel();
    }catch{}
    return reply(503,jsonType,'{"ok":false}',{'retry-after':'2'});
  }

  function handleUpgrade(req,socket,head){
    if(req.method!=='GET'||!acceptsOrigin(req))return reject(socket,403,'Forbidden');
    if(tunnels.size>=MAX_TUNNELS)return reject(socket,503,'Service Unavailable');
    const peer=new WebSocket(socketUrl,{handshakeTimeout:CONNECT_TIMEOUT,maxPayload:MAX_SERVER_MESSAGE,perMessageDeflate:false});
    tunnels.add(socket);
    let client,firstMessageTimer;
    socket.on('error',()=>socket.destroy());
    socket.once('close',()=>{
      tunnels.delete(socket);
      clearTimeout(firstMessageTimer);
      peer.terminate();
    });
    const stop=()=>{peer.terminate();socket.destroy();};
    function relay(target,data,isBinary){
      if(target.readyState!==WebSocket.OPEN)return;
      if(target.bufferedAmount+data.length>MAX_SERVER_MESSAGE)return stop();
      target.send(data,{binary:isBinary},error=>{if(error)stop();});
    }
    peer.on('error',()=>client?stop():reject(socket,503,'Service Unavailable'));
    peer.once('close',(code,reason)=>{
      if(client?.readyState===WebSocket.OPEN)client.close(code===1005||code===1006?1011:code,reason);
    });
    peer.on('message',(data,isBinary)=>{if(client)relay(client,data,isBinary);});
    peer.once('open',()=>{
      if(socket.destroyed)return peer.terminate();
      hub.handleUpgrade(req,socket,head,connected=>{
        client=connected;
        client.on('error',stop);
        firstMessageTimer=setTimeout(stop,FIRST_MESSAGE_TIMEOUT);
        firstMessageTimer.unref();
        client.once('message',()=>clearTimeout(firstMessageTimer));
        client.on('message',(data,isBinary)=>relay(peer,data,isBinary));
        client.once('close',()=>peer.close());
      });
    });
  }

  return {handleHealth,handleUpgrade,close(){
    for(const socket of tunnels)socket.destroy();
    hub.close();
  }};
}
