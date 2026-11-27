export const ORIGINAL_SWF_BYTES = 8_740_427;
export const ORIGINAL_SWF_SHA256 = '21ff6d4a2e442e97300ddb3f7abc73a4863a16f83b0b0769720b2fff0ab6d482';
export const ORIGINAL_SWF_PATH = `/__lockstep__/originals/bomb-it-7/${ORIGINAL_SWF_SHA256}.swf`;

const CACHE_NAME = 'bomb-it-7-original-files';
const CACHE_STORE = 'verified-swf';
const CACHE_TIMEOUT_MS = 2_000;

// FIPS 180-4 SHA-256 constants. Keep the digest usable on HTTP origins where
// browsers withhold SubtleCrypto. This checks an artifact's identity locally.
const ROUND_CONSTANTS = Uint32Array.of(
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
);

function rotateRight(value, count) {
  return (value >>> count) | (value << (32 - count));
}

export function sha256Hex(bytes) {
  const state = Uint32Array.of(
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  );
  const words = new Uint32Array(64);

  function compress(view, offset) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index++) {
      const first = words[index - 15];
      const second = words[index - 2];
      const sigma0 = rotateRight(first, 7) ^ rotateRight(first, 18) ^ (first >>> 3);
      const sigma1 = rotateRight(second, 17) ^ rotateRight(second, 19) ^ (second >>> 10);
      words[index] = words[index - 16] + sigma0 + words[index - 7] + sigma1;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index++) {
      const sigma1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = h + sigma1 + choice + ROUND_CONSTANTS[index] + words[index];
      const sigma0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = sigma0 + majority;

      h = g;
      g = f;
      f = e;
      e = (d + first) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (first + second) >>> 0;
    }
    state[0] += a;
    state[1] += b;
    state[2] += c;
    state[3] += d;
    state[4] += e;
    state[5] += f;
    state[6] += g;
    state[7] += h;
  }

  const input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const remaining = input.byteLength % 64;
  const fullBlocksLength = input.byteLength - remaining;
  for (let offset = 0; offset < fullBlocksLength; offset += 64) {
    compress(input, offset);
  }

  const tail = new Uint8Array(remaining < 56 ? 64 : 128);
  tail.set(bytes.subarray(fullBlocksLength));
  tail[remaining] = 0x80;
  const padded = new DataView(tail.buffer);
  padded.setBigUint64(tail.byteLength - 8, BigInt(input.byteLength) * 8n);
  for (let offset = 0; offset < padded.byteLength; offset += 64) {
    compress(padded, offset);
  }
  return Array.from(state, word => word.toString(16).padStart(8, '0')).join('');
}

/** Read the original selected on this device. This function makes no network requests. */
export async function readOriginalSwf(file) {
  if (!file || typeof file.arrayBuffer !== 'function') {
    throw new TypeError('请选择本机的《Q版泡泡堂7》原版 SWF。');
  }
  if (file.size !== ORIGINAL_SWF_BYTES) {
    throw new Error('文件大小不符。请选择 8,740,427 字节的《Q版泡泡堂7》原版 SWF。');
  }
  return verifyOriginalSwf(new Uint8Array(await file.arrayBuffer()));
}

function verifyOriginalSwf(bytes) {
  if (bytes.byteLength !== ORIGINAL_SWF_BYTES || sha256Hex(bytes) !== ORIGINAL_SWF_SHA256) {
    throw new Error('SWF 指纹与已验证的《Q版泡泡堂7》发行版不一致。');
  }
  return bytes;
}

function accessOriginalCache(signal, bytesToStore) {
  return new Promise(resolve => {
    let database;
    let transaction;
    let settled = false;

    function finish(value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      database?.close();
      resolve(value);
    }

    function cancel() {
      try { transaction?.abort(); }
      catch { /* The transaction has already settled. */ }
      finish();
    }

    const timer = setTimeout(cancel, CACHE_TIMEOUT_MS);
    if (signal?.aborted) return finish();
    signal?.addEventListener('abort', cancel, {once: true});

    let opening;
    try { opening = globalThis.indexedDB?.open(CACHE_NAME, 1); }
    catch { return finish(); }
    if (!opening) return finish();

    opening.onerror = opening.onblocked = () => finish();
    opening.onupgradeneeded = () => {
      if (settled) opening.transaction.abort();
      else opening.result.createObjectStore(CACHE_STORE);
    };
    opening.onsuccess = () => {
      database = opening.result;
      if (settled) {
        database.close();
        return;
      }

      let cachedBytes;
      try {
        transaction = database.transaction(CACHE_STORE, 'readwrite');
        const store = transaction.objectStore(CACHE_STORE);
        transaction.oncomplete = () => finish(cachedBytes);
        transaction.onabort = transaction.onerror = () => finish();

        if (bytesToStore) {
          store.put(bytesToStore, ORIGINAL_SWF_SHA256);
          return;
        }

        const reading = store.get(ORIGINAL_SWF_SHA256);
        reading.onsuccess = () => {
          const bytes = reading.result;
          if (bytes === undefined) return;
          if (bytes instanceof Uint8Array) {
            try {
              cachedBytes = verifyOriginalSwf(bytes);
              return;
            } catch { /* Invalidate corrupt bytes in the same transaction. */ }
          }
          store.delete(ORIGINAL_SWF_SHA256);
        };
      } catch {
        cancel();
      }
    };
  });
}

export async function downloadOriginalSwf({signal, retry = false, onProgress = () => {}} = {}) {
  signal?.throwIfAborted();
  if (!retry) {
    onProgress({phase: 'cache', title: '正在检查本地游戏缓存'});
    const cachedBytes = await accessOriginalCache(signal);
    signal?.throwIfAborted();
    if (cachedBytes) {
      onProgress({phase: 'cache', title: '已使用本地游戏缓存'});
      return cachedBytes;
    }
  }

  const timeout = AbortSignal.timeout(40_000);
  onProgress({phase: 'download', title: '正在下载原版资源', loaded: 0, total: ORIGINAL_SWF_BYTES});
  const response = await fetch(new URL(ORIGINAL_SWF_PATH, import.meta.url), {
    cache: retry ? 'reload' : 'default',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(response.status === 503
      ? '服务器暂未准备好原版文件。'
      : `原版资源下载失败（HTTP ${response.status}）。`);
  }
  const bytes = new Uint8Array(ORIGINAL_SWF_BYTES);
  const reader = response.body.getReader();
  let loaded = 0;
  let displayed = 0;
  try {
    while (true) {
      const {value, done} = await reader.read();
      if (done) break;
      if (loaded + value.byteLength > bytes.length) throw new Error('原版文件大小超出预期。');
      bytes.set(value, loaded);
      loaded += value.byteLength;
      if (loaded - displayed >= 128 * 1024 || loaded === bytes.length) {
        displayed = loaded;
        onProgress({phase: 'download', title: '正在下载原版资源', loaded, total: bytes.length});
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (loaded !== bytes.length) throw new Error('原版文件没有下载完整。');
  onProgress({phase: 'verify', title: '正在校验游戏文件'});
  const verifiedBytes = verifyOriginalSwf(bytes);
  await accessOriginalCache(signal, verifiedBytes);
  signal?.throwIfAborted();
  return verifiedBytes;
}
