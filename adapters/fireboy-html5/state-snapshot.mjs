/**
 * Authored, read-only observation adapter for the inspected Forest Temple JS.
 * No original game code, assets, map data, or simulation is included here.
 *
 * Audited source SHA-256: 337125629748bace45e23b040e54b0d206e4cd78c9c8709d7785faa637e00677
 * Source locations: characters/doors 45016-45029; diamonds 38336-38395;
 * level.objects 44814 / 45010-45014; deviceGroups 43245-43251;
 * mechanism types 43305-43325; body pixel getters 37383-37396.
 *
 * Collection discovery reads own data properties only. Known body/sprite API
 * getters are read explicitly when projecting an already identified instance.
 * This is an observation snapshot, not a VM/Box2D checkpoint or render adapter.
 */

export const SNAPSHOT_SOURCE_SHA256 = '337125629748bace45e23b040e54b0d206e4cd78c9c8709d7785faa637e00677';
const CATEGORIES = ['characters', 'diamonds', 'doors', 'mechanisms'];
// HTML5 first-level Box/BoxPrototype is a movable Box2D entity, not a static tile.
const SUPPORTED_MECHANISMS = new Set(['lever', 'pusher', 'platform', 'box']);
const objectLike = value => value !== null && (typeof value === 'object' || typeof value === 'function');
const ownData = (object, key) => {
  if (!objectLike(object)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
};

/** Compare observations by stable IDs. An absent entity is not called collected. */
export function diffSnapshots(previous, next) {
  if (!previous || !next || previous.schemaVersion !== 1 || next.schemaVersion !== 1) {
    throw new TypeError('Two schemaVersion 1 snapshots are required');
  }
  const sameLevel = previous.sessionEpoch === next.sessionEpoch && previous.levelEpoch === next.levelEpoch;
  const flatten = snapshot => new Map(CATEGORIES.flatMap(category => snapshot[category].map(entity => [entity.id, entity])));
  const before = flatten(previous);
  const after = flatten(next);
  // Paths describe container membership, not identity or gameplay state.
  const withoutPaths = ({ sourcePaths: ignored, ...entity }) => entity;
  const changes = [];
  if (sameLevel) {
    for (const [id, entity] of after) {
      const prior = before.get(id);
      if (prior && JSON.stringify(withoutPaths(prior)) !== JSON.stringify(withoutPaths(entity))) {
        changes.push({ id, kind: entity.kind, before: withoutPaths(prior), after: withoutPaths(entity) });
      }
    }
  }
  return {
    fromSnapshotSeq: previous.snapshotSeq,
    toSnapshotSeq: next.snapshotSeq,
    sameLevel,
    added: [...after.keys()].filter(id => !sameLevel || !before.has(id)),
    removed: [...before.keys()].filter(id => !sameLevel || !after.has(id)),
    removalMeaning: sameLevel ? 'absent-from-observed-containers; cause-not-inferred' : 'level-or-session-changed',
    changes,
  };
}

/**
 * @param {object} game The instrumented real game instance, or an authored test fixture.
 * @param {object} options Caller must hash the source; this adapter does not read files.
 * @returns {{capture: function(): object, diff: typeof diffSnapshots}}
 */
export function createSnapshotExporter(game, {
  sourceGameSha256,
  sessionEpoch,
  devices = globalThis.Devices,
  readUpdateId = () => null,
  now = () => new Date().toISOString(),
  maxEntities = 2048,
  maxContainerEntries = 10000,
} = {}) {
  if (!objectLike(game)) throw new TypeError('A game instance is required');
  if (typeof sourceGameSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sourceGameSha256)) {
    throw new TypeError('sourceGameSha256 must be the measured SHA-256 of the input script');
  }
  if (typeof sessionEpoch !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(sessionEpoch)) {
    throw new TypeError('sessionEpoch must be a nonempty session identifier (letters, digits, dot, dash, underscore)');
  }
  if (!Number.isSafeInteger(maxEntities) || maxEntities < 1 || !Number.isSafeInteger(maxContainerEntries) || maxContainerEntries < 1) {
    throw new TypeError('Collection limits must be positive safe integers');
  }
  if (typeof readUpdateId !== 'function' || typeof now !== 'function') throw new TypeError('Invalid observation callbacks');

  let snapshotSeq = 0;
  let levelEpoch = 0;
  let lastLevel;
  let lastRoot;
  let lastPlayerOne;
  let lastPlayerTwo;
  let nextEntity = 0;
  let identities = new WeakMap();
  // Preserve original spawn identities after the live diamond is destroyed.
  // The current Phaser children[] index is not stable across removals.
  let diamondRoster = new Map();

  function capture() {
    const unsupported = [];
    const report = (path, reason) => unsupported.push({ path, reason });
    const read = (object, key, path) => {
      if (!objectLike(object)) return undefined;
      try { return object[key]; } catch { report(path, 'known-field-read-threw'); return undefined; }
    };
    const scalar = (value, path) => {
      if (value == null) return null;
      if (typeof value === 'number') {
        if (Number.isFinite(value)) return value;
        report(path, 'non-finite-number');
        return null;
      }
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string' && value.length <= 256) return value;
      report(path, 'not-a-supported-scalar');
      return null;
    };
    const field = (object, key, path) => scalar(read(object, key, `${path}.${key}`), `${path}.${key}`);
    const position = (body, path) => body ? { x: field(body, 'x', path), y: field(body, 'y', path) } : null;
    const display = (sprite, path) => {
      if (!objectLike(sprite)) return null;
      const scale = ownData(sprite, 'scale');
      const animations = ownData(sprite, 'animations');
      const currentAnim = ownData(animations, 'currentAnim');
      const currentFrame = read(animations, 'currentFrame', `${path}.animations.currentFrame`);
      return {
        x: field(sprite, 'x', path), y: field(sprite, 'y', path), rotation: field(sprite, 'rotation', path),
        visible: field(sprite, 'visible', path), alpha: field(sprite, 'alpha', path),
        frame: field(sprite, 'frame', path), frameName: field(sprite, 'frameName', path),
        scale: scale ? { x: field(scale, 'x', `${path}.scale`), y: field(scale, 'y', `${path}.scale`) } : null,
        animation: animations ? {
          name: field(currentAnim, 'name', `${path}.animations.currentAnim`),
          playing: field(currentAnim, 'isPlaying', `${path}.animations.currentAnim`),
          frameIndex: field(currentFrame, 'index', `${path}.animations.currentFrame`),
        } : null,
      };
    };
    let scanned = 0;
    let limitsHit = false;
    const dataEntries = (container, path) => {
      if (!objectLike(container)) { report(path, 'container-unavailable'); return []; }
      const output = [];
      for (const key of Object.keys(container)) {
        if (Array.isArray(container) && !/^(0|[1-9]\d*)$/.test(key)) continue;
        if (++scanned > maxContainerEntries) { limitsHit = true; report(path, 'container-scan-limit'); break; }
        const descriptor = Object.getOwnPropertyDescriptor(container, key);
        if (!Object.hasOwn(descriptor, 'value')) { report(`${path}[${JSON.stringify(key)}]`, 'accessor-skipped'); continue; }
        output.push([key, descriptor.value]);
      }
      return output;
    };

    const level = ownData(game, 'level');
    const root = ownData(level, 'root');
    const playerOne = ownData(level, 'pers1');
    const playerTwo = ownData(level, 'pers2');
    // Phaser may reuse a State object on restart. The scene root and player
    // instances are also epoch boundaries, so a reused State is not mistaken
    // for continuity of the same runtime objects.
    if (level !== lastLevel || root !== lastRoot || playerOne !== lastPlayerOne || playerTwo !== lastPlayerTwo) {
      lastLevel = level;
      lastRoot = root;
      lastPlayerOne = playerOne;
      lastPlayerTwo = playerTwo;
      levelEpoch++;
      nextEntity = 0;
      identities = new WeakMap();
      diamondRoster = new Map();
    }
    if (!objectLike(level)) report('game.level', 'level-unavailable');
    if (sourceGameSha256 !== SNAPSHOT_SOURCE_SHA256) report('sourceGameSha256', 'source-build-not-audited');

    const entities = new Map();
    const add = (object, category, kind, path, extra = {}) => {
      if (!objectLike(object)) { report(path, 'entity-unavailable'); return; }
      if (entities.has(object)) {
        const prior = entities.get(object);
        if (prior.category !== category || prior.kind !== kind) report(path, 'conflicting-entity-classification');
        if (!prior.paths.includes(path)) prior.paths.push(path);
        return;
      }
      if (entities.size >= maxEntities) { limitsHit = true; report(path, 'entity-limit'); return; }
      let id = identities.get(object);
      if (!id) {
        id = `${sessionEpoch}/${levelEpoch}/${++nextEntity}`;
        identities.set(object, id);
      }
      entities.set(object, { id, object, category, kind, paths: [path], ...extra });
    };
    for (const [slot, key] of ['pers1', 'pers2'].entries()) add(ownData(level, key), 'characters', 'character', `level.${key}`, { slot });
    for (const key of ['door1', 'door2']) add(ownData(level, key), 'doors', 'door', `level.${key}`);

    const layers = ownData(game, 'layers');
    const underGround = ownData(layers, 'underGround');
    const children = ownData(underGround, 'children');
    const Diamond = ownData(devices, 'Diamond');
    const diamondPrototype = ownData(Diamond, 'prototype');
    // Trials and bonus levels can legitimately have no diamonds. Track whether
    // the registry was actually observable instead of demanding a nonempty
    // roster; a missing constructor or unreadable layer must still fail closed.
    const diamondLayerReadable = Array.isArray(children);
    if (!objectLike(diamondPrototype)) report('Devices.Diamond', 'constructor-unavailable; diamonds-not-inferred-from-names');
    if (!diamondLayerReadable) report('game.layers.underGround.children', 'diamond-container-unavailable');
    for (const [index, child] of dataEntries(ownData(underGround, 'children'), 'game.layers.underGround.children')) {
      if (objectLike(child) && objectLike(diamondPrototype) && Object.prototype.isPrototypeOf.call(diamondPrototype, child)) {
        add(child, 'diamonds', 'diamond', `game.layers.underGround.children[${index}]`);
      }
    }

    const addMechanism = (object, path) => {
      if (!objectLike(object)) { report(path, 'invalid-mechanism-entry'); return; }
      const type = ownData(ownData(object, 'options'), 'type');
      if (!SUPPORTED_MECHANISMS.has(type)) {
        report(path, `mechanism-type-not-projected:${typeof type === 'string' ? type.slice(0, 80) : 'unknown'}`);
        return;
      }
      add(object, 'mechanisms', type, path);
    };
    for (const [index, object] of dataEntries(ownData(level, 'objects'), 'level.objects')) addMechanism(object, `level.objects[${index}]`);
    const manager = ownData(game, 'MechManager');
    for (const [group, objects] of dataEntries(ownData(manager, 'deviceGroups'), 'game.MechManager.deviceGroups')) {
      const groupPath = `game.MechManager.deviceGroups[${JSON.stringify(group)}]`;
      for (const [index, object] of dataEntries(objects, groupPath)) addMechanism(object, `${groupPath}[${index}]`);
    }

    const snapshot = {
      schemaVersion: 1,
      scope: 'read-only gameplay/display observation; not a complete render state or physics checkpoint',
      sourceGameSha256, sessionEpoch, levelEpoch, snapshotSeq: ++snapshotSeq,
      capturedAt: scalar(now(), 'capturedAt'),
      observedGameUpdate: null,
      coordinates: { bodyPosition: 'pixels, via Phaser Box2D body.x/y getters', displayPosition: 'local pixels in each existing parent', rotation: 'radians', camera: 'world scroll top-left plus view size and scale' },
      camera: null,
      level: {
        started: field(level, 'levelStarted', 'level'),
        sceneName: field(ownData(game, 'state'), 'current', 'game.state'),
        gamePaused: field(game, 'paused', 'game'),
        ended: field(level, 'ended', 'level'),
        physicsPaused: field(ownData(ownData(game, 'physics'), 'box2d'), 'paused', 'game.physics.box2d'),
      },
      characters: [], diamonds: [], doors: [], mechanisms: [],
      unsupported,
    };
    try {
      const updateId = readUpdateId();
      if (updateId !== null && (!Number.isSafeInteger(updateId) || updateId < 0)) report('observedGameUpdate', 'invalid-observed-update-id');
      else snapshot.observedGameUpdate = updateId;
    } catch { report('observedGameUpdate', 'observation-callback-threw'); }

    for (const entry of entities.values()) {
      const { object, category, kind, id, paths, slot } = entry;
      const path = paths[0];
      const data = ownData(object, 'data');
      const options = ownData(object, 'options');
      const properties = ownData(options, 'properties');
      const button = ownData(object, 'button');
      const body = kind === 'pusher' ? ownData(button, 'body') : ownData(object, 'body');
      const sprite = kind === 'pusher' ? button : kind === 'lever' ? ownData(body, 'sprite') : ownData(object, 'sprite');
      const entity = {
        id, kind, sourcePaths: paths,
        position: position(body, `${path}.${kind === 'pusher' ? 'button.body' : 'body'}`),
        rotation: field(body, 'rotation', `${path}.body`),
        display: display(sprite, `${path}.display`),
      };
      if (!entity.position || !Number.isFinite(entity.position.x) || !Number.isFinite(entity.position.y)) report(path, 'body-position-unavailable');
      if (category === 'characters') {
        const cursors = ownData(object, 'cursors');
        const parts = ownData(object, 'bodyParts');
        entity.slot = slot;
        entity.character = field(data, 'char', `${path}.data`);
        entity.gameplay = {
          diamonds: field(data, 'diamonds', `${path}.data`),
          silverDiamonds: field(data, 'silverDiamond', `${path}.data`),
          prohibitJump: field(object, 'prohibitJump', path),
          dead: field(object, 'isDead', path), dying: field(object, 'dying', path),
          facing: field(object, 'facing', path),
        };
        entity.input = Object.fromEntries(['left', 'right', 'up'].map(key => [key, field(ownData(cursors, key), 'isDown', `${path}.cursors.${key}`)]));
        entity.bodyParts = Object.fromEntries(['head', 'legs', 'ice'].map(key => [key, display(ownData(parts, key), `${path}.bodyParts.${key}`)]));
      } else if (category === 'diamonds') {
        entity.character = field(data, 'char', `${path}.data`);
        entity.presence = 'present-in-underGround';
        entity.rootDisplay = display(object, path);
        if (!diamondRoster.has(id)) {
          const x = entity.rootDisplay?.x, y = entity.rootDisplay?.y;
          if (!Number.isFinite(x) || !Number.isFinite(y) || typeof entity.character !== 'string') {
            report(path, 'diamond-spawn-identity-unavailable');
          } else {
            diamondRoster.set(id, { id, character: entity.character, spawn: { x, y } });
          }
        }
      } else if (category === 'doors') {
        entity.character = field(data, 'char', `${path}.data`);
        entity.isOpen = field(object, 'isOpen', path);
        entity.isUp = field(object, 'isUp', path);
        entity.currentFrac = field(object, 'currentFrac', path);
        const animations = ownData(sprite, 'animations');
        const outputFrames = ownData(animations, '_outputFrames');
        const frameIndex = entity.display?.animation?.frameIndex;
        entity.openFramePosition = Array.isArray(outputFrames) && Number.isFinite(frameIndex) ? outputFrames.indexOf(frameIndex) : null;
      } else {
        entity.state = field(object, 'state', path);
        entity.group = field(properties, 'group', `${path}.options.properties`);
        entity.mapObjectId = field(options, 'id', `${path}.options`);
        entity.baseDisplay = display(ownData(object, 'base'), `${path}.base`);
        const lights = ownData(object, 'lights');
        entity.lights = lights ? dataEntries(lights, `${path}.lights`).map(([index, light]) => display(light, `${path}.lights[${index}]`)) : [];
      }
      snapshot[category].push(entity);
    }
    // Every client needs the spawn roster, including diamonds absent from the
    // current children list. present=false is a tombstone, NOT proof of why it
    // disappeared. Spawns reset only when the level epoch changes.
    const presentDiamonds = new Set(snapshot.diamonds.map(entity => entity.id));
    snapshot.diamondRoster = [...diamondRoster.values()].map(row => ({
      id: row.id, character: row.character, spawn: { ...row.spawn },
      present: presentDiamonds.has(row.id),
    }));
    snapshot.counts = Object.fromEntries(CATEGORIES.map(category => [category, snapshot[category].length]));
    const positionsFinite = CATEGORIES.every(category => snapshot[category].every(entity => Number.isFinite(entity.position?.x) && Number.isFinite(entity.position?.y)));
    snapshot.coverage = {
      requiredPresent: snapshot.characters.length === 2 && snapshot.diamondRoster.length > 0 && snapshot.doors.length === 2 && snapshot.mechanisms.length > 0,
      allObservedPositionsFinite: positionsFinite,
      diamondApparatusObservable: diamondLayerReadable && objectLike(diamondPrototype) && !limitsHit,
      // Two actors and two exits with their real positions are enough to run
      // and project a level; diamonds and mechanisms may legitimately be absent.
      playableCore: snapshot.characters.length === 2 && snapshot.doors.length === 2 &&
        positionsFinite && diamondLayerReadable && objectLike(diamondPrototype) && !limitsHit,
      sourceBuildAudited: sourceGameSha256 === SNAPSHOT_SOURCE_SHA256,
      completeGameState: false,
    };
    const camera=ownData(game,'camera');
    snapshot.camera=camera?{
      x: field(camera,'x','game.camera'),
      y: field(camera,'y','game.camera'),
      width: field(camera,'width','game.camera'),
      height: field(camera,'height','game.camera'),
      scaleX: field(ownData(camera,'scale'),'x','game.camera.scale'),
      scaleY: field(ownData(camera,'scale'),'y','game.camera.scale'),
    }:null;
    return snapshot;
  }

  return Object.freeze({ capture, diff: diffSnapshots });
}
