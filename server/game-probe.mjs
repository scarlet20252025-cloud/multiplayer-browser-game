/**
 * Read-only onboarding probes. They classify a package before it is allowed
 * into the lobby; they never execute game code and never modify the package.
 */
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {inflateSync} from 'node:zlib';

const MAX_INFLATED_BYTES = 256 * 1024 * 1024;
const MARKERS = Object.freeze([
  ['loaderLoadBytes', 'loadBytes'],
  ['platform4399', '4399'],
  ['platform4399Base', 'A4399dv'],
  ['checkAndPlay', 'checkAndPlay'],
  ['doABC', 'DoABC'],
]);

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function readRect(body) {
  if (body.length < 2) throw Error('SWF_DATA_INVALID');
  const nbits = body[0] >> 3;
  if (nbits < 1 || nbits > 31) throw Error('SWF_DATA_INVALID');
  const totalBits = 5 + nbits * 4;
  const bytes = Math.ceil(totalBits / 8);
  if (body.length < bytes + 4) throw Error('SWF_DATA_INVALID');
  const readBits = (offset, count) => {
    let value = 0;
    for (let i = 0; i < count; i++) {
      const bit = offset + i;
      value = (value << 1) | ((body[bit >> 3] >> (7 - (bit & 7))) & 1);
    }
    return value;
  };
  const xMin = readBits(5, nbits);
  const xMax = readBits(5 + nbits, nbits);
  const yMin = readBits(5 + nbits * 2, nbits);
  const yMax = readBits(5 + nbits * 3, nbits);
  const toPx = twips => Math.round((twips / 20) * 100) / 100;
  const frameRateRaw = body.readUInt16LE(bytes);
  const frameCount = body.readUInt16LE(bytes + 2);
  return {
    width: toPx(xMax - xMin),
    height: toPx(yMax - yMin),
    frameRate: Math.round((frameRateRaw / 256) * 100) / 100,
    frameCount,
  };
}

/**
 * Probe a SWF header and scan constant-pool strings for known loader signals.
 * Signals are evidence, not proof that any code path executes.
 */
export async function probeSwfPackage({file} = {}) {
  if (typeof file !== 'string' || !file.trim()) throw Error('SWF_PATH_REQUIRED');
  const buffer = await readFile(file);
  const report = {
    kind: 'swf',
    file: path.basename(file),
    bytes: buffer.length,
    sha256: sha256(buffer),
    signature: null,
    version: null,
    compressed: null,
    declaredBytes: null,
    truncated: null,
    width: null,
    height: null,
    frameRate: null,
    frameCount: null,
    signals: {},
    verdict: 'REJECTED',
    runtime: null,
    blockers: [],
    issues: [],
  };
  if (buffer.length < 8) {
    report.issues.push('SWF_TOO_SHORT');
    return Object.freeze(report);
  }
  const signature = buffer.toString('latin1', 0, 3);
  report.signature = signature;
  report.version = buffer[3];
  report.declaredBytes = buffer.readUInt32LE(4);
  if (!['FWS', 'CWS', 'ZWS'].includes(signature)) {
    report.issues.push('SWF_SIGNATURE_INVALID');
    return Object.freeze(report);
  }
  if (signature === 'ZWS') {
    report.issues.push('SWF_LZMA_UNSUPPORTED');
    report.blockers.push('SWF_LZMA_UNSUPPORTED');
    return Object.freeze(report);
  }
  let body;
  try {
    body = signature === 'FWS'
      ? buffer.subarray(8)
      : inflateSync(buffer.subarray(8), {maxOutputLength: MAX_INFLATED_BYTES});
  } catch {
    report.issues.push('SWF_DATA_INVALID');
    return Object.freeze(report);
  }
  report.compressed = signature === 'CWS';
  // The SWF length field is always the uncompressed total, header included.
  report.uncompressedBytes = 8 + body.length;
  report.truncated = report.declaredBytes !== report.uncompressedBytes;
  try {
    Object.assign(report, readRect(body));
  } catch {
    report.issues.push('SWF_DATA_INVALID');
    return Object.freeze(report);
  }
  const text = body.toString('latin1');
  for (const [key, marker] of MARKERS) report.signals[key] = text.includes(marker);
  const chained = report.signals.loaderLoadBytes &&
    (report.signals.platform4399 || report.signals.checkAndPlay);
  report.runtime = chained ? 'flash-native' : 'flash-ruffle';
  report.verdict = 'RESEARCH_ONLY';
  report.blockers.push('NO_BROWSER_RUNTIME');
  if (chained) {
    report.blockers.push('CHAINED_LOADBYTES');
    if (report.signals.platform4399) report.blockers.push('PLATFORM_SHELL');
  } else {
    report.blockers.push('RUFFLE_COMPATIBILITY_UNVERIFIED');
  }
  if (report.truncated) report.issues.push('SWF_DECLARED_LENGTH_MISMATCH');
  return Object.freeze(report);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * Probe an HTML5 pack using the same files the catalog needs. Returns
 * `onlineEligible` only when every blocking issue is absent.
 */
export async function probeHtml5Package({dir} = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw Error('HTML5_DIR_REQUIRED');
  const report = {
    kind: 'html5',
    dir: path.basename(path.resolve(dir)),
    runtime: 'html5-phaser',
    entry: null,
    script: null,
    requireScript: null,
    templeId: null,
    levels: 0,
    levelsPath: null,
    onlineEligible: false,
    issues: [],
  };
  let index;
  try { index = await readFile(path.join(dir, 'index.html'), 'utf8'); }
  catch { report.issues.push('HTML5_ENTRY_MISSING'); return Object.freeze(report); }
  const main = /data-main="([^"]+)"/.exec(index)?.[1];
  const requireScript = /<script[^>]+src="([^"]*require\.js)"/.exec(index)?.[1];
  if (!main) report.issues.push('HTML5_ENTRY_INVALID');
  report.entry = 'index.html';
  report.script = main ?? null;
  report.requireScript = requireScript ?? null;
  let meta = {};
  try { meta = await readJson(path.join(dir, 'game.json')); }
  catch { report.issues.push('HTML5_GAME_JSON_MISSING'); }
  report.title = typeof meta.title === 'string' ? meta.title : null;
  let temple = null;
  const candidates = [];
  for (const name of ['forest', 'light', 'ice', 'crystal'])
    candidates.push({absolute: path.join(dir, 'data', name, 'temple.json'), relative: `data/${name}/temple.json`});
  for (const candidate of candidates) {
    try {
      const parsed = await readJson(candidate.absolute);
      if (Array.isArray(parsed?.levels)) { temple = parsed; report.levelsPath = candidate.relative; break; }
    } catch { /* keep looking */ }
  }
  if (!temple) {
    report.issues.push('HTML5_LEVELS_MISSING');
  } else {
    report.templeId = typeof temple.id === 'string' ? temple.id : null;
    if (!report.templeId) report.issues.push('HTML5_TEMPLE_ID_MISSING');
    const ids = new Set();
    for (const level of temple.levels) {
      if (Number.isInteger(level?.id) && level.id >= 0 && typeof level.filename === 'string')
        ids.add(level.id);
    }
    report.levels = ids.size;
    if (!ids.size) report.issues.push('HTML5_LEVELS_EMPTY');
  }
  report.onlineEligible = report.issues.length === 0 && !!report.script;
  return Object.freeze(report);
}

/** Convenience dispatcher for the onboarding CLI. */
export async function probeGame({kind, dir, file} = {}) {
  if (kind === 'swf') return probeSwfPackage({file});
  if (kind === 'html5') return probeHtml5Package({dir});
  throw Error('GAME_PROBE_KIND_INVALID');
}
