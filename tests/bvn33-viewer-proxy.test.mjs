import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createServer} from 'node:http';
import {gzipSync} from 'node:zlib';
import {test} from 'node:test';
import {WebSocket,WebSocketServer} from 'ws';
import {createBvn33ViewerProxy} from '../server/bvn33-viewer-proxy.mjs';

async function listen(server) {
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

function close(server) {
  return new Promise(resolve=>{
    server.close(resolve);
    server.closeAllConnections();
  });
}

test('BVN viewer carries ticket traffic and cache bytes on one origin without exposing management routes',async t=>{
  const upstreamRequests=[];
  const gameBytes=Buffer.from('sample game data');
  const sidecar=createServer((req,res)=>{
    upstreamRequests.push({url:req.url,method:req.method,origin:req.headers.origin,host:req.headers.host});
    if(req.url==='/game/net.swf?v=fixture'){
      const headers={'cache-control':'public, max-age=31536000, immutable',etag:'W/"fixture"',vary:'Accept-Encoding'};
      if(req.headers['if-none-match']===headers.etag){res.writeHead(304,headers);res.end();return;}
      res.writeHead(200,{...headers,'content-encoding':'gzip','x-uncompressed-length':gameBytes.length});
      res.end(gzipSync(gameBytes));return;
    }
    res.writeHead(200,{'cache-control':'no-store'});
    req.pipe(res);
  });
  const sidecarSockets=new WebSocketServer({server:sidecar,path:'/socket'});
  sidecarSockets.on('connection',ws=>ws.on('message',(data,binary)=>ws.send(data,{binary})));
  const serviceOrigin=await listen(sidecar);

  let proxy;
  const viewer=createServer((req,res)=>{
    const reply=(status,type,body,headers={})=>{res.writeHead(status,{'content-type':type,...headers});res.end(body);};
    if(!proxy.handleHttp(req,res,new URL(req.url,'http://viewer.test').pathname,reply))reply(404,'text/plain','Not Found');
  });
  const viewerOrigin=await listen(viewer);
  proxy=createBvn33ViewerProxy(serviceOrigin,viewerOrigin);
  viewer.on('upgrade',proxy.handleUpgrade);
  t.after(async()=>{
    proxy.close();
    for(const ws of sidecarSockets.clients)ws.terminate();
    await Promise.all([close(viewer),close(sidecar)]);
  });

  const entry=await fetch(`${viewerOrigin}/bvn33/`);
  assert.equal(entry.status,200);
  assert.equal(entry.headers.get('x-bvn33-entry'),'1');
  assert.equal(entry.headers.get('cache-control'),'no-store');
  await entry.text();

  const swf=`${viewerOrigin}/bvn33/game/net.swf?v=fixture`;
  const data=await fetch(swf);
  assert.equal(data.headers.get('cache-control'),'public, max-age=31536000, immutable');
  assert.equal(data.headers.get('content-encoding'),'gzip');
  assert.deepEqual(Buffer.from(await data.arrayBuffer()),gameBytes);
  assert.equal((await fetch(swf,{headers:{'if-none-match':'W/"fixture"'}})).status,304);

  const join=await fetch(`${viewerOrigin}/bvn33/api/join`,{
    method:'POST',headers:{origin:viewerOrigin,'content-type':'application/json'},body:'{"code":"fixture"}',
  });
  assert.equal(await join.text(),'{"code":"fixture"}');
  assert.deepEqual(upstreamRequests.at(-1),{url:'/api/join',method:'POST',origin:viewerOrigin,host:new URL(viewerOrigin).host});
  assert.equal((await fetch(`${viewerOrigin}/bvn33/api/lobby-status`,{method:'POST'})).status,404);
  assert.equal((await fetch(`${viewerOrigin}/bvn33/`,{headers:{origin:'http://unrelated.test'}})).status,403);
  assert.equal(upstreamRequests.length,4);

  const ws=new WebSocket(`${viewerOrigin.replace('http','ws')}/bvn33/socket?room=fixture`,{origin:viewerOrigin});
  await once(ws,'open');
  const message=once(ws,'message');
  ws.send(Buffer.from([0,1,127,255]));
  const [payload,binary]=await message;
  assert.equal(binary,true);
  assert.deepEqual(payload,Buffer.from([0,1,127,255]));
  ws.close();
  await once(ws,'close');
});
