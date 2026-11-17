#!/usr/bin/env node
/**
 * 原游戏本地基准宿主（原创工具）
 *
 * 目的：在一份**未修改**的原版 SWF 上，用仓库锁定的 Ruffle 0.7.1 做本地播放基准，
 * 记录加载错误、画面尺寸、帧率和实际可见状态。它不参与联机，也不改动原文件。
 *
 * 边界（与 docs/LOCAL_AGENT_HANDOFF.md 第 4 节一致）：
 * - 只监听 127.0.0.1，不对外网开放；
 * - 只映射命令行显式给出的游戏根目录，路径越界一律 403；
 * - 不执行包内脚本，不写回原目录，不把原包复制进仓库；
 * - 原包必须放在仓库忽略目录（local/、private-games/）或用户资料目录。
 *
 * 用法：
 *   node scripts/original-game-host.mjs --root <游戏根目录> --entry <根目录下的 SWF 相对路径>
 *   node scripts/original-game-host.mjs --root ../flash-archive/02-fireboy-watergirl/flash-original \
 *        --entry 1-forest-temple_addictinggames.swf --port 8790
 *
 * 打开输出提示的地址即可人工观察。自动基准见 scripts/verify-original-baseline.mjs。
 */
import http from 'node:http';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUFFLE_DIR = path.join(REPO_ROOT, 'node_modules/@ruffle-rs/ruffle');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.swf': 'application/x-shockwave-flash',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.xml': 'application/xml; charset=utf-8',
};

/** 把相对路径限制在 dir 内，越界返回 null。 */
function safeJoin(dir, relative) {
  const target = path.resolve(dir, relative);
  const rootWithSep = dir.endsWith(path.sep) ? dir : dir + path.sep;
  if (target !== dir && !target.startsWith(rootWithSep)) return null;
  return target;
}

function pageHtml(entry) {
  const safeEntry = JSON.stringify(entry);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>原包基准宿主 · ${entry.replace(/[<>&]/g, '')}</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#15181c; color:#e7ecf3; font:13px/1.5 ui-sans-serif,system-ui,"Segoe UI",sans-serif; }
  #frame { display:flex; justify-content:center; align-items:center; min-height:100vh; padding:16px; box-sizing:border-box; }
  #stage { background:#000; box-shadow:0 8px 32px rgba(0,0,0,.5); line-height:0; min-width:320px; min-height:240px; }
  #stage ruffle-player { display:block; }
  #hud { position:fixed; left:12px; bottom:12px; background:rgba(0,0,0,.72); border:1px solid #2c333c;
         border-radius:6px; padding:6px 10px; font:12px/1.4 ui-monospace,Consolas,monospace; max-width:60vw; }
  #hud b { color:#8fbe95; }
  #hud .err { color:#e08a82; }
</style>
</head>
<body>
<div id="frame"><div id="stage"></div></div>
<div id="hud">booting…</div>
<script src="/runtime/ruffle.js"></script>
<script>
// 基准观测点：Playwright 与人工都读同一个 window.__baseline。
window.__baseline = {
  status: 'booting',          // booting | loaded | error
  entry: ${safeEntry},
  error: null,
  metadata: null,             // Ruffle 报告的宽高/帧率（如可用）
  events: [],                 // loadedmetadata 等生命周期事件
  runtime: null,
};

(function () {
  const hud = document.getElementById('hud');
  const render = () => {
    const b = window.__baseline;
    const meta = b.metadata
      ? \` \${b.metadata.width}×\${b.metadata.height} @ \${b.metadata.frameRate ?? '?'}fps\`
      : '';
    hud.innerHTML = b.status === 'error'
      ? '<span class="err">载入失败：' + String(b.error).slice(0, 240) + '</span>'
      : '<b>' + b.status + '</b>' + meta + ' · ' + b.entry;
  };

  function boot() {
    try {
      if (!window.RufflePlayer) {
        window.__baseline.status = 'error';
        window.__baseline.error = 'RufflePlayer 未注册：/runtime/ruffle.js 未加载';
        render();
        return;
      }
      const ruffle = window.RufflePlayer.newest();
      window.__baseline.runtime = {
        version: (window.RufflePlayer.version || 'unknown'),
        name: ruffle && ruffle.name ? ruffle.name : 'unknown',
      };
      const player = ruffle.createPlayer();
      document.getElementById('stage').appendChild(player);
      player.config = {
        autoplay: 'on',
        unmuteOverlay: 'hidden',
        allowScriptAccess: true,
        letterbox: 'on',
        logLevel: (new URLSearchParams(location.search).get('loglevel') || 'warn'),
        scale: 'showAll',
      };
      player.addEventListener('loadedmetadata', () => {
        try {
          const m = player.metadata || {};
          window.__baseline.metadata = {
            width: m.width ?? null,
            height: m.height ?? null,
            frameRate: m.frameRate ?? null,
            backgroundColor: m.backgroundColor ?? null,
          };
          // 舞台跟随 SWF 原生尺寸；父容器为 0 会让 player 一起塌缩成黑屏。
          const stage = document.getElementById('stage');
          if (m.width && m.height) {
            stage.style.width = m.width + 'px';
            stage.style.height = m.height + 'px';
            player.style.width = '100%';
            player.style.height = '100%';
          }
        } catch (error) {
          window.__baseline.metadata = { error: String(error) };
        }
        window.__baseline.events.push('loadedmetadata');
        render();
      });
      window.__baseline.player = player;
      player.load({ url: '/game/' + encodeURIComponent(${safeEntry}) })
        .then(() => {
          window.__baseline.status = 'loaded';
          window.__baseline.events.push('load-resolved');
          render();
        })
        .catch((error) => {
          window.__baseline.status = 'error';
          window.__baseline.error = String(error && error.message ? error.message : error);
          window.__baseline.events.push('load-rejected');
          render();
        });
    } catch (error) {
      window.__baseline.status = 'error';
      window.__baseline.error = String(error && error.message ? error.message : error);
      render();
    }
  }

  // ruffle.js 是同步脚本，正常已就绪；保险起见等一次 DOMContentLoaded。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
  render();
})();
</script>
</body>
</html>`;
}

/**
 * 启动基准宿主。
 * @param {{root:string, entry:string, port?:number, host?:string}} options
 * @returns {Promise<{url:string, port:number, close:()=>Promise<void>}>}
 */
export async function startOriginalGameHost(options) {
  const host = options.host ?? '127.0.0.1';
  const gameRoot = path.resolve(options.root);
  const entry = String(options.entry || '').replace(/\\/g, '/');

  if (!entry || entry.startsWith('/') || entry.split('/').includes('..')) {
    throw new Error('entry 必须是游戏根目录下的相对路径，且不能包含 ..');
  }
  const entryPath = safeJoin(gameRoot, entry);
  if (!entryPath) throw new Error('entry 解析后越出游戏根目录');
  const entryInfo = await stat(entryPath).catch(() => null);
  if (!entryInfo || !entryInfo.isFile()) throw new Error(`找不到入口文件：${entryPath}`);

  const server = http.createServer(async (req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    try {
      if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'text/plain', 'Method Not Allowed');
      const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);

      if (pathname === '/' || pathname === '/index.html') {
        return send(200, MIME['.html'], pageHtml(entry));
      }
      if (pathname === '/__baseline__/entry') {
        return send(200, MIME['.json'], JSON.stringify({ entry, root: path.basename(gameRoot) }));
      }

      let dir;
      let relative;
      if (pathname.startsWith('/runtime/')) {
        dir = RUFFLE_DIR;
        relative = pathname.slice('/runtime/'.length);
      } else if (pathname.startsWith('/game/')) {
        dir = gameRoot;
        relative = pathname.slice('/game/'.length);
      } else {
        return send(404, 'text/plain', 'Not Found');
      }

      const target = safeJoin(dir, relative);
      if (!target) return send(403, 'text/plain', 'Forbidden');
      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) return send(404, 'text/plain', 'Not Found');
      return send(200, MIME[path.extname(target).toLowerCase()] || 'application/octet-stream',
        await readFile(target));
    } catch (error) {
      return send(400, 'text/plain', String(error && error.message ? error.message : error));
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, resolve);
  });
  const { port } = server.address();
  return {
    url: `http://${host}:${port}/`,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// CLI 直跑：人工观察用
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const get = (name, fallback) => {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
  };
  const root = get('--root');
  const entry = get('--entry');
  if (!root || !entry) {
    console.error('用法: node scripts/original-game-host.mjs --root <游戏根目录> --entry <SWF 相对路径> [--port 8790]');
    process.exit(2);
  }
  const host = await startOriginalGameHost({ root, entry, port: Number(get('--port', 0)) });
  console.log(`原包基准宿主已启动：${host.url}`);
  console.log('只监听 127.0.0.1；原文件只读，不做任何修改。Ctrl+C 结束。');
}
