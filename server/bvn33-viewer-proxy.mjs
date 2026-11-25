import http from 'node:http';
import https from 'node:https';

export const BVN_VIEWER_PATH = '/bvn33/';

const staticPaths = new Set([
  '/', '/lobby-watch', '/lobby-watch.js', '/lobby-capture.js', '/net-bot-policy.js',
  '/style.css', '/client.js', '/bot.js', '/net-engine.html', '/net-engine.js',
  '/net-clock.js', '/net-download.js', '/emotes.js', '/api/emotes', '/game/net.swf',
  '/touch.js', '/touch.css',
]);
const assetPath = /^\/(?:ruffle\/(?:[a-f0-9]{24}\/)?[\w.-]+\.(?:js|wasm)|emotes\/[\w.-]+\.(?:gif|png))$/;
const upstreamTimeout = 15_000;

function rejectUpgrade(socket, status, reason) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function createBvn33ViewerProxy(serviceUrl, viewerOrigin) {
  const upstream = new URL(serviceUrl);
  const viewer = new URL(viewerOrigin);
  const transport = upstream.protocol === 'https:' ? https : http;
  const tunnels = new Set();

  function browserAllowed(req) {
    return req.headers.host?.toLowerCase() === viewer.host &&
      (!req.headers.origin || req.headers.origin === viewer.origin);
  }

  function upstreamTarget(pathname, rawUrl) {
    const target = new URL(upstream.origin);
    target.pathname = pathname;
    const queryIndex = rawUrl.indexOf('?');
    if (queryIndex !== -1) target.search = rawUrl.slice(queryIndex);
    return target;
  }

  function handleHttp(req, res, pathname, reply) {
    if (pathname !== '/bvn33' && !pathname.startsWith(BVN_VIEWER_PATH)) return false;
    if (!browserAllowed(req)) {
      reply(403, 'text/plain; charset=utf-8', 'Origin not allowed');
      return true;
    }
    if (pathname === '/bvn33' && ['GET','HEAD'].includes(req.method)) {
      reply(308, 'text/plain; charset=utf-8', '', {location:BVN_VIEWER_PATH});
      return true;
    }
    const path = pathname.slice(BVN_VIEWER_PATH.length - 1);
    const allowed = req.method === 'POST' ? path === '/api/join' :
      ['GET','HEAD'].includes(req.method) && (staticPaths.has(path) || assetPath.test(path));
    if (!allowed) {
      reply(404, 'text/plain; charset=utf-8', 'Not Found');
      return true;
    }

    const headers = {};
    for (const header of ['host','origin','content-type','content-length','accept-encoding','if-none-match','if-modified-since']) {
      if (req.headers[header] !== undefined) headers[header] = req.headers[header];
    }
    const outgoing = transport.request(upstreamTarget(path, req.url), {method:req.method,headers}, response => {
      const responseHeaders = {};
      for (const header of ['content-type','content-length','content-encoding','x-uncompressed-length','cache-control','etag','last-modified','vary']) {
        if (response.headers[header] !== undefined) responseHeaders[header] = response.headers[header];
      }
      if (path === '/' && response.statusCode === 200) responseHeaders['x-bvn33-entry'] = '1';
      res.writeHead(response.statusCode ?? 502, {...responseHeaders,'referrer-policy':'no-referrer','x-content-type-options':'nosniff'});
      response.on('error', error => res.destroy(error));
      response.pipe(res);
    });
    outgoing.setTimeout(upstreamTimeout, () => outgoing.destroy());
    outgoing.once('error', () => {
      if (res.destroyed) return;
      if (res.headersSent) res.destroy();
      else reply(503, 'application/json; charset=utf-8', JSON.stringify({error:'格斗服务暂时无法连接，请重试。'}), {'retry-after':'1'});
    });
    req.once('aborted', () => outgoing.destroy());
    res.once('close', () => { if (!res.writableFinished) outgoing.destroy(); });
    req.pipe(outgoing);
    return true;
  }

  function handleUpgrade(req, socket, head) {
    if (req.url?.split('?')[0] !== `${BVN_VIEWER_PATH}socket`) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!browserAllowed(req) || req.method !== 'GET' || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    const headers = {host:req.headers.host,connection:'Upgrade',upgrade:'websocket'};
    for (const header of ['origin','sec-websocket-key','sec-websocket-version','sec-websocket-protocol','sec-websocket-extensions']) {
      if (req.headers[header] !== undefined) headers[header] = req.headers[header];
    }
    const outgoing = transport.request(upstreamTarget('/socket', req.url), {headers});
    tunnels.add(socket);
    let peer;
    socket.on('error', () => outgoing.destroy());
    socket.once('close', () => { tunnels.delete(socket); outgoing.destroy(); peer?.destroy(); });
    outgoing.setTimeout(upstreamTimeout, () => outgoing.destroy());
    outgoing.once('error', () => rejectUpgrade(socket, 503, 'Service Unavailable'));
    outgoing.once('response', response => {
      response.resume();
      rejectUpgrade(socket, response.statusCode === 403 ? 403 : 503,
        response.statusCode === 403 ? 'Forbidden' : 'Service Unavailable');
    });
    outgoing.once('upgrade', (response, upstreamSocket, upstreamHead) => {
      peer = upstreamSocket;
      if (socket.destroyed) { peer.destroy(); return; }
      peer.setTimeout(0);
      peer.on('error', () => socket.destroy());
      peer.once('close', () => socket.destroy());
      const handshake = ['HTTP/1.1 101 Switching Protocols'];
      for (let i=0;i<response.rawHeaders.length;i+=2) handshake.push(`${response.rawHeaders[i]}: ${response.rawHeaders[i+1]}`);
      socket.write(handshake.join('\r\n') + '\r\n\r\n');
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) peer.write(head);
      socket.pipe(peer).pipe(socket);
    });
    outgoing.end();
  }

  return {handleHttp,handleUpgrade,close() { for (const tunnel of tunnels) tunnel.destroy(); }};
}
