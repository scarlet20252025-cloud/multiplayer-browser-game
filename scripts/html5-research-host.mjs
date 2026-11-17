#!/usr/bin/env node
/**
 * Authored loopback-only HTML5 research harness, not an original-package baseline.
 * The original game and assets stay in the explicitly supplied private root.
 * Only the served game script exposes its existing Game instance; no file is patched.
 */
import http from 'node:http';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, realpath} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_NAMES = new Set(['pause-bridge.mjs', 'state-snapshot.mjs', 'jump-observer.mjs', 'jump-analysis.mjs']);
const MODULE_PREFIX = 'adapters/fireboy-html5/';
const INSTANCE_ANCHOR = '(o = new h.Game(m)),';
const INSTANCE_EXPOSURE = '(o = window.__game = new h.Game(m)),';
const REQUIRE_SCRIPT = 'bower_components/requirejs/require.js';
const TYPES = {
  '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.wasm':'application/wasm',
  '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.gif':'image/gif',
  '.webp':'image/webp', '.svg':'image/svg+xml', '.mp3':'audio/mpeg', '.ogg':'audio/ogg',
  '.wav':'audio/wav', '.m4a':'audio/mp4', '.aac':'audio/aac', '.fnt':'application/xml; charset=utf-8',
  '.xml':'application/xml; charset=utf-8', '.ttf':'font/ttf', '.woff':'font/woff', '.woff2':'font/woff2',
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function failure(code, message, status = 400) {
  const error = new Error(message); error.code = code; error.status = status; return error;
}

function relativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') ||
      value.includes(':') || value.includes('?') || value.includes('#') || value.includes('%') ||
      path.isAbsolute(value) || value.split('/').some(part => !part || part.startsWith('.'))) {
    throw failure('HTML5_UNSAFE_PATH', 'Expected a non-hidden relative path without parent traversal.', 403);
  }
  return value;
}

/** Refuse symlinks in every requested component, including the selected root. */
async function readContainedFile(root, relative) {
  relativePath(relative);
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    throw failure('HTML5_UNSAFE_ROOT', 'The selected root must be a real directory.', 403);
  }
  const canonicalRoot = await realpath(root);
  let target = root;
  const parts = relative.split('/');
  for (let index = 0; index < parts.length; index++) {
    target = path.join(target, parts[index]);
    const info = await lstat(target);
    if (info.isSymbolicLink()) throw failure('HTML5_SYMLINK_REFUSED', 'Symlink resources are not served.', 403);
    if (index < parts.length - 1 && !info.isDirectory()) throw failure('HTML5_NOT_FOUND', 'Resource not found.', 404);
    if (index === parts.length - 1 && !info.isFile()) throw failure('HTML5_NOT_FOUND', 'Resource not found.', 404);
  }
  const canonicalTarget = await realpath(target);
  const rel = path.relative(canonicalRoot, canonicalTarget);
  if (!rel || rel.startsWith(`..${path.sep}`) || rel === '..' || path.isAbsolute(rel)) {
    throw failure('HTML5_PATH_ESCAPE', 'Resource lies outside the selected root.', 403);
  }
  const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!(await handle.stat()).isFile()) throw failure('HTML5_NOT_FOUND', 'Resource not found.', 404);
    return await handle.readFile();
  } finally { await handle.close(); }
}

function authoredPage(script) {
  const scriptUrl = script.split('/').map(encodeURIComponent).join('/');
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HTML5 instrumented research harness</title>
<style>html,body{margin:0;overflow:hidden}#research-notice{position:fixed;z-index:2147483647;bottom:0;left:0;padding:3px 8px;background:#111c;color:#fff;font:11px sans-serif;pointer-events:none}</style>
</head><body>
<div id="root"><div id="container"></div><div id="hammer"></div><div id="debug-fps"></div></div>
<div id="research-notice">Instrumented research harness · 非原包基准</div>
<script data-main="/${scriptUrl}" src="/${REQUIRE_SCRIPT}"></script>
</body></html>\n`;
}

/**
 * @param {{root:string,script:string,port?:number}} options
 * @returns {Promise<{url:string,sourceSha256:string,servedSha256:string,sourceBytes:number,close:()=>Promise<void>}>}
 */
export async function startHtml5ResearchHost({root, script, port = 0} = {}) {
  if (typeof root !== 'string' || !root.trim()) throw failure('HTML5_ROOT_REQUIRED', 'Provide the private first-game directory with --root.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw failure('HTML5_INVALID_PORT', 'port must be an integer from 0 to 65535.');
  script = relativePath(script);
  if (path.extname(script) !== '.js') throw failure('HTML5_INVALID_SCRIPT', 'script must identify a .js file inside the selected root.');
  const gameRoot = path.resolve(root);
  let source;
  try { source = await readContainedFile(gameRoot, script); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw failure('HTML5_SOURCE_NOT_FOUND', `Original HTML5 source is missing: ${script}. Supply the private game package.`);
    }
    throw error;
  }
  try { await readContainedFile(gameRoot, REQUIRE_SCRIPT); }
  catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      throw failure('HTML5_REQUIREJS_NOT_FOUND', `Required local loader is missing: ${REQUIRE_SCRIPT}.`);
    }
    throw error;
  }
  const text = source.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(source)) throw failure('HTML5_SOURCE_ENCODING', 'The source must be valid UTF-8; no encoding conversion is performed.');
  const occurrences = text.split(INSTANCE_ANCHOR).length - 1;
  if (occurrences !== 1) throw failure('HTML5_INSTANCE_ANCHOR_COUNT', `Expected exactly one Game instance anchor; found ${occurrences}. No source was changed.`);
  const served = Buffer.from(text.replace(INSTANCE_ANCHOR, INSTANCE_EXPOSURE), 'utf8');
  const sourceSha256 = sha256(source), servedSha256 = sha256(served), sourceBytes = source.length;
  const html = Buffer.from(authoredPage(script), 'utf8');
  const manifest = Buffer.from(JSON.stringify({schema:1, kind:'instrumented-research-harness', originalPackageBaseline:false,
    script, sourceSha256, servedSha256, sourceBytes,
    transformation:'Expose the existing Game instance as window.__game in the HTTP response only; original files unchanged.'}) + '\n');
  let actualPort;
  const server = http.createServer(async (req, res) => {
    const send = (status, type, body) => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      res.writeHead(status, {'content-type':type, 'content-length':bytes.length, 'cache-control':'no-store',
        'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer'});
      res.end(req.method === 'HEAD' ? undefined : bytes);
    };
    try {
      if (!['GET','HEAD'].includes(req.method)) return send(405, 'text/plain; charset=utf-8', 'Method Not Allowed');
      if (![ `127.0.0.1:${actualPort}`, `localhost:${actualPort}` ].includes(req.headers.host)) {
        return send(403, 'text/plain; charset=utf-8', 'Loopback Host required');
      }
      const rawPath = (req.url ?? '').split('?')[0];
      if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /%2f|%5c/i.test(rawPath)) {
        throw failure('HTML5_UNSAFE_PATH', 'Invalid request path.', 403);
      }
      let pathname;
      try { pathname = decodeURIComponent(rawPath); }
      catch { throw failure('HTML5_INVALID_ENCODING', 'Invalid URL encoding.'); }
      if (pathname === '/' || pathname === '/index.html') return send(200, 'text/html; charset=utf-8', html);
      if (pathname === '/__research__/manifest') return send(200, 'application/json; charset=utf-8', manifest);
      const relative = relativePath(pathname.slice(1));
      if (relative.startsWith(MODULE_PREFIX)) {
        const name = relative.slice(MODULE_PREFIX.length);
        if (!MODULE_NAMES.has(name)) return send(403, 'text/plain; charset=utf-8', 'Adapter module is not allowlisted');
        return send(200, 'text/javascript; charset=utf-8', await readContainedFile(REPO_ROOT, MODULE_PREFIX + name));
      }
      if (relative.startsWith('adapters/')) return send(403, 'text/plain; charset=utf-8', 'Adapter module is not allowlisted');
      // No original HTML entry, repository document, hidden file or unlisted module is exposed.
      const type = TYPES[path.extname(relative).toLowerCase()];
      if (!type) return send(404, 'text/plain; charset=utf-8', 'Not Found');
      if (relative === script) return send(200, type, served);
      return send(200, type, await readContainedFile(gameRoot, relative));
    } catch (error) {
      const status = ['ENOENT','ENOTDIR'].includes(error.code) ? 404 : error.code === 'ELOOP' ? 403 : (error.status ?? 500);
      send(status, 'application/json; charset=utf-8', JSON.stringify({error:status === 500 ? 'HTML5_RESOURCE_READ_FAILED' : (error.code ?? 'HTML5_REQUEST_REJECTED')}));
    }
  });
  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', onError); actualPort = server.address().port; resolve();
    });
  });
  let closing;
  return {
    url:`http://127.0.0.1:${actualPort}`, sourceSha256, servedSha256, sourceBytes,
    close() {
      if (!closing) {
        closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        server.closeAllConnections();
      }
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const {values} = parseArgs({options:{root:{type:'string'},script:{type:'string'},port:{type:'string'},help:{type:'boolean'}}});
    if (values.help) console.log('Usage: node scripts/html5-research-host.mjs --root <private first-game directory> --script <relative game.js> [--port 8802]\nInstrumented research harness only; original package is never modified.');
    else {
      const app = await startHtml5ResearchHost({root:values.root, script:values.script, port:values.port === undefined ? 0 : Number(values.port)});
      console.log(JSON.stringify({kind:'instrumented-research-harness',originalPackageBaseline:false,url:app.url,
        sourceSha256:app.sourceSha256,servedSha256:app.servedSha256,sourceBytes:app.sourceBytes}));
      for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
    }
  } catch (error) {
    console.error(`${error.code ?? 'HTML5_HOST_ERROR'}: ${error.message}`); process.exitCode = 1;
  }
}
