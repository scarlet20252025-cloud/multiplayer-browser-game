/**
 * Universal game adapter contract.
 *
 * The platform (lobby, rooms, voting, saves) must not know game internals.
 * A game declares a manifest; the runtime registry decides which execution
 * tiers are allowed. Flash packages default to research-only because the
 * browser lobby has no verified state adapter for them.
 */
import path from 'node:path';
import {readdir, readFile} from 'node:fs/promises';
import {LOCKSTEP_RUNTIME} from '../public/lockstep/protocol.mjs';
import {ARENA_RUNTIME} from '../public/tank-arena/rules.mjs';
import {BRAWL_RUNTIME} from '../public/platform-brawl/rules.mjs';

export const MANIFEST_SCHEMA_VERSION = 1;
export const DEFAULT_ADAPTER = 'fireboy-html5';
export const FLASH_MIRROR_ADAPTER = 'flash-mirror';
export const TANK_COLYSEUS_ADAPTER = 'tank-trouble-colyseus';
export const LOCKSTEP_ADAPTER = 'frame-lockstep';
export const SUPPORTED_ADAPTERS = Object.freeze([
  DEFAULT_ADAPTER, FLASH_MIRROR_ADAPTER, TANK_COLYSEUS_ADAPTER, LOCKSTEP_ADAPTER, ARENA_RUNTIME, BRAWL_RUNTIME,
]);

const arenaPolicy = Object.freeze({
  label: 'HTML5 多人对战', online: true,
  requiredCapabilities: Object.freeze(['authority','levelVote','returnVote']),
});
const arenaRuntimes = new Set([ARENA_RUNTIME, BRAWL_RUNTIME]);
export const RUNTIME_POLICY = Object.freeze({
  'html5-phaser': Object.freeze({
    label: 'HTML5',
    online: true,
    requiredCapabilities: Object.freeze([
      'authority', 'spectator', 'levelVote', 'restartVote', 'returnVote',
    ]),
    optionalCapabilities: Object.freeze(['save']),
  }),
  // A self-hosted external authoritative server (e.g. a Colyseus room) runs
  // the simulation for every seat. The lobby only allocates the room code and
  // routes each seat to its own client URL, so no snapshot projection exists.
  'html5-external': Object.freeze({
    label: 'HTML5 / 外部权威服务',
    online: true,
    requiredCapabilities: Object.freeze(['authority', 'levelVote', 'restartVote', 'returnVote']),
    optionalCapabilities: Object.freeze(['save']),
  }),
  [ARENA_RUNTIME]: arenaPolicy,
  [BRAWL_RUNTIME]: arenaPolicy,
  // Ruffle can run the original Flash package in the browser; the online tier
  // is input mirroring only (both clients simulate locally, no state authority).
  'flash-ruffle': Object.freeze({
    label: 'Flash / Ruffle（实验）',
    online: true,
    requiredCapabilities: Object.freeze(['mirrorInput']),
    optionalCapabilities: Object.freeze(['save']),
    experimental: true,
  }),
  'flash-native': Object.freeze({
    label: 'Flash / native research',
    online: false,
    blockReason: 'NO_BROWSER_RUNTIME',
  }),
  [LOCKSTEP_RUNTIME]: Object.freeze({
    label: '浏览器帧同步',
    online: true,
    requiredCapabilities: Object.freeze(['lockstep', 'levelVote']),
  }),
});

/** Seat capacity is a platform-level fact, not a per-adapter one. A manifest may
 * declare seat capacity; omitted values use the two-seat default so the
 * existing two-player flow keeps working without a manifest change. */
export const DEFAULT_SEATS = 2;
export const MIN_SEATS = 1;
export const MAX_SEATS = 6;

const ID_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const ADAPTER_PATTERN = /^[a-z][a-z0-9-]{1,31}$/;
const CODE_PATTERN = /^[A-Z][A-Z0-9_]{2,63}$/;
const EVIDENCE_PATTERN = /^(?:[A-Za-z0-9._-]+\/)*(?:[A-Za-z0-9._-]+)(?:#[A-Za-z0-9._-]+)?$/;

const fail = (file, reason) => {
  throw Error('GAME_MANIFEST_INVALID: ' + file + ': ' + reason);
};

function text(value, file, name, {min = 1, max = 120, required = true} = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) fail(file, name + ' is required');
    return null;
  }
  if (typeof value !== 'string' || value.trim().length < min || value.length > max)
    fail(file, name + ' must be a string of ' + min + '..' + max + ' characters');
  return value.trim();
}

function relativePath(value, file, name) {
  const valueText = text(value, file, name, {max: 240});
  if (valueText.startsWith('/') || valueText.startsWith('\\') || valueText.includes('..'))
    fail(file, name + ' must stay inside the game root');
  return valueText.replace(/\\/g, '/');
}

function capabilitiesOf(value, file, online, runtime) {
  if (value === undefined || value === null) value = {};
  if (typeof value !== 'object' || Array.isArray(value))
    fail(file, 'capabilities must be an object');
  const policy = RUNTIME_POLICY[runtime];
  const allowed = new Set([
    ...(policy.requiredCapabilities ?? []),
    ...(policy.optionalCapabilities ?? []),
  ]);
  const output = {};
  for (const [key, enabled] of Object.entries(value)) {
    if (!allowed.has(key)) fail(file, 'unknown capability ' + key + ' for runtime ' + runtime);
    if (typeof enabled !== 'boolean') fail(file, 'capability ' + key + ' must be boolean');
    output[key] = enabled;
  }
  if (online) {
    for (const key of policy.requiredCapabilities) {
      if (output[key] !== true) fail(file, 'online runtime requires capability ' + key);
    }
  }
  return Object.freeze(output);
}

function blockersOf(value, file, online) {
  if (online) {
    if (value !== undefined && !(Array.isArray(value) && value.length === 0))
      fail(file, 'online games must not declare blockers');
    return Object.freeze([]);
  }
  if (!Array.isArray(value) || value.length < 1)
    fail(file, 'offline games must declare at least one blocker');
  const blockers = [...new Set(value.map(code => {
    if (typeof code !== 'string' || !CODE_PATTERN.test(code))
      fail(file, 'blocker must be an uppercase code');
    return code;
  }))];
  return Object.freeze(blockers);
}

function evidenceOf(value, file) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) fail(file, 'evidence must be an array');
  return Object.freeze(value.map(item => {
    if (typeof item !== 'string' || item.length > 240 || !EVIDENCE_PATTERN.test(item))
      fail(file, 'evidence must be a safe relative reference');
    return item;
  }));
}

function packageOf(value, file, online, runtime) {
  if (value === undefined || value === null) {
    if (online) fail(file, 'online games require a package descriptor');
    return null;
  }
  if (typeof value !== 'object' || Array.isArray(value))
    fail(file, 'package must be an object');
  const dir = relativePath(value.dir, file, 'package.dir');
  const entry = relativePath(value.entry, file, 'package.entry');
  const levels = relativePath(value.levels, file, 'package.levels');
  const templeId = text(value.templeId, file, 'package.templeId', {max: 40});
  const storagePrefix = text(value.storagePrefix, file, 'package.storagePrefix', {max: 60});
  const wrapper = value.wrapper == null ? null : relativePath(value.wrapper, file, 'package.wrapper');
  const game = value.game == null ? null : relativePath(value.game, file, 'package.game');
  if (runtime === LOCKSTEP_RUNTIME) {
    const bridge = relativePath(value.bridge, file, 'package.bridge');
    if (!/^(?:[\w-]+\/)*[\w.-]+\.mjs$/.test(bridge) || entry !== 'index.html')
      fail(file, 'lockstep packages require index.html and a local .mjs bridge');
    return Object.freeze({dir, entry, levels, templeId, storagePrefix, bridge});
  }
  if (runtime === 'flash-ruffle' && (!wrapper || !game))
    fail(file, 'flash-ruffle packages require package.wrapper and package.game');
  return Object.freeze({dir, entry, levels, templeId, storagePrefix, wrapper, game});
}

function orderOf(value, file) {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0 || value > 999)
    fail(file, 'order must be an integer from 0 to 999');
  return value;
}

/** Optional seat capacity. Omitted means DEFAULT_SEATS so old manifests stay valid. */
function seatsOf(value, file) {
  if (value === undefined || value === null) return DEFAULT_SEATS;
  if (!Number.isInteger(value) || value < MIN_SEATS || value > MAX_SEATS)
    fail(file, 'seats must be an integer from ' + MIN_SEATS + ' to ' + MAX_SEATS);
  return value;
}

function adapterOf(value, file, online) {
  if (!online) {
    if (value !== undefined && value !== null) fail(file, 'offline games must not declare an adapter');
    return null;
  }
  const adapter = text(value ?? DEFAULT_ADAPTER, file, 'adapter', {max: 40});
  if (!ADAPTER_PATTERN.test(adapter)) fail(file, 'adapter must match ' + ADAPTER_PATTERN);
  if (!SUPPORTED_ADAPTERS.includes(adapter))
    fail(file, 'adapter ' + adapter + ' is not installed');
  return adapter;
}

export function validateGameManifest(manifest, {file = 'manifest'} = {}) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest))
    fail(file, 'manifest must be an object');
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION)
    fail(file, 'unsupported schemaVersion (expected ' + MANIFEST_SCHEMA_VERSION + ')');
  const id = text(manifest.id, file, 'id', {max: 32});
  if (!ID_PATTERN.test(id)) fail(file, 'id must match ' + ID_PATTERN);
  const runtime = text(manifest.runtime, file, 'runtime', {max: 40});
  if (!Object.hasOwn(RUNTIME_POLICY, runtime)) fail(file, 'unknown runtime ' + runtime);
  if (typeof manifest.online !== 'boolean') fail(file, 'online must be boolean');
  if (manifest.listed !== undefined && typeof manifest.listed !== 'boolean')
    fail(file, 'listed must be boolean');
  if (manifest.online !== RUNTIME_POLICY[runtime].online)
    fail(file, 'runtime ' + runtime + ' cannot be declared online=' + manifest.online);
  if (runtime === 'flash-ruffle' && manifest.adapter !== FLASH_MIRROR_ADAPTER)
    fail(file, 'flash-ruffle games require adapter ' + FLASH_MIRROR_ADAPTER);
  const seats = seatsOf(manifest.seats, file);
  const minSeats = manifest.minSeats == null ? seats : seatsOf(manifest.minSeats, file);
  if (minSeats > seats) fail(file, 'minSeats must not exceed seats');
  if ((runtime === LOCKSTEP_RUNTIME) !== (manifest.adapter === LOCKSTEP_ADAPTER))
    fail(file, 'browser-lockstep and frame-lockstep must be used together');
  if (runtime === LOCKSTEP_RUNTIME && seats !== 2)
    fail(file, 'browser-lockstep requires exactly two seats');
  const arena = arenaRuntimes.has(runtime);
  if ((arena || arenaRuntimes.has(manifest.adapter)) && manifest.adapter !== runtime)
    fail(file, runtime + ' runtime requires its matching arena adapter');
  if (arena && minSeats < 2)
    fail(file, runtime + ' requires at least two players');
  if (!arena && (seats > 4 || minSeats !== seats))
    fail(file, 'runtime requires a fixed seat count of four or fewer');
  const normalized = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    id,
    title: text(manifest.title, file, 'title', {max: 80}),
    subtitle: text(manifest.subtitle, file, 'subtitle', {max: 120, required: false}),
    runtime,
    runtimeLabel: RUNTIME_POLICY[runtime].label,
    adapter: adapterOf(manifest.adapter, file, manifest.online),
    online: manifest.online,
    listed: manifest.listed !== false,
    blockers: blockersOf(manifest.blockers, file, manifest.online),
    capabilities: capabilitiesOf(manifest.capabilities, file, manifest.online, runtime),
    seats,
    minSeats,
    order: orderOf(manifest.order, file),
    package: packageOf(manifest.package, file, manifest.online, runtime),
    evidence: evidenceOf(manifest.evidence, file),
    notes: text(manifest.notes, file, 'notes', {max: 500, required: false}),
    source: file,
  };
  return Object.freeze(normalized);
}

function publicManifest(manifest) {
  return Object.freeze({
    id: manifest.id,
    title: manifest.title,
    subtitle: manifest.subtitle,
    runtime: manifest.runtime,
    runtimeLabel: manifest.runtimeLabel,
    adapter: manifest.adapter,
    online: manifest.online,
    listed: manifest.listed !== false,
    blockers: manifest.blockers,
    capabilities: manifest.capabilities,
    seats: manifest.seats ?? DEFAULT_SEATS,
    minSeats: manifest.minSeats ?? manifest.seats ?? DEFAULT_SEATS,
    order: manifest.order,
    evidence: manifest.evidence,
    notes: manifest.notes,
    source: manifest.source,
  });
}

/** Read one manifest directory. Missing directory is an error for callers that require it. */
export async function loadGameManifests({dir} = {}) {
  if (typeof dir !== 'string' || !dir.trim()) throw Error('GAME_MANIFEST_DIR_REQUIRED');
  let names;
  try { names = await readdir(dir); }
  catch (error) {
    if (error.code === 'ENOENT') throw Error('GAME_MANIFEST_DIR_MISSING: ' + dir);
    throw error;
  }
  const files = names.filter(name => name.endsWith('.json')).sort();
  if (!files.length) throw Error('GAME_MANIFEST_DIR_EMPTY: ' + dir);
  const seen = new Set();
  const manifests = [];
  for (const name of files) {
    const file = path.join(dir, name);
    let parsed;
    try { parsed = JSON.parse(await readFile(file, 'utf8')); }
    catch (error) {
      if (error instanceof SyntaxError) fail(name, 'invalid JSON');
      throw error;
    }
    const manifest = validateGameManifest(parsed, {file: name});
    if (seen.has(manifest.id)) fail(name, 'duplicate game id ' + manifest.id);
    seen.add(manifest.id);
    manifests.push(manifest);
  }
  manifests.sort((a, b) => (a.order ?? 1000) - (b.order ?? 1000) || a.id.localeCompare(b.id));
  return Object.freeze(manifests);
}

/** Load playable and research manifests together, enforcing a single global id space. */
export async function loadGameRegistry({gamesDir, researchDir} = {}) {
  const playable = gamesDir ? await loadGameManifests({dir: gamesDir}) : Object.freeze([]);
  const research = researchDir ? await loadGameManifests({dir: researchDir}) : Object.freeze([]);
  const ids = new Map();
  for (const manifest of [...playable, ...research]) {
    if (ids.has(manifest.id))
      throw Error('GAME_MANIFEST_INVALID: duplicate game id across registries: ' + manifest.id);
    ids.set(manifest.id, manifest);
  }
  for (const manifest of playable) {
    if (!manifest.online) throw Error('GAME_REGISTRY_INVALID: playable registry contains offline game ' + manifest.id);
  }
  for (const manifest of research) {
    if (manifest.online) throw Error('GAME_REGISTRY_INVALID: research registry contains online game ' + manifest.id);
  }
  return Object.freeze({
    playable: Object.freeze(playable.map(publicManifest)),
    research: Object.freeze(research.map(publicManifest)),
  });
}

/** Map an online manifest to the legacy catalog definition consumed by game-catalog.mjs. */
export function manifestToCatalogDefinition(manifest) {
  if (!manifest?.online || !manifest.package)
    throw Error('GAME_ADAPTER_NOT_ONLINE: ' + (manifest?.id ?? 'unknown'));
  const pkg = manifest.package;
  const levelsParts = pkg.levels.split('/'); // data/<temple>/temple.json or levels.json
  levelsParts.pop();
  return Object.freeze({
    id: manifest.id,
    dir: pkg.dir,
    title: manifest.title,
    subtitle: manifest.subtitle ?? '',
    templeId: pkg.templeId,
    storagePrefix: pkg.storagePrefix,
    dataDir: levelsParts.length ? levelsParts[levelsParts.length - 1] : '',
    levelsPath: pkg.levels,
    entryFile: pkg.entry,
    bridgeFile: pkg.bridge ?? null,
    wrapperFile: pkg.wrapper ?? null,
    gameFile: pkg.game ?? null,
    runtime: manifest.runtime,
    adapter: manifest.adapter,
    listed: manifest.listed !== false,
    capabilities: manifest.capabilities,
    seats: manifest.seats ?? DEFAULT_SEATS,
    minSeats: manifest.minSeats ?? manifest.seats ?? DEFAULT_SEATS,
    blockers: manifest.blockers,
  });
}
