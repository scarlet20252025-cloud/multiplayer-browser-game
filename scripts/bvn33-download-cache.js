const fetchAsset = window.fetch.bind(window);
const downloadGeneration = Number(new URLSearchParams(location.search).get('g'));
const gameAssetPath = new URL('./game/net.swf', location.href).pathname;
const ruffleAssetPath = new URL('./ruffle/', location.href).pathname;
const cacheStore = 'game';
const assetHeaderTimeout = 12_000;
const assetRetryDelays = [500, 1250];
let assetDatabase;

function openAssetDatabase() {
  assetDatabase ??= new Promise(resolve => {
    try {
      const request = indexedDB.open('bvn33-assets', 1);
      request.onupgradeneeded = () => request.result.createObjectStore(cacheStore);
      request.onerror = request.onblocked = () => resolve(null);
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
    } catch {
      resolve(null);
    }
  });
  return assetDatabase;
}

async function assetCache(mode, action) {
  try {
    const database = await openAssetDatabase();
    if (!database) return;
    return await new Promise(resolve => {
      const transaction = database.transaction(cacheStore, mode);
      const request = action(transaction.objectStore(cacheStore));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => resolve(undefined);
    });
  } catch {
    // IndexedDB can be unavailable, full, or disabled for this profile.
  }
}

async function within(pending, milliseconds) {
  let timer;
  try {
    return await Promise.race([pending, new Promise(resolve => { timer = setTimeout(resolve, milliseconds); })]);
  } finally {
    clearTimeout(timer);
  }
}

function withAssetUrl(response, url) {
  Object.defineProperty(response, 'url', {value: url});
  return response;
}

function reportDownload(name, loaded, total, complete, cached = false) {
  parent.postMessage({bvn:true, generation:downloadGeneration, type:'download', name, loaded, total, complete, cached}, location.origin);
}

async function saveGame(response, version) {
  try {
    const bytes = await response.clone().blob();
    const expected = Number(response.headers.get('X-Uncompressed-Length') || response.headers.get('Content-Length'));
    if (bytes.size > 0 && (!expected || expected === bytes.size))
      await assetCache('readwrite', store => store.put({version, bytes}, 'current'));
  } catch {
    // A partial download is never stored.
  }
}

function trackDownload(response, name, saved) {
  const total = Number(response.headers.get('X-Uncompressed-Length') || response.headers.get('Content-Length')) || 0;
  let loaded = 0;
  let last = performance.now();
  let reported = false;
  const report = complete => reportDownload(name, loaded, total, complete);
  const stream = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      loaded += chunk.byteLength;
      const now = performance.now();
      if (now - last > 100) {
        last = now;
        reported = true;
        report(false);
      }
      controller.enqueue(chunk);
    },
    async flush() {
      if (saved) await within(saved, 750);
      if (reported || name === '游戏资源') report(true);
    },
  }));
  return withAssetUrl(new Response(stream, {status:response.status, statusText:response.statusText, headers:response.headers}), response.url);
}

async function fetchAssetHeaders(input, init, signal) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new DOMException('等待资源响应超时', 'TimeoutError')), assetHeaderTimeout);
  try {
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    return await fetchAsset(input, {...init, signal:combined});
  } finally {
    // The header deadline must not interrupt a large body once its response starts.
    clearTimeout(timer);
  }
}

function waitToRetryAsset(delay, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, delay);
    signal?.addEventListener('abort', abort, {once:true});
  });
}

async function fetchAssetWithRetry(input, init, signal) {
  for (let attempt = 0;; attempt++) {
    signal?.throwIfAborted();
    const canRetry = attempt < assetRetryDelays.length;
    try {
      const response = await fetchAssetHeaders(input, init, signal);
      if (!canRetry || (response.status !== 408 && response.status !== 429 && response.status < 500)) return response;
      // Discard an interim error response without waiting for its body.
      void response.body?.cancel().catch(() => {});
    } catch (error) {
      signal?.throwIfAborted();
      if (!canRetry || (error?.name !== 'TimeoutError' && error?.name !== 'TypeError')) throw error;
    }
    await waitToRetryAsset(assetRetryDelays[attempt], signal);
  }
}

window.fetch = async function(input, init) {
  const url = new URL(input instanceof Request ? input.url : input, location.href);
  const method = init?.method ?? input?.method ?? 'GET';
  const knownGame = url.pathname === gameAssetPath;
  const gameVersion = knownGame && /^\?v=([a-f0-9]{64})$/.exec(url.search)?.[1];
  const wasm = url.pathname.endsWith('.wasm');
  if (url.origin !== location.origin || method.toUpperCase() !== 'GET' || (!knownGame && !wasm))
    return fetchAsset(input, init);

  const cacheMode = init?.cache ?? input?.cache;
  const signal = init?.signal ?? input?.signal;
  const range = new Headers(init?.headers ?? input?.headers).has('range');
  const useStoredGame = gameVersion && !range && cacheMode !== 'reload' && cacheMode !== 'no-store';
  if (useStoredGame) {
    const cached = await within(assetCache('readonly', store => store.get('current')), 750);
    signal?.throwIfAborted();
    if (cached?.version === gameVersion && cached.bytes instanceof Blob && cached.bytes.size) {
      const size = cached.bytes.size;
      reportDownload('游戏资源', size, size, true, true);
      const headers = {'Content-Type':'application/x-shockwave-flash', 'Content-Length':String(size)};
      return withAssetUrl(new Response(cached.bytes, {headers}), url.href);
    }
  }

  const versionedWasm = url.pathname.startsWith(ruffleAssetPath) &&
    /^[a-f0-9]{24}\/[\w.-]+\.wasm$/.test(url.pathname.slice(ruffleAssetPath.length));
  const immutable = !range && (gameVersion || versionedWasm);
  const settings = immutable && (!cacheMode || cacheMode === 'default') ? {...init, cache:'force-cache'} : init;
  const retryableAsset = !range && (knownGame || (wasm && url.pathname.startsWith(ruffleAssetPath)));
  const response = retryableAsset ? await fetchAssetWithRetry(input, settings, signal) : await fetchAsset(input, settings);
  if (response.status !== 200 || !response.body || range) return response;
  const saved = useStoredGame ? saveGame(response, gameVersion) : null;
  return trackDownload(response, wasm ? '运行组件' : '游戏资源', saved);
};
