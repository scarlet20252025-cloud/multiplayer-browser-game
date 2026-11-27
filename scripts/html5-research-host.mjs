#!/usr/bin/env node
/**
 * Authored loopback-only HTML5 research harness, not an original-package baseline.
 * The original game and assets stay in the explicitly supplied private root.
 * Only the served game script exposes its existing Game instance; no file is patched.
 * Multi-game mode adds an authored lobby and per-game instrumented entries.
 */
import http from 'node:http';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, readFile, realpath} from 'node:fs/promises';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {LOCKSTEP_RUNTIME} from '../public/lockstep/protocol.mjs';
import {ARENA_RUNTIME, ARENA_SOCKET} from '../public/tank-arena/rules.mjs';
import {BRAWL_RUNTIME, BRAWL_SOCKET} from '../public/platform-brawl/rules.mjs';
import {GLORTON_HEALTH_PATH, GLORTON_SOCKET_PATH} from '../server/glorton-viewer-proxy.mjs';
import {GLORTON_BROWSER_HEALTH_PATH, GLORTON_BROWSER_SOCKET_PATH} from '../server/glorton-browser-rooms.mjs';
import {ORIGINAL_SWF_BYTES, ORIGINAL_SWF_PATH, ORIGINAL_SWF_SHA256} from '../experiments/bomb-it-netplay/original-file.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODULE_NAMES = new Set(['pause-bridge.mjs', 'state-snapshot.mjs', 'jump-observer.mjs', 'jump-analysis.mjs', 'authority-input.mjs', 'spectator-projection.mjs', 'spectator-client.mjs']);
const MODULE_PREFIX = 'adapters/fireboy-html5/';
const LOBBY_FILES = new Set(['index.html','lobby.mjs','lobby.css','game-chat.mjs']);
const GLORTON_LOCAL_PREFIX='/glorton-local/';
const GLORTON_LOCAL_FILES=new Set(['.html','.js','.mjs','.css','.json','.webmanifest','.wasm','.zip','.apk','.data','.png','.ico','.whl','.txt']);
const LOBBY_COVERS = ['forest','light','ice','crystal','shanyi','tank-trouble','bvn33','platform-brawl','bomb-it-7','glorton'];
const LOBBY_ART = new Set([
  'art/carnival.webp', 'art/title.webp', 'art/boy.webp', 'art/girl.webp',
  'art/corgi.webp', 'art/sprout.webp', 'art/sprite.svg',
  ...LOBBY_COVERS.map(id => 'art/covers/'+id+'.webp'),
  ...Array.from({length:8}, (_, id) => 'art/bomb-it-7/wardrobe/robot-'+id+'.webp'),
  ...['FashionShop','Cake','Classroom','Forest','Race','Ranch','ToyShop','Christmas','Sand']
    .map(id => 'art/bomb-it-7/maps/'+id+'.webp'),
  ...['kill','collect','pacMan','frozen'].map(id => 'art/bomb-it-7/modes/'+id+'.webp'),
  ...['Rooftop','Mogadishu','B52','Space'].map(id => 'art/glorton/maps/'+id+'.png'),
]);
const LOCKSTEP_FILES = new Set(['client.mjs','protocol.mjs','loading.mjs','loading.css']);
const INSTANCE_ANCHOR = '(o = new h.Game(m)),';
const INSTANCE_EXPOSURE = '(o = window.__game = new h.Game(m)),';
const VIEWPORT_WIDTH_READ = 'window.innerWidth || $(window).width()';
const VIEWPORT_HEIGHT_READ = 'window.innerHeight || $(window).height()';
const VIEWPORT_WIDTH_INSTRUMENTED = '(window.__gameViewportSize ? window.__gameViewportSize().width : (window.innerWidth || $(window).width()))';
const VIEWPORT_HEIGHT_INSTRUMENTED = '(window.__gameViewportSize ? window.__gameViewportSize().height : (window.innerHeight || $(window).height()))';
const REQUIRE_SCRIPT = 'bower_components/requirejs/require.js';
const TYPES = {
  '.js':'text/javascript; charset=utf-8', '.json':'application/json; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.wasm':'application/wasm',
  '.swf':'application/x-shockwave-flash',
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

// The private packs removed per-game copies of files identical across games
// and redirect them to shared-assets/ via a service worker. The research host
// does not register that worker, so resolve the same canonical files here.
function sharedAssetRelative(relative) {
  const match = /^[A-Za-z0-9_.-]+\/(assets\/.+)$/.exec(relative);
  return match ? `shared-assets/${match[1]}` : null;
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

const jsonScript = value => JSON.stringify(value)
  .replace(/</g,'\\u003c').replace(/&/g,'\\u0026');

const GAME_SHELL_CSS = `
html,body{margin:0;height:100%}
:root{--game-ink:#20215c;--game-purple:#6731d4;--game-muted:#5d5a83;--game-line:#dcd8f3;--game-paper:#f6f2ff;--game-left-w:220px;--game-right-w:270px;--game-gap:12px;--game-sky:linear-gradient(155deg,#b9e8ff,#e0f0ff 43%,#eee5ff)}
body{overflow:hidden;font:14px/1.45 "Microsoft YaHei UI","PingFang SC",system-ui,sans-serif;color:var(--game-ink);background:var(--game-sky)}
*,*::before,*::after{box-sizing:border-box}
button:focus-visible,a:focus-visible,input:focus-visible{outline:2px solid #783af0;outline-offset:2px}
/* The center size is exposed to the original game bundle via __gameViewportSize. */
#game-center{position:fixed;inset:0;overflow:hidden;background:#0b081e;display:flex;align-items:center;justify-content:center}
.game-has-sidebars #game-center{inset:var(--game-gap) calc(var(--game-right-w) + 2 * var(--game-gap)) var(--game-gap) calc(var(--game-left-w) + 2 * var(--game-gap));border:3px solid #fff;border-radius:19px;box-shadow:0 0 0 1px #cabce8,0 5px 18px #554a9d39}
#root,#container{position:absolute;inset:0;overflow:hidden}
#container canvas{display:block}
#hammer,#debug-fps{position:absolute;left:0;top:0;z-index:1}
#game-left,#game-right{position:fixed;top:var(--game-gap);bottom:var(--game-gap);z-index:40;min-width:0;display:flex;flex-direction:column;overflow:auto;background:#fff;border:1px solid var(--game-line);border-radius:18px;box-shadow:0 3px 0 #9387cf38}
#game-left{left:var(--game-gap);width:var(--game-left-w);padding:13px;gap:10px}
#game-right{right:var(--game-gap);width:var(--game-right-w)}
#game-left h2{margin:3px 0 0;font-size:19px;line-height:1.3}
.game-side-kicker{color:var(--game-purple);font-size:11px;font-weight:800}
.game-side-section{background:var(--game-paper);border:1px solid var(--game-line);border-radius:12px;padding:9px}
.game-side-label{font-size:12px;font-weight:850;margin-bottom:4px}
#research-player-room,#shanyi-room{color:var(--game-purple);font-size:12px;overflow-wrap:anywhere;margin-top:4px}
#research-player-status,#shanyi-status{font-size:12px;color:#0c6752;margin-top:3px}
#shanyi-peer,.game-side-hint,.game-side-foot{font-size:11px;color:var(--game-muted);line-height:1.55}
.game-side-actions{display:grid;gap:6px}
.game-side-actions button,.game-side-actions a,.vote-actions button,.game-chat-form button{min-height:36px;background:#eee5ff;border:1px solid #dacaf8;color:var(--game-purple);border-radius:9px;padding:6px 9px;font:700 12px/1.35 system-ui,sans-serif;cursor:pointer;text-decoration:none}
.game-side-actions a,.game-side-actions button:not(:disabled):hover,.vote-actions button:hover{background:#e9dbff}
.game-side-actions a,#shanyi-back{background:#ffdf5c;border-color:#ffdf5c;color:#573400;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 0 #e8aa18}
.game-side-actions a:hover,#shanyi-back:hover{background:#ffeb93}
.game-side-actions button:disabled{opacity:.48;cursor:default}
.game-side-foot{margin-top:auto;border-top:1px solid var(--game-line);padding-top:8px}
.game-chat-head{display:flex;align-items:center;justify-content:space-between;padding:12px;border-bottom:1px solid var(--game-line);background:var(--game-paper)}
.game-chat-head b{font-size:14px}.game-chat-head span{display:block;color:var(--game-muted);font-size:11px;margin-top:3px}
.game-chat-dot{width:9px;height:9px;border-radius:50%;background:#18a46e;box-shadow:0 0 0 3px #cef1e5}
.game-chat-log{flex:1;overflow:auto;min-height:0;padding:10px;display:flex;flex-direction:column;gap:9px}
.game-chat-empty{margin:auto;color:var(--game-muted);font-size:12px;text-align:center;line-height:1.55}
.game-chat-msg{display:flex;gap:7px;align-items:flex-start;max-width:94%}
.game-chat-msg.mine{align-self:flex-end;flex-direction:row-reverse}
.game-chat-avatar{width:27px;height:27px;border-radius:8px;flex:0 0 27px;display:grid;place-items:center;font-size:13px;background:var(--bubble-avatar,#afe0ff);border:2px solid #fff}
.game-chat-meta{display:flex;flex-wrap:wrap;gap:2px 5px;align-items:baseline;font-size:10px;color:var(--game-muted);margin-bottom:2px}
.game-chat-meta b{color:var(--game-ink)}.game-chat-msg.mine .game-chat-meta{justify-content:flex-end}
.game-chat-bubble{background:var(--game-paper);border-radius:4px 12px 12px 12px;padding:6px 8px;color:var(--game-ink);font-size:12px;line-height:1.5;overflow-wrap:anywhere;white-space:pre-wrap}
.game-chat-msg.mine .game-chat-bubble{background:#e8dcff;border-radius:12px 4px 12px 12px}
.game-chat-form{display:flex;gap:6px;padding:8px;border-top:1px solid var(--game-line)}
.game-chat-form input{flex:1;min-width:0;background:#fff;border:1px solid var(--game-line);color:var(--game-ink);border-radius:8px;padding:7px;font:inherit;font-size:12px}
.game-chat-form input::placeholder{color:var(--game-muted)}
.game-chat-form button,.vote-actions .primary{background:var(--game-purple);border-color:var(--game-purple);color:#fff}
.game-chat-form button:hover,.vote-actions .primary:hover{background:#5724be}
.vote-mask{position:fixed;inset:0;z-index:100;background:#1f164d9e;display:flex;align-items:center;justify-content:center;padding:12px}
.vote-mask[hidden]{display:none!important}
.vote-dialog{width:min(100%,430px);background:#fff;color:var(--game-ink);border:2px solid #e3d6ff;border-radius:20px;padding:clamp(12px,4vw,22px);box-shadow:0 22px 50px #23173f55}
.vote-actions{display:flex;gap:7px;flex-wrap:wrap;justify-content:flex-end;margin-top:14px}
@media(max-width:1180px){:root{--game-left-w:175px;--game-right-w:200px;--game-gap:8px}}
@media(max-width:850px),(orientation:portrait){
  body.game-has-sidebars{height:auto;min-height:100%;overflow:auto;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px;padding:8px;align-items:start}
  .game-has-sidebars #game-center{position:relative;inset:auto;grid-column:1/-1;min-width:0;width:min(100%,900px);aspect-ratio:16/10;margin-inline:auto;border-width:2px;border-radius:13px}
  #game-left,#game-right{position:relative;inset:auto;width:100%;border-radius:12px}
  #game-right{max-height:280px;min-height:200px}
  .game-side-actions button,.game-side-actions a,.game-chat-form button,.vote-actions button{min-height:42px}
}
@media(max-width:470px){
  body.game-has-sidebars{grid-template-columns:minmax(0,1fr)}
  #game-left{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;padding:7px}
  .game-side-foot{grid-column:1/-1}
  .game-chat-form input{font-size:16px}
}
@media(max-width:850px) and (max-height:600px) and (orientation:landscape) and (pointer:coarse){
  .game-has-sidebars #game-center{width:min(100%,calc((100dvh - 16px) * 16 / 10))}
}
.game-has-sidebars>.match-touch{grid-column:1/-1;min-width:0;width:min(100%,900px);margin-inline:auto}
@media(orientation:landscape) and (any-pointer:coarse){
  body.game-has-sidebars:has(>.match-touch:not([hidden])){
    height:auto;min-height:100%;overflow:auto;display:grid;
    grid-template-columns:minmax(0,1fr) clamp(140px,20vw,180px);
    gap:8px;padding:8px;align-items:start
  }
  .game-has-sidebars:has(>.match-touch:not([hidden])) #game-center{
    position:relative;inset:auto;grid-column:1;min-width:0;width:min(100%,calc((100dvh - 16px) * 16 / 10));
    aspect-ratio:16/10;margin-inline:auto;border-width:2px;border-radius:13px
  }
  .flash-shell:has(>.match-touch:not([hidden])) #game-center{
    width:min(100%,calc((100dvh - 16px) * 4 / 3));aspect-ratio:4/3
  }
  .game-has-sidebars:has(>.match-touch:not([hidden])) :is(#game-left,#game-right){
    position:relative;inset:auto;width:100%;border-radius:12px
  }
  .game-has-sidebars>.match-touch{grid-column:2;align-self:center;flex-direction:column}
}
`;
function playerUi(playerConfig) {
  const chatScript=playerConfig?.chatWsUrl?`<script>window.__GAME_CHAT__=${jsonScript({wsUrl:playerConfig.chatWsUrl})};</script>`:'';
  const gameTitle=String(playerConfig?.title??'森林冰火人').replace(/[<>&]/g,'');
  return `
<aside id="game-left" class="game-left">
  <div><div class="game-side-kicker">联机 · 非公开发行</div><h2>${gameTitle}</h2><div id="research-player-room"></div>
    <div id="research-player-seats" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:5px"></div></div>
  <section class="game-side-section"><div class="game-side-label">当前状态</div><div id="research-player-status" aria-live="polite">正在初始化原生关卡…</div></section>
  <section class="game-side-section"><div class="game-side-label">操作</div><div class="game-side-actions">
    <button id="research-player-restart" disabled type="button">自动重开 (R)</button>
    <button id="research-player-next" disabled type="button">下一关投票 (N)</button>
    <button id="research-player-return" disabled type="button">返回选关（投票）</button>
    <a id="research-player-lobby" href="/">返回大厅</a>
  </div></section>
  <section class="game-side-section"><div class="game-side-label">按键提示</div><div class="game-side-hint">A/D 或 ←/→ 移动 · W/↑/Space 跳跃<br>P 暂停 · 死亡自动重开 · N 下一关</div></section>
  <div class="game-side-foot">权威浏览器运行 · 每个标签页观看同一关卡<br>本机 / 局域网 / FRP</div>
</aside>
<aside id="game-right" class="game-chat-side">
  <div class="game-chat-head"><div><b>房间聊天</b><span id="game-chat-status">连接中…</span></div><span class="game-chat-dot"></span></div>
  <div class="game-chat-log" id="game-chat-log"></div>
  <form class="game-chat-form" id="game-chat-form"><input id="game-chat-input" maxlength="500" autocomplete="off" placeholder="发送消息…"><button type="submit">发送</button></form>
</aside>
<div id="research-vote" class="vote-mask" hidden>
  <div class="vote-dialog"><div id="research-vote-title" style="font-size:17px;font-weight:bold;margin-bottom:8px">关卡结束</div>
    <div id="research-vote-text" style="color:var(--game-muted);line-height:1.6">等待所有玩家确认</div>
    <div class="vote-actions"><button id="research-vote-cancel" type="button">取消</button><button id="research-vote-confirm" class="primary" type="button">确定</button></div></div>
</div>
<div id="research-return-vote" class="vote-mask" hidden>
  <div class="vote-dialog"><div id="research-return-title" style="font-size:17px;font-weight:bold;margin-bottom:8px">返回选关</div>
    <div id="research-return-text" style="color:var(--game-muted);line-height:1.6">所有玩家确认后一起回到选关界面</div>
    <div class="vote-actions"><button id="research-return-cancel" type="button">继续游戏</button><button id="research-return-confirm" class="primary" type="button">确定返回</button></div></div>
</div>
${chatScript}
<script type="application/json" id="research-player-config">${jsonScript(playerConfig)}</script>
<script type="module" src="/__research__/local-player.mjs"></script>
${chatScript?'<script type="module" src="/__lobby__/game-chat.mjs"></script>':''}`;
}

function authoredPage(script, requireScript, playerConfig=null, {storagePrefix=null}={}) {
  const scriptUrl = script.split('/').map(encodeURIComponent).join('/');
  const unlock = storagePrefix ? `<script>try{localStorage.setItem(${jsonScript(storagePrefix+':unlock')},'1');localStorage.removeItem(${jsonScript(storagePrefix+':invulnerable')});}catch(e){}</script>` : '';
  const ui = playerConfig ? playerUi(playerConfig) : '';
  const pageTitle = playerConfig?.title
    ? String(playerConfig.title).replace(/[<>&]/g,'')+' · 联机'
    : 'HTML5 instrumented research harness';
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${pageTitle}</title>
<style>${GAME_SHELL_CSS}#research-notice{position:fixed;z-index:2147483645;bottom:4px;left:50%;transform:translateX(-50%);padding:3px 8px;background:#111c;color:#fff;font:11px sans-serif;pointer-events:none;border-radius:4px}</style>
</head><body${playerConfig?' class="game-has-sidebars"':''}>
${unlock}
<div id="game-center"><div id="root"><div id="container"></div><div id="hammer"></div><div id="debug-fps"></div></div></div>
${playerConfig?'':'<div id="research-notice">Instrumented research harness · 非原包基准</div>'}
<script>window.h5api=window.h5api||{progress:function(){}};</script>
<script>/* The served game script reads this instead of window.innerWidth/innerHeight. */
window.__gameViewportSize=function(){var node=document.getElementById('container')||document.getElementById('game-center');
var width=node&&node.clientWidth,height=node&&node.clientHeight;
return {width:Math.max(1,width||window.innerWidth||1),height:Math.max(1,height||window.innerHeight||1)};};</script>
<script data-main="/${scriptUrl}" src="/${requireScript}"></script>
${ui}
</body></html>\n`;
}

function flashPage({wrapperUrl,coreUrl,title,chatWsUrl=null}) {
  const config = jsonScript({wrapperUrl,coreUrl});
  const chatScript = chatWsUrl ? `<script>window.__GAME_CHAT__=${jsonScript({wsUrl:chatWsUrl})};</script>` : '';
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${String(title??'Flash').replace(/[<>&]/g,'')} · 实验性输入镜像联机</title>
<style>${GAME_SHELL_CSS}
#stage{position:relative;width:min(100%,calc((100dvh - 36px) * 4 / 3));aspect-ratio:4/3;background:#000;line-height:0;overflow:hidden}
#player,#player>ruffle-player{display:block;width:100%!important;height:100%!important}
#shanyi-gate{position:absolute;inset:0;background:#1d153eed;display:flex;align-items:center;justify-content:center;z-index:5;pointer-events:auto;text-align:center;line-height:1.6;padding:14px}
#shanyi-gate[hidden]{display:none}#shanyi-gate b{display:block;font-size:18px;color:#ffdb5f;margin-bottom:8px}#shanyi-gate p{margin:0;color:#f1eaff}
#shanyi-gate .gate-progress{width:min(280px,70vw);margin:14px auto 0}
#shanyi-gate .gate-readout{display:flex;align-items:baseline;justify-content:center;gap:2px;margin-bottom:6px;color:#ffdb5f;font-variant-numeric:tabular-nums}
#shanyi-gate .gate-readout b{display:inline;font-size:26px;line-height:1;margin:0}
#shanyi-gate .gate-readout span{font-size:13px;font-weight:750;color:#c7b8ee}
#shanyi-gate .gate-track{height:10px;border-radius:999px;background:#3a2c68;overflow:hidden;box-shadow:inset 0 1px 2px #120c28}
#shanyi-gate .gate-track>span{display:block;width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,#ffc93c,#ff9f43 60%,#ffd873);transition:width .42s cubic-bezier(.22,.68,.32,1)}
@media (prefers-reduced-motion:reduce){#shanyi-gate .gate-track>span{transition:none}}
#shanyi-back{width:100%}
@media(max-width:850px),(orientation:portrait){.flash-shell #game-center{aspect-ratio:4/3}#stage{width:100%}}
@media(max-width:850px) and (max-height:600px) and (orientation:landscape) and (pointer:coarse){
  .flash-shell #game-center{width:min(100%,calc((100dvh - 16px) * 4 / 3))}
}
</style></head>
<body class="game-has-sidebars flash-shell">
<div id="game-center"><div id="stage"><div id="player"></div>
  <div id="shanyi-gate"><div><b>等待玩家就位</b><p id="shanyi-gate-text">正在加载游戏…</p>
    <div class="gate-progress"><div class="gate-readout" aria-hidden="true"><b id="shanyi-gate-percent">0</b><span>%</span></div>
    <div class="gate-track" role="progressbar" aria-label="游戏加载进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="shanyi-gate-fill"></span></div></div>
  </div></div>
</div></div>
<aside id="game-left" class="game-left">
  <div><div class="game-side-kicker">实验性输入镜像 · 非公开发行</div><h2>闪翼双星</h2><div id="shanyi-room"></div></div>
  <section class="game-side-section"><div class="game-side-label">当前状态</div><div id="shanyi-status" aria-live="polite">正在加载 Ruffle 运行时…</div><div id="shanyi-peer"></div></section>
  <section class="game-side-section"><div class="game-side-label">操作</div><div class="game-side-actions"><button id="shanyi-back" type="button">返回选关大厅</button></div></section>
  <section class="game-side-section"><div class="game-side-label">按键提示</div><div class="game-side-hint">火男 W/A/S/D · 水女 ↑←↓→<br>每位玩家各跑一份本地游戏；没有画面/状态权威</div></section>
  <div class="game-side-foot">实验性输入镜像 · 本机 / 局域网 / FRP<br>长时间同步和复杂机关仍需验证</div>
</aside>
<aside id="game-right" class="game-chat-side">
  <div class="game-chat-head"><div><b>房间聊天</b><span id="game-chat-status">连接中…</span></div><span class="game-chat-dot"></span></div>
  <div class="game-chat-log" id="game-chat-log"></div>
  <form class="game-chat-form" id="game-chat-form"><input id="game-chat-input" maxlength="500" autocomplete="off" placeholder="发送消息…"><button type="submit">发送</button></form>
</aside>
${chatScript}
<script src="/__ruffle__/ruffle.js"></script>
<script>window.__SHANYI_CONFIG__=${config};</script>
<script type="module" src="/__research__/shanyi-client.mjs"></script>
${chatScript?'<script type="module" src="/__lobby__/game-chat.mjs"></script>':''}
</body></html>\n`;
}

function lobbyPage(lobbyWsUrl, viewerOrigin, override=null) {
  const config = jsonScript(override ?? {wsUrl:lobbyWsUrl,viewerOrigin});
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#1878ec"><title>肥鱼乐园 · 联机大厅</title>
<style>#lobby-boot{box-sizing:border-box;width:min(420px,calc(100% - 28px));margin:14vh auto;padding:24px;border:3px solid #e6ddff;border-radius:21px;background:#fff;color:#20215c;text-align:center;font:16px system-ui,sans-serif}#lobby-boot p{margin:8px 0}#lobby-boot button{margin-top:10px}
#lobby-boot .lobby-boot-progress{margin:14px 0 2px}
#lobby-boot .lobby-boot-readout{display:flex;align-items:baseline;justify-content:flex-end;gap:2px;margin-bottom:7px;color:#1878ec;font-variant-numeric:tabular-nums}
#lobby-boot .lobby-boot-readout b{font-size:29px;font-weight:850;line-height:1}
#lobby-boot .lobby-boot-readout span{font-size:14px;font-weight:750;color:#8b93ad}
#lobby-boot .lobby-boot-track{height:11px;border-radius:999px;background:#e2ecfb;box-shadow:inset 0 1px 2px #bcd2ef;overflow:hidden}
#lobby-boot .lobby-boot-track>span{display:block;width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,#1878ec,#4aa3ff 62%,#7cc4ff);transition:width .42s cubic-bezier(.22,.68,.32,1)}
body:has(#lobby-boot){background-color:#64c7f5}</style>
</head><body>
<div id="app"><div id="lobby-boot"><strong>肥鱼乐园</strong><p id="lobby-boot-status" role="status">正在载入联机大厅…</p>
<div class="lobby-boot-progress"><div class="lobby-boot-readout" aria-hidden="true"><b id="lobby-boot-percent">0</b><span>%</span></div>
<div class="lobby-boot-track" role="progressbar" aria-label="大厅载入进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span id="lobby-boot-fill"></span></div></div>
<button type="button" hidden>重新加载</button></div></div>
<script>
window.__LOBBY_CONFIG__=${config};
(async()=>{
  const boot=document.getElementById('lobby-boot'),status=document.getElementById('lobby-boot-status');
  const button=boot.querySelector('button');
  const percentEl=document.getElementById('lobby-boot-percent');
  const fillEl=document.getElementById('lobby-boot-fill');
  const trackEl=boot.querySelector('.lobby-boot-track');
  button.onclick=()=>location.reload();
  let shown=0,target=0,raf=0,from=0,at=0;
  const easeOut=t=>1-(1-t)**3;
  function paint(value){
    shown=value;const rounded=Math.round(value);
    fillEl.style.width=value+'%';percentEl.textContent=String(rounded);
    trackEl.setAttribute('aria-valuenow',String(rounded));
  }
  function goTo(value){
    target=Math.min(100,Math.max(target,value));
    if(raf)return;
    from=shown;at=performance.now();
    const step=now=>{
      const t=Math.min(1,(now-at)/420);
      paint(from+(target-from)*easeOut(t));
      raf=t<1?requestAnimationFrame(step):0;
    };
    raf=requestAnimationFrame(step);
  }
  function creep(limit){
    const timer=setInterval(()=>{
      if(shown>=limit||target>=limit){clearInterval(timer);return;}
      goTo(Math.min(limit,target+1.3));
    },420);
    return()=>clearInterval(timer);
  }
  goTo(6);
  function stylesheet(search){
    return new Promise(resolve=>{
      const link=document.createElement('link');
      const done=ready=>{clearTimeout(timer);link.onload=link.onerror=null;if(!ready)link.remove();resolve(ready);};
      const timer=setTimeout(()=>done(false),4000);
      link.rel='stylesheet';link.href='/__lobby__/lobby.css'+search;
      link.onload=()=>done(true);link.onerror=()=>done(false);
      document.head.appendChild(link);
    });
  }
  let styled=false;
  for(const attempt of [0,1,2]){
    const search='?entry='+attempt;
    if(attempt)status.textContent='正在重新连接大厅…';
    if(!styled)styled=await stylesheet(search);
    if(!styled){goTo(14+attempt*4);continue;}
    goTo(38);
    window.__LOBBY_BOOT_ATTEMPT__=String(attempt);
    let timer;
    const stopCreep=creep(92);
    const imported=import('/__lobby__/lobby.mjs'+search).then(()=>true,()=>false);
    const ready=await Promise.race([imported,new Promise(resolve=>{timer=setTimeout(()=>resolve(false),5000);})]);
    clearTimeout(timer);
    stopCreep();
    if(ready){goTo(100);return;}
    if(!boot.isConnected)return;
    window.__LOBBY_BOOT_ATTEMPT__='';
  }
  status.textContent='大厅暂时无法加载，请重试。';
  button.hidden=false;
})();
</script>
</body></html>\n`;
}

const LOBBY_HTTP_ROUTES = new Map([
  ['/api/games', ['GET']],
  ['/api/rooms', ['GET','POST']],
  ['/api/rooms/join', ['POST']],
  ['/api/rooms/spectate', ['POST']],
]);
const LOBBY_REACHABILITY_PATH = '/__lobby__/reachability';

function lobbyNetworkOrigin(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch {}
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.pathname !== '/' ||
      url.username || url.password || url.search || url.hash)
    throw failure('HTML5_INVALID_NETWORK_ORIGIN', 'Lobby network entries must be HTTP(S) origins.');
  return url.origin;
}

function lockstepPage({id: gameId, title, bridgeUrl}, lobbyWsUrl) {
  const safeTitle = title.replace(/[<>&]/g, '');
  return `<!doctype html>
<html lang="zh-CN">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${safeTitle} · 联机对战</title>
<link rel="stylesheet" href="/__lockstep__/loading.css">
<style>
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:linear-gradient(155deg,#b9e8ff,#e0f0ff 43%,#eee5ff);color:#20215c;font:16px system-ui,sans-serif}
main{width:min(1500px,100%);margin:auto;padding:clamp(12px,2.5vw,32px)}
header{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;padding:10px 13px;background:#fff;border:1px solid #dcd8f3;border-radius:16px}
h1{margin:0;font-size:clamp(18px,4vw,28px)}button{color:#573400;background:#ffda4f;border:1px solid #ffda4f;padding:7px 11px;min-height:42px;border-radius:10px;font:700 13px system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 0 #e5ad19}
button:focus-visible{outline:2px solid #783af0;outline-offset:2px}#match-status{color:#514775}
.match-layout{margin-top:14px;display:grid;grid-template-columns:clamp(135px,14vw,192px) minmax(0,1fr) clamp(135px,14vw,192px);align-items:start;gap:14px}
.match-panel{min-width:0;padding:14px;background:#fff;border:1px solid #ded7f0;border-radius:16px}
.match-panel h2{margin:0 0 10px;font-size:15px}.match-panel p,.match-panel footer{margin:8px 0;color:#514775;font-size:14px;overflow-wrap:anywhere}
footer kbd{display:inline-block;margin:2px 3px 2px 0;padding:2px 4px;background:#f0e8ff;border:1px solid #dacdf4;border-radius:4px;white-space:nowrap}
.render-settings{border-top:1px solid #e4dcf8;margin-top:12px;padding-top:12px}.render-settings label{display:block;font-weight:650;font-size:14px}
.render-settings select{width:100%;min-height:36px;margin-top:7px;border:1px solid #dacdf4;border-radius:7px;background:#f8f5ff;color:#20215c;padding:4px}
.render-settings small{display:block;margin-top:6px;color:#514775;font-size:12px}
dl{margin:0}dl div{display:flex;justify-content:space-between;gap:8px;margin:8px 0;font-size:13px}dt{color:#514775}dd{margin:0;min-width:0;text-align:right;overflow-wrap:anywhere;font-weight:650}
#match-view{background:#080518;border:3px solid #fff;border-radius:16px;box-shadow:0 0 0 1px #cabbe6;overflow:hidden}
#match-stage{display:grid;place-items:center;min-height:220px}#match-stage canvas,#match-stage ruffle-player{display:block;max-width:100%}
@media(max-width:760px){.match-layout{grid-template-columns:repeat(2,minmax(0,1fr))}#match-view{grid-row:1;grid-column:1/-1}}
</style></head>
<body><main>
<header><h1>${safeTitle}</h1><button id="match-return" type="button">返回房间</button></header>
<div class="match-layout">
  <aside class="match-panel" aria-labelledby="match-info-heading">
    <h2 id="match-info-heading">房间信息</h2>
    <p id="match-status" role="status">正在连接对战房间…</p>
    <dl><div><dt>房间</dt><dd id="match-room">—</dd></div><div><dt>玩家</dt><dd id="match-players">—</dd></div><div><dt>逻辑帧率</dt><dd id="match-fps">—</dd></div></dl>
  </aside>
  <div id="match-view"><div id="match-stage" aria-label="对战画面"></div></div>
  <aside class="match-panel" aria-labelledby="match-keys-heading">
    <h2 id="match-keys-heading">键位</h2><footer hidden></footer>
    ${gameId === 'bomb-it-7' ? `<div class="render-settings">
      <label for="match-render-quality">画质</label>
      <select id="match-render-quality" aria-describedby="match-render-size">
        <option value="auto">清晰</option><option value="performance">省性能</option>
      </select>
      <small id="match-render-size">下次加载时生效</small>
    </div>` : ''}
  </aside>
</div>
</main>
<script>window.__LOCKSTEP_CONFIG__=${jsonScript({gameId,bridgeUrl,lobbyWsUrl})};</script>
<script type="module" src="/__lockstep__/client.mjs"></script>
</body></html>`;
}

/**
 * @param {{root:string,script?:string,port?:number,games?:Array, lobbyWsUrl?:string}} options
 */
export async function startHtml5ResearchHost({root, script, port = 0, publicPort = null, requireScript = REQUIRE_SCRIPT, entryPath = '/', autoJoinWsUrl=null, autoJoinLevelId=1, games=null, lobbyWsUrl=null, lobbyHttpHandler=null, ruffleDir=null, host='127.0.0.1', publicHost=null, lanViewerOrigin=null, wanViewerOrigin=null, bvnProxy=null, glortonProxy=null, glortonBrowser=null, glortonLocalWebRoot=null, arenaViewerUpgrade=null, bombItSwf=null} = {}) {
  if (typeof root !== 'string' || !root.trim()) throw failure('HTML5_ROOT_REQUIRED', 'Provide the private first-game directory with --root.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw failure('HTML5_INVALID_PORT', 'port must be an integer from 0 to 65535.');
  if (publicPort !== null && (!Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65535))
    throw failure('HTML5_INVALID_PUBLIC_PORT', 'publicPort must be a TCP port when provided.');
  const multi = Array.isArray(games) && games.length > 0;
  const availableCovers = !multi ? [] : (await Promise.all(LOBBY_COVERS.map(async id => {
    try {
      const file = await lstat(path.join(REPO_ROOT, 'public/lobby/art/covers', id + '.webp'));
      return file.isFile() ? id : null;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  }))).filter(Boolean);
  const lanOrigin = lobbyNetworkOrigin(lanViewerOrigin);
  const wanOrigin = lobbyNetworkOrigin(wanViewerOrigin);
  const lanHost = lanOrigin ? new URL(lanOrigin).host : null;
  const displayHost = typeof publicHost === 'string' && publicHost.trim() ? publicHost.trim() : host;
  if (multi) {
    if (typeof lobbyWsUrl !== 'string' || !/^ws:\/\/[^\s/]+:\d+\/lobby$/.test(lobbyWsUrl))
      throw failure('HTML5_INVALID_LOBBY', 'lobbyWsUrl must be a /lobby WebSocket URL');
    if (autoJoinWsUrl !== null) throw failure('HTML5_INVALID_MODE', 'Multi-game mode owns its own matching');
  } else {
    if (typeof script !== 'string' || !script.trim()) throw failure('HTML5_INVALID_SCRIPT', 'script is required');
    script = relativePath(script);
    requireScript = relativePath(requireScript);
    if (path.extname(requireScript) !== '.js') throw failure('HTML5_INVALID_REQUIRE', 'requireScript must be a local JS file');
    if (typeof entryPath !== 'string' || !entryPath.startsWith('/') || entryPath.startsWith('//')) throw failure('HTML5_INVALID_ENTRY', 'entryPath must be a URL path');
    if (entryPath !== '/') relativePath(entryPath.slice(1));
    if (path.extname(script) !== '.js') throw failure('HTML5_INVALID_SCRIPT', 'script must identify a .js file inside the selected root.');
    if (autoJoinWsUrl !== null) {
      if (typeof autoJoinWsUrl !== 'string' || !/^ws:\/\/127\.0\.0\.1:\d+\/ws$/.test(autoJoinWsUrl) ||
         !Number.isSafeInteger(autoJoinLevelId) || autoJoinLevelId < 1)
        throw failure('HTML5_INVALID_AUTO_JOIN', 'Only a local loopback WebSocket and positive level ID may auto join');
    }
  }
  const gameRoot = path.resolve(root);
  const servedGames = new Map();
  const entryPages = new Map();
  const ensureGame = async game => {
    if (!game || typeof game.id !== 'string' || typeof game.script !== 'string' ||
        typeof game.entryPath !== 'string' || typeof game.requireScript !== 'string')
      throw failure('HTML5_INVALID_GAME', 'Game catalog entry is invalid');
    const scriptRel = relativePath(game.script);
    const requireRel = relativePath(game.requireScript);
    if (path.extname(scriptRel) !== '.js' || path.extname(requireRel) !== '.js')
      throw failure('HTML5_INVALID_GAME', 'Game scripts must be local JS files');
    if (!game.entryPath.startsWith('/') || game.entryPath.startsWith('//'))
      throw failure('HTML5_INVALID_GAME', 'Game entry path is invalid');
    if (game.entryPath !== '/') relativePath(game.entryPath.slice(1));
    const source = await readContainedFile(gameRoot, scriptRel).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        throw failure('HTML5_SOURCE_NOT_FOUND', `Original HTML5 source is missing: ${scriptRel}. Supply the private game package.`);
      }
      throw error;
    });
    await readContainedFile(gameRoot, requireRel).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        throw failure('HTML5_REQUIREJS_NOT_FOUND', `Required local loader is missing: ${requireRel}.`);
      }
      throw error;
    });
    const text = source.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(source)) throw failure('HTML5_SOURCE_ENCODING', 'The source must be valid UTF-8; no encoding conversion is performed.');
    const occurrences = text.split(INSTANCE_ANCHOR).length - 1;
    if (occurrences !== 1) throw failure('HTML5_INSTANCE_ANCHOR_COUNT', `Expected exactly one Game instance anchor; found ${occurrences}. No source was changed.`);
    // The original bundle sizes Phaser from window.innerWidth/innerHeight. In
    // this authored shell the game lives in a middle column, so both the boot
    // config and the native _resize() must read the column's client box
    // instead. Every match is the same "available screen area" read; when the
    // helper is absent the original expression is evaluated unchanged.
    const widthReads = text.split(VIEWPORT_WIDTH_READ).length - 1;
    const heightReads = text.split(VIEWPORT_HEIGHT_READ).length - 1;
    if (widthReads !== heightReads)
      throw failure('HTML5_VIEWPORT_ANCHOR_COUNT', `Expected matching viewport reads; found ${widthReads} width and ${heightReads} height. No source was changed.`);
    const instrumented = text.split(VIEWPORT_WIDTH_READ).join(VIEWPORT_WIDTH_INSTRUMENTED)
      .split(VIEWPORT_HEIGHT_READ).join(VIEWPORT_HEIGHT_INSTRUMENTED);
    const served = Buffer.from(instrumented.split(INSTANCE_ANCHOR).join(INSTANCE_EXPOSURE), 'utf8');
    const info = {
      id: game.id, title: game.title ?? game.id, templeId: game.templeId ?? game.id,
      adapter: game.adapter ?? 'fireboy-html5',
      storagePrefix: game.storagePrefix ?? 'fb-forest',
      script: scriptRel, requireScript: requireRel, entryPath: game.entryPath,
      sourceSha256: sha256(source), servedSha256: sha256(served),
      sourceBytes: source.length, viewportReads: widthReads, served,
    };
    servedGames.set(scriptRel, info);
    servedGames.set('/' + scriptRel, info);
    const entryNoSlash = game.entryPath.replace(/^\//, '');
    const dir = path.posix.dirname(entryNoSlash);
    entryPages.set(game.entryPath, info);
    entryPages.set('/' + entryNoSlash, info);
    if (dir && dir !== '.' && !entryPages.has('/' + dir + '/'))
      entryPages.set('/' + dir + '/', info);
    return info;
  };

  // html5-external：自带权威服务的第三方 HTML5 构建（如 TankTrouble 的 Colyseus
  // 房间）。这里只做静态托管，不注入侧栏/聊天，页面与大厅同源，资源保持相对路径。
  const externalGames = new Map();
  const externalEntries = new Map();
  const externalPrefixes = new Map();
  const ensureExternalGame = async game => {
    if (!game || typeof game.id !== 'string' || typeof game.dir !== 'string' ||
        typeof game.serveRoot !== 'string' || !path.isAbsolute(game.serveRoot))
      throw failure('HTML5_INVALID_GAME', 'External game catalog entry is invalid');
    const dirRel = relativePath(game.dir);
    const entryFile = typeof game.entryPath === 'string' && game.entryPath.startsWith('/')
      ? game.entryPath : '/' + dirRel + '/index.html';
    const entryRel = relativePath(entryFile.slice(1));
    const lockstep = game.runtime === LOCKSTEP_RUNTIME;
    const bridgeRel = lockstep ? dirRel + '/' + relativePath(game.bridgeFile) : null;
    const index = await readContainedFile(game.serveRoot, bridgeRel ?? entryRel).catch(error => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
        throw failure('HTML5_SOURCE_NOT_FOUND',
          `Game build is missing: ${bridgeRel ?? entryRel}.`);
      }
      throw error;
    });
    const info = {
      id: game.id, title: game.title ?? game.id, runtime: game.runtime,
      adapter: game.adapter ?? null, external: !lockstep, dir: dirRel,
      serveRoot: game.serveRoot, entryPath: entryFile,
      entryRel, indexBytes: index.length, script: null, requireScript: null,
      ...(lockstep ? {bridgeUrl: '/' + bridgeRel} : {}),
    };
    externalGames.set(game.id, info);
    externalEntries.set(entryFile, info);
    externalEntries.set('/' + dirRel + '/', info);
    externalPrefixes.set('/' + dirRel + '/', info);
    return info;
  };

  const flashGames = new Map();
  const flashEntries = new Map();
  const ruffleRoot = ruffleDir ? path.resolve(ruffleDir) : path.join(REPO_ROOT, 'local', 'tmp', 'ruffle-nightly');
  const ensureFlashGame = async game => {
    if (!game || typeof game.id !== 'string' || typeof game.dir !== 'string' ||
        typeof game.serveRoot !== 'string' || !path.isAbsolute(game.serveRoot) ||
        typeof game.wrapperFile !== 'string' || typeof game.gameFile !== 'string')
      throw failure('HTML5_INVALID_GAME', 'Flash game catalog entry is invalid');
    const dirRel = relativePath(game.dir);
    const wrapperRel = relativePath(game.wrapperFile);
    const coreRel = relativePath(game.gameFile);
    await readContainedFile(game.serveRoot, dirRel + '/' + wrapperRel);
    await readContainedFile(game.serveRoot, dirRel + '/' + coreRel);
    const entry = typeof game.entryPath === 'string' && game.entryPath.startsWith('/')
      ? game.entryPath : '/' + dirRel + '/index.html';
    const info = {
      id: game.id, title: game.title ?? game.id, runtime: 'flash-ruffle',
      adapter: game.adapter ?? 'flash-mirror', flash: true, dir: dirRel,
      serveRoot: game.serveRoot,
      wrapperUrl: '/game/' + game.id + '/' + wrapperRel,
      coreUrl: '/game/' + game.id + '/' + coreRel,
      entryPath: entry,
    };
    flashGames.set(game.id, info);
    flashEntries.set(entry, info);
    flashEntries.set('/' + dirRel + '/', info);
    return info;
  };

  let primary = null;
  if (multi) {
    for (const game of games) {
      const info = game.runtime === 'flash-ruffle' ? await ensureFlashGame(game)
        : ['html5-external', LOCKSTEP_RUNTIME, ARENA_RUNTIME, BRAWL_RUNTIME].includes(game.runtime) ? await ensureExternalGame(game)
        : await ensureGame(game);
      primary ??= info;
    }
  } else {
    primary = await ensureGame({
      id: 'forest', title: 'Forest', templeId: 'forest', storagePrefix: 'fb-forest',
      script, requireScript, entryPath,
    });
  }
  const sourceSha256 = primary.sourceSha256 ?? null;
  const servedSha256 = primary.servedSha256 ?? null;
  const sourceBytes = primary.sourceBytes ?? null;
  const hasBombIt = externalGames.get('bomb-it-7')?.runtime === LOCKSTEP_RUNTIME;
  let bombItOriginal;
  if (hasBombIt && bombItSwf) {
    try {
      const file = await lstat(bombItSwf);
      if (!file.isFile() || file.size !== ORIGINAL_SWF_BYTES) throw new Error('Unexpected SWF size or type');
      const bytes = await readFile(bombItSwf);
      if (bytes.length !== ORIGINAL_SWF_BYTES || sha256(bytes) !== ORIGINAL_SWF_SHA256)
        throw new Error('Unexpected SWF fingerprint');
      bombItOriginal = bytes;
    } catch (error) {
      console.warn('BOMB_IT_ORIGINAL_UNAVAILABLE: ' + (error.code ?? error.message));
    }
  }

  const manifestGames = [...new Map([
    ...servedGames.values(), ...flashGames.values(), ...externalGames.values(),
  ].map(info => [info.id, info])).values()]
    .map(({served, serveRoot, ...info}) => info);
  const manifest = Buffer.from(JSON.stringify({schema:1, kind:'instrumented-research-harness', originalPackageBaseline:false,
    script: primary.script, requireScript: primary.requireScript, entryPath: primary.entryPath,
    sourceSha256, servedSha256, sourceBytes, multiGame: multi,
    games: manifestGames,
    viewportInstrumentation:'Phaser viewport reads are redirected to #container clientWidth/clientHeight in the HTTP response only; originals unchanged.',
    transformation:'Expose the existing Game instance as window.__game and remap Phaser viewport reads to the authored #container in the HTTP response only; original files unchanged.'}) + '\n');
  let actualPort;
  let displayPort = publicPort;
  // The registered viewer accepts its own lobby socket. Keep the adjacent
  // port for clients that cannot reach the viewer's WebSocket upgrade.
  const requestClientConfig = req => {
    const requestHost = String(req.headers.host ?? '').trim();
    const hostName = requestHost.replace(/:\d+$/, '');
    const requestPort = Number((requestHost.match(/:(\d+)$/) || [])[1]) || displayPort || actualPort;
    const lobbyPort = Number(requestPort) + 1;
    const primary=arenaViewerUpgrade&&hostName===displayHost&&requestPort===displayPort
      ? {primaryWsUrl:`ws://${hostName}:${requestPort}/lobby`} : {};
    return {wsUrl:`ws://${hostName}:${lobbyPort}/lobby`, viewerOrigin:`http://${hostName}:${requestPort}`,...primary,
      ...(lobbyHttpHandler?{sameOriginLobby:true}:{}),lanOrigin,wanOrigin,availableCovers};
  };
  const server = http.createServer(async (req, res) => {
    const reply = (status, type, body, headers = {}) => {
      const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
      res.writeHead(status, {'content-type':type, 'content-length':bytes.length, 'cache-control':'no-store',
        'x-content-type-options':'nosniff', 'referrer-policy':'no-referrer', ...headers});
      res.end(req.method === 'HEAD' ? undefined : bytes);
    };
    try {
      const requestHost = String(req.headers.host ?? '');
      const hostName = requestHost.replace(/:\d+$/, '');
      // Accept loopback, LAN and FRP hostnames on any port: a reverse proxy or
      // FRP tunnel may publish this server on a port we cannot predict, and the
      // per-request client config already derives the matching lobby port.
      const portOk = /:\d{1,5}$/.test(requestHost);
      if (!/^[A-Za-z0-9._-]+$/.test(hostName) || !portOk) {
        return reply(403, 'text/plain; charset=utf-8', 'Host not allowed');
      }
      const rawPath = (req.url ?? '').split('?')[0];
      if (!rawPath.startsWith('/') || rawPath.startsWith('//') || /%2f|%5c/i.test(rawPath)) {
        throw failure('HTML5_UNSAFE_PATH', 'Invalid request path.', 403);
      }
      let pathname;
      try { pathname = decodeURIComponent(rawPath); }
      catch { throw failure('HTML5_INVALID_ENCODING', 'Invalid URL encoding.'); }
      if (bvnProxy?.handleHttp(req,res,pathname,reply)) return;
      if (glortonBrowser && await glortonBrowser.handleHttp(req,res,pathname,reply)) return;
      if (multi && pathname===GLORTON_HEALTH_PATH) {
        if (!['GET','HEAD'].includes(req.method)) return reply(405,'text/plain; charset=utf-8','Method Not Allowed');
        if (!glortonProxy) return reply(503,'application/json; charset=utf-8','{"ok":false}');
        return await glortonProxy.handleHealth(req,reply);
      }
      const lobbyMethods=multi&&lobbyHttpHandler?LOBBY_HTTP_ROUTES.get(pathname):null;
      if(lobbyMethods){
        if(!lobbyMethods.includes(req.method))return reply(405,'text/plain; charset=utf-8','Method Not Allowed');
        return await lobbyHttpHandler(req,res);
      }
      if (!['GET','HEAD'].includes(req.method)) return reply(405, 'text/plain; charset=utf-8', 'Method Not Allowed');
      if (hasBombIt && pathname === ORIGINAL_SWF_PATH) {
        if (!bombItOriginal) return reply(503, 'text/plain; charset=utf-8', 'Original game asset unavailable');
        const etag = `"${ORIGINAL_SWF_SHA256}"`;
        const headers = {etag, 'cache-control': 'private, max-age=31536000, immutable'};
        if (req.headers['if-none-match']?.split(',').some(value => [etag, 'W/' + etag, '*'].includes(value.trim()))) {
          res.writeHead(304, headers);
          return res.end();
        }
        return reply(200, TYPES['.swf'], bombItOriginal, headers);
      }
      if (multi) {
        if (pathname===GLORTON_BROWSER_HEALTH_PATH) return reply(503,'application/json; charset=utf-8','{"ok":false}');
        if (['/glorton-online/local-session.mjs','/glorton-online/local-hud.mjs','/glorton-online/frame-wire.mjs'].includes(pathname)) {
          return reply(200,'text/javascript; charset=utf-8',
            await readContainedFile(REPO_ROOT,'public'+pathname));
        }
        if (glortonLocalWebRoot && pathname.startsWith(GLORTON_LOCAL_PREFIX)) {
          const relative=pathname.slice(GLORTON_LOCAL_PREFIX.length)||'index.html';
          const ext=path.extname(relative);
          if(!GLORTON_LOCAL_FILES.has(ext))return reply(404,'text/plain; charset=utf-8','Not Found');
          const bytes=await readContainedFile(glortonLocalWebRoot,relative);
          if(relative==='index.html'){
            const html=bytes.toString('utf8');
            const module='<script type="module" src="/glorton-online/local-session.mjs"></script>';
            return reply(200,'text/html; charset=utf-8',/<head(?:\s[^>]*)?>/i.test(html)
              ?html.replace(/<head(?:\s[^>]*)?>/i,tag=>tag+module):module+html);
          }
          const type=TYPES[ext]??(ext==='.mjs'?'text/javascript; charset=utf-8':'application/octet-stream');
          return reply(200,type,bytes,{'cache-control':'private, max-age=3600'});
        }
        if (pathname === '/glorton-online/launcher.py') {
          return reply(200,'application/octet-stream',await readContainedFile(REPO_ROOT,'scripts/launch-glorton-client.py'),
            {'content-disposition':'attachment; filename="launch-glorton-client.py"'});
        }
        if (pathname === LOBBY_REACHABILITY_PATH) {
          if (!lanHost || requestHost.toLowerCase() !== lanHost) return reply(404, 'text/plain; charset=utf-8', 'Not Found');
          const source = req.headers.origin;
          if (source && source !== lanOrigin && source !== wanOrigin)
            return reply(403, 'text/plain; charset=utf-8', 'Origin not allowed');
          const nonce = new URL(req.url, lanOrigin).searchParams.get('nonce') ?? '';
          if (!/^[a-f0-9]{24}$/.test(nonce)) return reply(400, 'text/plain; charset=utf-8', 'Invalid probe');
          const headers = source ? {'access-control-allow-origin':source, vary:'Origin'} : {vary:'Origin'};
          return reply(200, 'application/json; charset=utf-8',
            JSON.stringify({kind:'lobby-reachability',origin:lanOrigin,nonce}), headers);
        }
        if (pathname === '/' || pathname === '/index.html')
          return reply(200, 'text/html; charset=utf-8', lobbyPage(lobbyWsUrl, `http://${displayHost}:${displayPort}`, requestClientConfig(req)));
        if (pathname.startsWith('/__lobby__/')) {
          const name = pathname.slice('/__lobby__/'.length);
          if (LOBBY_ART.has(name))
            return reply(200, TYPES[path.extname(name)], await readContainedFile(REPO_ROOT, 'public/lobby/' + name),
              {'cache-control':'public, max-age=3600'});
          if (!LOBBY_FILES.has(name)) return reply(404, 'text/plain; charset=utf-8', 'Not Found');
          const type = name.endsWith('.css') ? 'text/css; charset=utf-8'
            : name.endsWith('.mjs') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
          return reply(200, type, await readContainedFile(REPO_ROOT, 'public/lobby/' + name));
        }
        if(pathname.startsWith('/__lockstep__/')){
          const name=pathname.slice('/__lockstep__/'.length);
          if(!LOCKSTEP_FILES.has(name))return reply(404,'text/plain; charset=utf-8','Not Found');
          return reply(200,name.endsWith('.css')?TYPES['.css']:TYPES['.js'],
            await readContainedFile(REPO_ROOT,'public/lockstep/'+name));
        }
      } else if (pathname === entryPath || (entryPath === '/' && pathname === '/index.html')) {
        return reply(200, 'text/html; charset=utf-8', authoredPage(primary.script, primary.requireScript,
          autoJoinWsUrl ? {wsUrl:autoJoinWsUrl,levelId:autoJoinLevelId,gameId:primary.id,
            templeId:primary.templeId,storagePrefix:primary.storagePrefix,servedSha256:primary.servedSha256,
            smooth:true} : null, {storagePrefix:primary.storagePrefix}));
      }
      if (pathname === '/__research__/manifest') return reply(200, 'application/json; charset=utf-8', manifest);
      if (pathname === '/__research__/local-player.mjs' && (multi || autoJoinWsUrl))
        return reply(200, 'text/javascript; charset=utf-8',
          await readContainedFile(REPO_ROOT, 'scripts/html5-local-player.mjs'));
      if ((multi || autoJoinWsUrl) && ['/__research__/touch.mjs','/__research__/touch.css'].includes(pathname)) {
        const name = pathname.slice('/__research__/'.length);
        return reply(200, name.endsWith('.css') ? TYPES['.css'] : TYPES['.js'],
          await readContainedFile(REPO_ROOT, 'public/tank-arena/' + name));
      }
      if (externalEntries.has('/platform-brawl/index.html') &&
          ['/platform-brawl/touch.mjs','/platform-brawl/touch.css'].includes(pathname)) {
        const name = path.posix.basename(pathname);
        return reply(200, name.endsWith('.css') ? TYPES['.css'] : TYPES['.js'],
          await readContainedFile(REPO_ROOT, 'public/tank-arena/' + name));
      }
      // html5-external：整目录静态托管。页面用相对路径引用 ./assets/*，因此
      // 只做原样转发，不改写 HTML、不注入侧栏；入口目录本身返回 index.html。
      const externalEntry = externalEntries.get(pathname);
      if (externalEntry?.runtime === LOCKSTEP_RUNTIME)
        return reply(200, 'text/html; charset=utf-8',
          lockstepPage(externalEntry,requestClientConfig(req).primaryWsUrl??lobbyWsUrl));
      if (externalEntry) {
        return reply(200, 'text/html; charset=utf-8',
          await readContainedFile(externalEntry.serveRoot, externalEntry.entryRel),
          externalEntry.runtime===ARENA_RUNTIME?{'x-tank-arena-entry':'1'}
            :externalEntry.runtime===BRAWL_RUNTIME?{'x-platform-brawl-entry':'1'}:{});
      }
      for (const [prefix, externalInfo] of externalPrefixes) {
        if (!pathname.startsWith(prefix)) continue;
        const rest = pathname.slice(prefix.length);
        const file = rest ? relativePath(rest) : 'index.html';
        const ext = path.extname(file).toLowerCase();
        const esModule = ext === '.mjs' && [LOCKSTEP_RUNTIME, ARENA_RUNTIME, BRAWL_RUNTIME].includes(externalInfo.runtime);
        const moviePage = externalInfo.runtime === LOCKSTEP_RUNTIME && file === 'movie.html';
        const type = moviePage ? 'text/html; charset=utf-8' : esModule ? TYPES['.js'] : TYPES[ext];
        if (!type) return reply(404, 'text/plain; charset=utf-8', 'Not Found');
        const immutableRuntime = externalInfo.runtime === LOCKSTEP_RUNTIME &&
          /^runtime\/(?:core\.ruffle\.[a-f0-9]{20}\.js|[a-f0-9]{20}\.wasm)$/.test(file);
        return reply(200, type,
          await readContainedFile(externalInfo.serveRoot, externalInfo.dir + '/' + file),
          immutableRuntime ? {'cache-control':'public, max-age=31536000, immutable'} : {});
      }
      const flashEntry = flashEntries.get(pathname);
      if (flashEntry)
        return reply(200, 'text/html; charset=utf-8', flashPage({
          wrapperUrl: flashEntry.wrapperUrl, coreUrl: flashEntry.coreUrl,
          title: flashEntry.title, chatWsUrl: requestClientConfig(req).wsUrl,
        }));
      if (flashGames.size && pathname === '/__research__/shanyi-client.mjs')
        return reply(200, 'text/javascript; charset=utf-8',
          await readContainedFile(REPO_ROOT, 'scripts/shanyi-mirror-client.mjs'));
      if (flashGames.size && pathname.startsWith('/__ruffle__/')) {
        const name = pathname.slice('/__ruffle__/'.length);
        if (!/^(ruffle\.js(\.map)?|ruffle_web[a-zA-Z0-9_.-]*\.wasm|LICENSE_[A-Z]+|README\.md|package\.json)$/.test(name))
          return reply(404, 'text/plain; charset=utf-8', 'Not Found');
        const type = name.endsWith('.wasm') ? 'application/wasm'
          : name.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : 'application/octet-stream';
        return reply(200, type, await readContainedFile(ruffleRoot, name));
      }
      if (flashGames.size && pathname.startsWith('/game/')) {
        const parts = pathname.slice('/game/'.length).split('/');
        let flashInfo = flashGames.get(parts[0]);
        let fileParts = parts.slice(1);
        if (!flashInfo && flashGames.size === 1) {
          flashInfo = [...flashGames.values()][0];
          fileParts = parts;
        }
        if (!flashInfo || !fileParts.length || fileParts.some(part => !part))
          return reply(404, 'text/plain; charset=utf-8', 'Not Found');
        const file = relativePath(fileParts.join('/'));
        const type = TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
        return reply(200, type, await readContainedFile(flashInfo.serveRoot, flashInfo.dir + '/' + file));
      }
      const entry = entryPages.get(pathname);
      if (entry && multi) {
        return reply(200, 'text/html; charset=utf-8', authoredPage(entry.script, entry.requireScript,
          {gameId:entry.id,templeId:entry.templeId,storagePrefix:entry.storagePrefix,
            servedSha256:entry.servedSha256,title:entry.title,smooth:true,chatWsUrl:requestClientConfig(req).wsUrl},
          {storagePrefix:entry.storagePrefix}));
      }
      const relative = relativePath(pathname.slice(1));
      if (relative.startsWith(MODULE_PREFIX)) {
        const name = relative.slice(MODULE_PREFIX.length);
        if (!MODULE_NAMES.has(name)) return reply(403, 'text/plain; charset=utf-8', 'Adapter module is not allowlisted');
        return reply(200, 'text/javascript; charset=utf-8', await readContainedFile(REPO_ROOT, MODULE_PREFIX + name));
      }
      if (relative.startsWith('adapters/')) return reply(403, 'text/plain; charset=utf-8', 'Adapter module is not allowlisted');
      const type = TYPES[path.extname(relative).toLowerCase()];
      if (!type) return reply(404, 'text/plain; charset=utf-8', 'Not Found');
      const servedGame = servedGames.get(relative);
      if (servedGame) return reply(200, type, servedGame.served);
      try {
        return reply(200, type, await readContainedFile(gameRoot, relative));
      } catch (error) {
        const shared = sharedAssetRelative(relative);
        if (shared && (error.code === 'HTML5_NOT_FOUND' || error.code === 'ENOENT'))
          return reply(200, type, await readContainedFile(gameRoot, shared));
        throw error;
      }
    } catch (error) {
      const status = ['ENOENT','ENOTDIR'].includes(error.code) ? 404 : error.code === 'ELOOP' ? 403 : (error.status ?? 500);
      if (!res.headersSent) reply(status, 'application/json; charset=utf-8',
        JSON.stringify({error:status === 500 ? 'HTML5_RESOURCE_READ_FAILED' : (error.code ?? 'HTML5_REQUEST_REJECTED')}));
      else res.end();
    }
  });
  const viewerSockets=new Set();
  if (bvnProxy || glortonProxy || glortonBrowser || arenaViewerUpgrade) server.on('upgrade',(req,socket,head)=>{
    const pathname=req.url?.split('?')[0];
    if (pathname===GLORTON_BROWSER_SOCKET_PATH && glortonBrowser) return glortonBrowser.handleUpgrade(req,socket,head);
    if (pathname===GLORTON_SOCKET_PATH && glortonProxy) return glortonProxy.handleUpgrade(req,socket,head);
    if (arenaViewerUpgrade && [ARENA_SOCKET,BRAWL_SOCKET,'/lobby','/lockstep'].includes(pathname)){
      viewerSockets.add(socket);
      socket.once('close',()=>viewerSockets.delete(socket));
      return arenaViewerUpgrade(req,socket,head);
    }
    if (bvnProxy) return bvnProxy.handleUpgrade(req,socket,head);
    socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
  });
  if (lobbyHttpHandler) server.keepAliveTimeout = 20_000;
  await new Promise((resolve, reject) => {
    const onError = error => reject(error);
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError); actualPort = server.address().port; displayPort = publicPort ?? actualPort; resolve();
    });
  });
  let closing;
  return {
    url:`http://${displayHost}:${displayPort}`, entryUrl:`http://${displayHost}:${displayPort}${multi?'/':entryPath}`,
    sourceSha256, servedSha256, sourceBytes, games: manifestGames,
    close() {
      if (!closing) {
        closing = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        bvnProxy?.close();
        glortonProxy?.close();
        glortonBrowser?.close();
        for(const socket of viewerSockets)socket.destroy();
        server.closeAllConnections();
      }
      return closing;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const {values} = parseArgs({options:{root:{type:'string'},script:{type:'string'},port:{type:'string'},'require-script':{type:'string'},'entry-path':{type:'string'},help:{type:'boolean'}}});
    if (values.help) console.log('Usage: node scripts/html5-research-host.mjs --root <private first-game directory> --script <relative game.js> [--port 8802]\nInstrumented research harness only; original package is never modified.');
    else {
      const app = await startHtml5ResearchHost({root:values.root, script:values.script, port:values.port === undefined ? 0 : Number(values.port), requireScript:values['require-script'] ?? REQUIRE_SCRIPT, entryPath:values['entry-path'] ?? '/'});
      console.log(JSON.stringify({kind:'instrumented-research-harness',originalPackageBaseline:false,url:app.url,
        sourceSha256:app.sourceSha256,servedSha256:app.servedSha256,sourceBytes:app.sourceBytes}));
      for (const signal of ['SIGINT','SIGTERM']) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
    }
  } catch (error) {
    console.error(`${error.code ?? 'HTML5_HOST_ERROR'}: ${error.message}`); process.exitCode = 1;
  }
}
