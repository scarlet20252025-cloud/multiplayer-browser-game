#!/usr/bin/env node
/**
 * 原游戏未修改原包的本播放地基准（原创工具）
 *
 * 对一份未修改的 SWF，用仓库锁定的 Ruffle 0.7.1 + Playwright Chromium 记录：
 * 实际加载结果、Ruffle 报告的画面尺寸/帧率、控制台与页面错误、请求失败、截图。
 *
 * 它只回答「这个包在记录环境里能不能被加载、渲染成什么」，不判断玩法规格，
 * 也不参与联机。原包保持只读，不进仓库。
 *
 * 用法：
 *   node scripts/verify-original-baseline.mjs \
 *     --root <游戏根目录> --entry <SWF 相对路径> \
 *     --out local/reports/baseline-<id>.json --shots local/screenshots/<id>
 *
 * 可选：
 *   --wait <ms>        首帧后额外等待（默认 4000）
 *   --click "x,y"      加载后点击画布坐标，可重复，用于越过菜单
 *   --key "Space:800"  按键，格式 key:按住毫秒，可重复
 *   --timeout <ms>     等待加载状态变化的上限（默认 30000）
 */
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startOriginalGameHost } from './original-game-host.mjs';

const args = process.argv.slice(2);
const list = (name) => {
  const out = [];
  for (let i = 0; i < args.length; i++) if (args[i] === name && args[i + 1]) out.push(args[++i]);
  return out;
};
const get = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const root = get('--root');
const entry = get('--entry');
const outPath = get('--out');
const shotDir = get('--shots');
const waitMs = Number(get('--wait', 4000));
const loadTimeout = Number(get('--timeout', 30000));
const clicks = list('--click');
const keys = list('--key');

if (!root || !entry || !outPath) {
  console.error('用法: node scripts/verify-original-baseline.mjs --root <dir> --entry <swf> --out <json> [--shots <dir>]');
  process.exit(2);
}

const recordedAt = new Date().toISOString();
const host = await startOriginalGameHost({ root, entry });
const consoleMessages = [];
const pageErrors = [];
const failedRequests = [];
const badResponses = [];
const shots = [];
let browser;

const result = {
  schemaVersion: 1,
  recordedAt,
  entry,
  gameRootBasename: path.basename(path.resolve(root)),
  host: { url: host.url, bind: '127.0.0.1' },
  runtime: {},
  load: { status: 'not-run', error: null, metadata: null },
  interactions: [],
  console: consoleMessages,
  pageErrors,
  failedRequests,
  badResponses,
  screenshots: shots,
  checks: [],
};

const addCheck = (name, status, detail, evidence = null) => {
  result.checks.push({ name, status, detail, evidence });
};

try {
  browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();

  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) {
      consoleMessages.push({ type: msg.type(), text: msg.text().slice(0, 500) });
    }
  });
  page.on('pageerror', (err) => pageErrors.push(String(err && err.message ? err.message : err).slice(0, 500)));
  page.on('requestfailed', (req) => {
    failedRequests.push({ url: req.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), reason: req.failure()?.errorText ?? 'unknown' });
  });
  // 游戏自身的加载器常用 404 表示缺资源；HTTP 4xx 不算 requestfailed，必须单独记录。
  page.on('response', (res) => {
    if (res.status() >= 400) {
      badResponses.push({ url: res.url().replace(/^http:\/\/127\.0\.0\.1:\d+/, ''), status: res.status() });
    }
  });

  await page.goto(host.url, { waitUntil: 'domcontentloaded' });

  // 等 Ruffle 把状态从 booting 改成 loaded / error
  let settled = false;
  try {
    await page.waitForFunction(
      () => window.__baseline && window.__baseline.status !== 'booting',
      { timeout: loadTimeout },
    );
    settled = true;
  } catch {
    settled = false;
  }

  const snapshot = await page.evaluate(() => {
    const b = window.__baseline || {};
    return {
      status: b.status ?? 'unknown',
      error: b.error ?? null,
      metadata: b.metadata ?? null,
      events: b.events ?? [],
      runtime: b.runtime ?? null,
    };
  });

  result.load.status = settled ? snapshot.status : 'timeout';
  result.load.error = snapshot.error;
  result.load.metadata = snapshot.metadata;
  result.load.events = snapshot.events;
  result.runtime = snapshot.runtime;

  // 首帧后再等一段时间，覆盖 loading 动画和初始化
  await page.waitForTimeout(waitMs);

  if (shotDir) {
    await mkdir(shotDir, { recursive: true });
    const shot = path.join(shotDir, '00-loaded.png');
    await page.screenshot({ path: shot });
    shots.push({ name: '00-loaded', path: shot, at: new Date().toISOString() });
  }

  // 依次执行点击与按键，每步截图
  let step = 1;
  for (const click of clicks) {
    const [x, y] = click.split(',').map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    await page.mouse.click(x, y);
    await page.waitForTimeout(1200);
    result.interactions.push({ type: 'click', x, y });
    if (shotDir) {
      const shot = path.join(shotDir, `0${step}-click-${x}x${y}.png`);
      await page.screenshot({ path: shot });
      shots.push({ name: `0${step}-click`, path: shot, at: new Date().toISOString() });
    }
    step++;
  }
  for (const key of keys) {
    const [name, holdRaw] = key.split(':');
    const hold = Number(holdRaw ?? 300);
    await page.keyboard.down(name);
    await page.waitForTimeout(hold);
    await page.keyboard.up(name);
    await page.waitForTimeout(600);
    result.interactions.push({ type: 'key', key: name, holdMs: hold });
    if (shotDir) {
      const shot = path.join(shotDir, `0${step}-key-${name}.png`);
      await page.screenshot({ path: shot });
      shots.push({ name: `0${step}-key-${name}`, path: shot, at: new Date().toISOString() });
    }
    step++;
  }

  const finalState = await page.evaluate(() => {
    const b = window.__baseline || {};
    const stage = document.getElementById('stage');
    const player = b.player;
    const rect = player && player.getBoundingClientRect ? player.getBoundingClientRect() : null;
    // Ruffle 把 canvas 放在 shadow DOM 里，普通 querySelector 查不到。
    const deepQuery = (root, selector) => {
      if (!root) return null;
      const direct = root.querySelector ? root.querySelector(selector) : null;
      if (direct) return direct;
      const all = root.querySelectorAll ? root.querySelectorAll('*') : [];
      for (const el of all) {
        if (el.shadowRoot) {
          const hit = deepQuery(el.shadowRoot, selector);
          if (hit) return hit;
        }
      }
      return null;
    };
    const canvas = deepQuery(player || document, 'canvas');
    return {
      status: b.status,
      error: b.error,
      events: b.events ?? [],
      metadata: b.metadata ?? null,
      renderProbe: {
        stageSize: stage ? { width: stage.clientWidth, height: stage.clientHeight } : null,
        playerSize: rect ? { width: Math.round(rect.width), height: Math.round(rect.height) } : null,
        canvasCount: canvas ? 1 : 0,
        canvasSize: canvas ? { width: canvas.width, height: canvas.height } : null,
        usingWebGL: Boolean(canvas && canvas.getContext && (canvas.getContext('webgl2') || canvas.getContext('webgl'))),
      },
    };
  });
  result.load.finalStatus = finalState.status;
  result.load.finalEvents = finalState.events;
  if (finalState.metadata) result.load.metadata = finalState.metadata;

  // Playwright 的 locator 能穿透 shadow DOM，page.evaluate 里手写递归容易漏。
  const canvasCount = await page.locator('canvas').count();
  const firstCanvas = canvasCount > 0 ? await page.locator('canvas').first().evaluate((el) => ({
    width: el.width, height: el.height,
    hasWebGL: Boolean(el.getContext && (el.getContext('webgl2') || el.getContext('webgl'))),
  })).catch(() => null) : null;
  result.renderProbe = {
    ...(finalState.renderProbe || {}),
    canvasCount,
    canvasSize: firstCanvas ? { width: firstCanvas.width, height: firstCanvas.height } : null,
    usingWebGL: Boolean(firstCanvas && firstCanvas.hasWebGL),
  };

  addCheck('swf-loaded', result.load.status === 'loaded' ? 'passed'
    : result.load.status === 'error' ? 'failed' : 'blocked',
    result.load.status === 'loaded'
      ? `Ruffle 报告加载完成，画面 ${result.load.metadata?.width ?? '?'}×${result.load.metadata?.height ?? '?'} @ ${result.load.metadata?.frameRate ?? '?'}fps`
      : `状态 ${result.load.status}，错误：${snapshot.error ?? '无'}`);
  addCheck('renderer-active', canvasCount > 0 ? 'passed' : 'failed',
    `canvas ${canvasCount} 个${firstCanvas ? `（${firstCanvas.width}×${firstCanvas.height}${firstCanvas.hasWebGL ? ', WebGL' : ''}）` : ''}，player ${result.renderProbe.playerSize?.width ?? 0}×${result.renderProbe.playerSize?.height ?? 0}`);
  addCheck('no-page-error', pageErrors.length === 0 ? 'passed' : 'failed',
    pageErrors.length === 0 ? '页面无未捕获异常' : `${pageErrors.length} 条页面异常`);
  addCheck('no-failed-request', failedRequests.length === 0 ? 'passed' : 'failed',
    failedRequests.length === 0 ? '无失败的资源请求' : `${failedRequests.length} 个请求失败`);
  addCheck('no-missing-asset', badResponses.length === 0 ? 'passed' : 'failed',
    badResponses.length === 0
      ? '无 4xx/5xx 资源响应'
      : `${badResponses.length} 个资源返回错误：${badResponses.slice(0, 4).map((r) => `${r.url} → ${r.status}`).join('; ')}`);
} catch (error) {
  const message = String(error && error.message ? error.message : error);
  result.load.status = 'blocked';
  result.load.error = message;
  addCheck('harness', 'blocked', `基准脚本自身失败：${message}`);
} finally {
  if (browser) await browser.close().catch(() => {});
  await host.close().catch(() => {});
}

result.recordedAt = recordedAt;
await mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
await writeFile(outPath, JSON.stringify(result, null, 2) + '\n', 'utf8');

const passed = result.checks.filter((c) => c.status === 'passed').length;
console.log(`条目 ${entry}`);
console.log(`  加载: ${result.load.status}${result.load.error ? ' — ' + result.load.error : ''}`);
console.log(`  metadata: ${JSON.stringify(result.load.metadata)}`);
console.log(`  检查: ${passed}/${result.checks.length} passed`);
console.log(`  报告: ${outPath}`);
if (result.pageErrors.length) console.log(`  页面异常: ${result.pageErrors[0]}`);
process.exitCode = result.load.status === 'loaded' ? 0 : 1;
