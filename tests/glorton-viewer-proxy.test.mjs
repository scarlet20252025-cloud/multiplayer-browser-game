import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {test} from 'node:test';
import {WebSocket,WebSocketServer} from 'ws';
import {createGlortonViewerProxy,GLORTON_HEALTH_PATH,GLORTON_SOCKET_PATH} from '../server/glorton-viewer-proxy.mjs';

async function listen(server){
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function close(server){
  return new Promise(resolve=>{
    server.close(resolve);
    server.closeAllConnections();
  });
}

test('Glorton relays native WebSockets and publishes health without exposing the upstream API',async t=>{
  let protocol=1;
  const upstream=createServer((req,res)=>{
    assert.equal(req.url,'/health');
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify({ok:true,protocol,rooms:123}));
  });
  const upstreamSockets=new WebSocketServer({server:upstream,path:'/ws'});
  upstreamSockets.on('connection',peer=>peer.on('message',(data,binary)=>peer.send(data,{binary})));
  const backend=await listen(upstream);
  let proxy;
  const viewer=createServer((req,res)=>{
    if(req.url!==GLORTON_HEALTH_PATH){res.writeHead(404);res.end();return;}
    void proxy.handleHealth(req,(status,type,body,headers)=>{
      res.writeHead(status,{'content-type':type,...headers});res.end(body);
    });
  });
  const origin=await listen(viewer);
  proxy=createGlortonViewerProxy(backend,[origin]);
  viewer.on('upgrade',(req,socket,head)=>{
    if(req.url===GLORTON_SOCKET_PATH)proxy.handleUpgrade(req,socket,head);
    else socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  });
  t.after(async()=>{
    proxy.close();
    for(const peer of upstreamSockets.clients)peer.terminate();
    await Promise.all([close(viewer),close(upstream)]);
  });

  const healthy=await fetch(origin+GLORTON_HEALTH_PATH);
  assert.equal(healthy.status,200);
  assert.deepEqual(await healthy.json(),{ok:true,protocol:1});
  protocol=2;
  const incompatible=await fetch(origin+GLORTON_HEALTH_PATH);
  assert.equal(incompatible.status,503);
  assert.deepEqual(await incompatible.json(),{ok:false});
  const denied=await fetch(origin+GLORTON_HEALTH_PATH,{headers:{origin:'https://unrelated.test'}});
  assert.equal(denied.status,403);
  assert.equal((await fetch(origin+'/glorton-online/assets')).status,404);

  const endpoint=origin.replace(/^http/,'ws')+GLORTON_SOCKET_PATH;
  const player=new WebSocket(endpoint);
  await once(player,'open');
  const frame=once(player,'message');
  player.send('{"op":"create","protocol":1}');
  const [payload,binary]=await frame;
  assert.equal(binary,false);
  assert.deepEqual(JSON.parse(payload),{op:'create',protocol:1});
  const rejected=new WebSocket(endpoint,{origin:'https://unrelated.test'});
  await assert.rejects(once(rejected,'open'),/403/);

  const ended=once(player,'close');
  proxy.close();
  await ended;
});
