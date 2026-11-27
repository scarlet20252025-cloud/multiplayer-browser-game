const publisher = 'https://james123wang5.github.io/fight-for-glorton-remake/game/';
const release = 'https://github.com/james123wang5/fight-for-glorton-remake/releases/tag/v0.95-online';
const source = 'https://raw.githubusercontent.com/james123wang5/fight-for-glorton-remake/61f5f27cbae71f36b423cf5ce784932148bd9777/';
const publisherSize = 37_359_606;
const chunks = ['000', '001', '002', '003', '004'];
const maxArchive = 64 * 1024 * 1024;
const cacheKeys = {publisher: 'publisher-37359606', imported: 'release-v0.95-online'};
const requests = new Map();
let requestId = 0;
let objectUrl = '';
let attempt = 0;

function cache(action, key, blob) {
  return new Promise((resolve) => {
    let request;
    try { request = indexedDB.open('glorton-provider', 1); }
    catch { resolve(null); return; }
    request.onblocked = request.onerror = () => resolve(null);
    request.onupgradeneeded = () => request.result.createObjectStore('archives');
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('archives', action === 'read' ? 'readonly' : 'readwrite');
      const archives = transaction.objectStore('archives');
      const job = action === 'read' ? archives.get(key) :
        action === 'delete' ? archives.delete(key) : archives.put(blob, key);
      transaction.onabort = () => { database.close(); resolve(null); };
      transaction.oncomplete = () => { database.close(); resolve(job.result); };
    };
  });
}

async function readChunk(number) {
  const url = new URL(`chunks/app-${number}.bin`, publisher);
  return fetchResource(url, 50_000, response => response.blob());
}

async function fetchResource(url, timeout, read) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, {
        mode: 'cors', credentials: 'omit', signal: AbortSignal.timeout(timeout),
      });
      if (response.ok) return await read(response);
      const error = Object.assign(Error(`HTTP ${response.status}`), {
        permanent: response.status < 500 && ![408, 429].includes(response.status),
      });
      throw error;
    } catch (error) {
      if (attempt === 1 || error.permanent) throw error;
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }
}

function show() {
  const panel = document.createElement('aside');
  panel.className = 'glorton-provider-panel';
  panel.setAttribute('role', 'status');
  panel.style.cssText = 'padding:12px;border-radius:10px;background:#efe9ff;color:#352165;font:14px/1.5 system-ui,sans-serif;box-sizing:border-box';
  const message = document.createElement('div');
  const progress = document.createElement('div');
  progress.style.cssText = 'margin-top:10px';
  progress.innerHTML = '<div class="glorton-provider-readout" style="display:flex;align-items:baseline;justify-content:flex-end;gap:2px;margin-bottom:6px;color:#4c2aad;font-variant-numeric:tabular-nums">'
    + '<b class="glorton-provider-percent" style="font-size:26px;font-weight:850;line-height:1">0</b>'
    + '<span style="font-size:13px;font-weight:750;color:#8b83ad">%</span></div>'
    + '<div class="glorton-provider-track" role="progressbar" aria-label="游戏资源载入进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" '
    + 'style="height:10px;border-radius:999px;background:#ddd2f6;box-shadow:inset 0 1px 2px #c3b2ea;overflow:hidden">'
    + '<span style="display:block;width:0;height:100%;border-radius:inherit;background:linear-gradient(90deg,#5b2ab8,#9a63f5 62%,#b98bff);transition:width .42s cubic-bezier(.22,.68,.32,1)"></span></div>';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:none;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;margin-top:8px';
  const download = document.createElement('a');
  download.href = release;
  download.target = '_blank';
  download.rel = 'noopener noreferrer';
  download.textContent = '打开原发行页';
  download.style.color = '#4c2aad';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,.apk';
  input.hidden = true;
  const importButton = document.createElement('button');
  importButton.type = 'button';
  importButton.textContent = '导入发行包';
  importButton.onclick = () => input.click();
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = '重新加载';
  retry.onclick = () => location.reload();
  actions.append(retry, importButton, download, input);
  panel.append(message, progress, actions);
  (document.querySelector('.glorton-provider-host') ?? document.body).append(panel);
  input.onchange = async () => {
    const file = input.files[0];
    input.value = '';
    if (!file) return;
    if (file.size < 22 || file.size > maxArchive) {
      report('error', '请选择完整的发行 ZIP 文件。');
      return;
    }
    const signature = new DataView(await file.slice(0, 4).arrayBuffer()).getUint32(0, true);
    if (signature !== 0x04034b50) {
      report('error', '这个文件不是可读取的发行 ZIP。');
      return;
    }
    attempt++;
    setArchive(file, cacheKeys.imported);
    report('mounting', '正在读取导入的游戏资源…');
  };
  return {panel, message, actions, progress};
}

const ui = show();

// 百分比读数：目标值变了用 rAF 追上去，保证数字一直在动。
const percentEl = ui.progress.querySelector('.glorton-provider-percent');
const fillEl = ui.progress.querySelector('.glorton-provider-track > span');
const trackEl = ui.progress.querySelector('.glorton-provider-track');
let shownPercent = 0, targetPercent = 0, rafId = 0, tweenFrom = 0, tweenAt = 0;
const easeOut = t => 1 - (1 - t) ** 3;
function paintPercent(value) {
  shownPercent = value;
  const rounded = Math.round(value);
  fillEl.style.width = value + '%';
  percentEl.textContent = String(rounded);
  trackEl.setAttribute('aria-valuenow', String(rounded));
}
function progressTo(value) {
  targetPercent = Math.min(100, Math.max(targetPercent, value));
  if (rafId) return;
  tweenFrom = shownPercent; tweenAt = performance.now();
  const step = now => {
    const t = Math.min(1, (now - tweenAt) / 420);
    paintPercent(tweenFrom + (targetPercent - tweenFrom) * easeOut(t));
    rafId = t < 1 ? requestAnimationFrame(step) : 0;
  };
  rafId = requestAnimationFrame(step);
}

function report(phase, message) {
  ui.panel.hidden = phase === 'ready';
  ui.message.textContent = message || {
    waiting: '正在从发行方加载游戏资源…',
    mounting: '正在准备本地游戏…',
    source: '正在校验联机引擎版本…',
    invalid: '这个发行包无法使用，请重试或导入完整的发行包。',
    error: '游戏引擎加载失败，请重新加载。',
  }[phase] || '';
  ui.actions.style.display = phase === 'error' ? 'flex' : 'none';
  if (phase === 'ready') progressTo(100);
  else if (phase === 'mounting' || phase === 'source') progressTo(92);
  else if (phase === 'invalid' || phase === 'error') ui.progress.style.display = 'none';
  if (phase === 'ready' && activeArchive?.key === cacheKeys.imported)
    void cache('write', activeArchive.key, activeArchive.blob);
  if (phase === 'invalid' && activeArchive) {
    void cache('delete', activeArchive.key);
    ui.actions.style.display = 'flex';
  }
  window.dispatchEvent(new CustomEvent('glorton:provider-status',{detail:{phase,message:ui.message.textContent}}));
}

let activeArchive;

function setArchive(blob, key) {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = URL.createObjectURL(blob);
  activeArchive = {blob, key};
}

function requestSource(path) {
  if (!/^(src|online)\/[a-zA-Z0-9_]+\.py$/.test(path)) return 0;
  const id = ++requestId;
  requests.set(id, '');
  fetchResource(new URL(path, source), 9_000, response => response.text())
    .then(text => requests.set(id, JSON.stringify({text})))
    .catch((error) => requests.set(id, JSON.stringify({error: error.message})));
  return id;
}

function setRolePortraits(json) {
  const supplied = JSON.parse(json);
  const portraits = Object.create(null);
  for (const [fighter, colors] of Object.entries(supplied).slice(0, 6)) {
    if (!/^[A-Za-z]+Player$/.test(fighter) || !Array.isArray(colors)) continue;
    const validated = colors.slice(0, 4).map(value =>
      typeof value === 'string' && value.length <= 22_000 && value.startsWith('data:image/png;base64,iVBORw0KGgo')
        ? value : null);
    if (validated.some(Boolean)) portraits[fighter] = Object.freeze(validated);
  }
  window.GlortonRolePortraits = Object.freeze(portraits);
  window.dispatchEvent(new CustomEvent('glorton:role-portraits', {detail:window.GlortonRolePortraits}));
}

window.GlortonProvider = Object.freeze({
  archiveUrl: () => objectUrl,
  report,
  requestSource,
  setRolePortraits,
  pollSource(id) {
    const result = requests.get(id) ?? '';
    if (result) requests.delete(id);
    return result;
  },
});

async function loadPublisherArchive() {
  const current = ++attempt;
  report('waiting', '正在从发行方加载游戏资源…');
  progressTo(8);
  try {
    const imported = await cache('read', cacheKeys.imported);
    if (current !== attempt) return;
    if (imported instanceof Blob) {
      setArchive(imported, cacheKeys.imported);
      report('mounting', '正在读取已导入的游戏资源…');
      return;
    }
    let archive = await cache('read', cacheKeys.publisher);
    if (current !== attempt) return;
    if (archive?.size !== publisherSize) {
      let completed = 0;
      const parts = await Promise.all(chunks.map(async (part) => {
        const blob = await readChunk(part);
        completed++;
        if (current === attempt) {
          report('waiting', `正在加载游戏资源 · ${completed}/${chunks.length}`);
          progressTo(10 + 82 * (completed / chunks.length));
        }
        return blob;
      }));
      if (current !== attempt) return;
      archive = new Blob(parts, {type: 'application/zip'});
      if (archive.size !== publisherSize) throw Error('Unexpected publisher archive version');
      void cache('write', cacheKeys.publisher, archive);
    }
    setArchive(archive, cacheKeys.publisher);
    report('mounting', '正在准备本地游戏…');
  } catch {
    if (current === attempt) report('error', '暂时无法读取发行方资源，可以重试或导入发行包。');
  }
}

void loadPublisherArchive();
