// Authored object fixtures only. These tests never execute the original game.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapshotExporter, diffSnapshots, SNAPSHOT_SOURCE_SHA256 } from '../adapters/fireboy-html5/state-snapshot.mjs';

class Diamond {}
const sprite = (x, y, frame = 4) => ({
  x, y, rotation: 0, visible: true, alpha: 1, frame, frameName: `fixture-${frame}`,
  scale: { x: 1, y: 1 },
  animations: { currentAnim: { name: 'authored-test-animation', isPlaying: true }, currentFrame: { index: frame }, _outputFrames: [4, 5, 6] },
});
const body = (x, y) => ({ x, y, rotation: 0, sprite: sprite(x, y) });
const character = (char, x) => ({
  body: body(x, 200), sprite: sprite(x, 200), data: { char, diamonds: 0, silverDiamond: 0 },
  cursors: { left: { isDown: false }, right: { isDown: false }, up: { isDown: false } },
  bodyParts: { head: sprite(0, 0), legs: sprite(0, 0), ice: sprite(0, 0) },
  prohibitJump: false, isDead: false, dying: false, facing: 'idle',
});
function fixture() {
  const diamond = Object.assign(new Diamond(), sprite(80, 160), { body: body(80, 160), sprite: sprite(0, -3), data: { char: 'wg' } });
  const lever = { options: { type: 'lever', id: 10, properties: { group: 2 } }, body: body(40, 210), state: 0, base: sprite(40, 210), lights: [sprite(0, 0)] };
  const pusher = { options: { type: 'pusher', id: 11, properties: { group: 2 } }, button: { ...sprite(90, 210), body: body(90, 210) }, state: 1, base: sprite(90, 220), lights: [] };
  const platform = { options: { type: 'platform', id: 12, properties: { group: 2 } }, body: body(120, 210), sprite: sprite(120, 210), state: 1, lights: [] };
  const door = char => ({ data: { char }, body: body(400, 250), sprite: sprite(400, 254, 5), currentFrac: 1.25, isOpen: true, isUp: false });
  const level = { pers1: character('fb', 10), pers2: character('wg', 100), door1: door('fb'), door2: door('wg'), objects: [lever, pusher, platform], levelStarted: true, ended: false };
  const game = { level, paused: false, layers: { underGround: { children: [diamond, platform.sprite] } }, MechManager: { deviceGroups: { 2: [lever, pusher, platform] } }, physics: { box2d: { paused: false } } };
  game.level.game = game;
  game.layers.underGround.parent = game;
  const options = { sourceGameSha256: SNAPSHOT_SOURCE_SHA256, sessionEpoch: 'authored-test', devices: { Diamond }, now: () => '2026-11-17T00:00:00.000Z', readUpdateId: () => 12 };
  return { game, options, diamond, lever, pusher, platform };
}

test('projects the actual container contract without exposing engine references', () => {
  const { game, options } = fixture();
  const output = createSnapshotExporter(game, options).capture();
  assert.deepEqual(output.counts, { characters: 2, diamonds: 1, doors: 2, mechanisms: 3 });
  assert.equal(output.coverage.requiredPresent, true);
  assert.equal(output.coverage.allObservedPositionsFinite, true);
  assert.equal(output.coverage.completeGameState, false);
  assert.equal(output.observedGameUpdate, 12);
  assert.deepEqual(output.unsupported, []);
  assert.equal(output.mechanisms.find(x => x.kind === 'pusher').position.x, 90);
  assert.equal(output.mechanisms.find(x => x.kind === 'lever').display.x, 40);
  assert.equal(output.doors[0].openFramePosition, 1);
  assert.equal(output.diamonds[0].display.y, -3);
  assert.equal(output.diamonds[0].position.y, 160);
  assert.deepEqual(JSON.parse(JSON.stringify(output)), output);
  assert.ok(!JSON.stringify(output).includes('deviceChanged'));
});

test('stable entity IDs survive array reordering and manager aliases are deduplicated', () => {
  const { game, options } = fixture();
  const exporter = createSnapshotExporter(game, options);
  const before = exporter.capture();
  game.level.objects.reverse();
  game.MechManager.deviceGroups[2].reverse();
  const after = exporter.capture();
  assert.deepEqual(before.mechanisms.map(x => x.id).sort(), after.mechanisms.map(x => x.id).sort());
  assert.equal(after.mechanisms.length, 3);
  assert.equal(after.mechanisms[0].sourcePaths.length, 2);
  assert.equal(diffSnapshots(before, after).changes.length, 0);
});

test('game pause and Box2D pause are separate observations and no update counter is invented', () => {
  const { game, options } = fixture();
  const { readUpdateId: ignored, ...withoutUpdateCallback } = options;
  game.paused = true;
  const exporter = createSnapshotExporter(game, withoutUpdateCallback);
  const first = exporter.capture();
  assert.equal(first.level.gamePaused, true);
  assert.equal(first.level.physicsPaused, false);
  assert.equal(Object.hasOwn(first.level, 'paused'), false);
  assert.equal(first.observedGameUpdate, null);
  game.paused = false;
  game.physics.box2d.paused = true;
  const second = exporter.capture();
  assert.equal(second.level.gamePaused, false);
  assert.equal(second.level.physicsPaused, true);
  assert.equal(second.observedGameUpdate, null);
});

test('successive observations report motion, animation and mechanism state changes by ID', () => {
  const { game, options, lever } = fixture();
  const exporter = createSnapshotExporter(game, options);
  const before = exporter.capture();
  game.level.pers2.body.y -= 25;
  lever.state = 1;
  game.level.door2.sprite.animations.currentFrame.index = 6;
  const after = exporter.capture();
  const diff = exporter.diff(before, after);
  assert.equal(diff.sameLevel, true);
  assert.equal(diff.changes.length, 3);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.equal(after.doors[1].openFramePosition, 2);
});

test('diamond disappearance is observed without inventing a collection event', () => {
  const { game, options } = fixture();
  const exporter = createSnapshotExporter(game, options);
  const before = exporter.capture();
  game.layers.underGround.children.shift();
  const after = exporter.capture();
  const diff = exporter.diff(before, after);
  assert.deepEqual(diff.removed, [before.diamonds[0].id]);
  assert.equal(diff.removalMeaning, 'absent-from-observed-containers; cause-not-inferred');
  assert.equal(after.diamonds.length, 0);
  assert.equal(after.coverage.requiredPresent, false);
});

test('new level objects get an epoch even when entity objects are reused', () => {
  const { game, options } = fixture();
  const exporter = createSnapshotExporter(game, options);
  const before = exporter.capture();
  game.level = { ...game.level };
  const after = exporter.capture();
  assert.equal(after.levelEpoch, before.levelEpoch + 1);
  assert.notEqual(after.characters[0].id, before.characters[0].id);
  assert.equal(exporter.diff(before, after).sameLevel, false);
});

test('a restarted scene receives a new epoch even if Phaser reuses its State instance', () => {
  const { game, options } = fixture();
  game.level.root = {};
  const exporter = createSnapshotExporter(game, options);
  const before = exporter.capture();
  game.level.root = {};
  game.level.pers1 = character('fb', 10);
  game.level.pers2 = character('wg', 100);
  const after = exporter.capture();
  assert.equal(after.levelEpoch, before.levelEpoch + 1);
  assert.notEqual(after.doors[0].id, before.doors[0].id);
  assert.equal(exporter.diff(before, after).sameLevel, false);
});

test('container accessors, cycles and unrecognized mechanism names are not executed or guessed', () => {
  const { game, options } = fixture();
  let invoked = 0;
  Object.defineProperty(game.level.objects, '3', { enumerable: true, get() { invoked++; throw Error('must not be read'); } });
  game.MechManager.deviceGroups.unknown = [{ options: { type: 'unknown-device' }, constructor: { name: 'Lever' } }];
  const impostor = { constructor: { name: 'Diamond' }, data: { char: 'wg' } };
  game.layers.underGround.children.push(impostor);
  const snapshot = createSnapshotExporter(game, options).capture();
  assert.equal(invoked, 0);
  assert.equal(snapshot.diamonds.length, 1);
  assert.equal(snapshot.mechanisms.length, 3);
  assert.ok(snapshot.unsupported.some(x => x.reason === 'accessor-skipped'));
  assert.ok(snapshot.unsupported.some(x => x.reason === 'mechanism-type-not-projected:unknown-device'));
});

test('nonfinite observations are null plus a reason, never silently JSON-coerced', () => {
  const { game, options } = fixture();
  game.level.pers2.body.y = Infinity;
  const snapshot = createSnapshotExporter(game, options).capture();
  assert.equal(snapshot.characters[1].position.y, null);
  assert.equal(snapshot.coverage.allObservedPositionsFinite, false);
  assert.ok(snapshot.unsupported.some(x => x.reason === 'non-finite-number'));
  assert.deepEqual(JSON.parse(JSON.stringify(snapshot)), snapshot);
});

test('missing real Diamond constructor and unreviewed source are explicit gaps', () => {
  const { game, options } = fixture();
  const snapshot = createSnapshotExporter(game, { ...options, devices: {}, sourceGameSha256: 'a'.repeat(64) }).capture();
  assert.equal(snapshot.diamonds.length, 0);
  assert.equal(snapshot.coverage.requiredPresent, false);
  assert.equal(snapshot.coverage.sourceBuildAudited, false);
  assert.ok(snapshot.unsupported.some(x => x.path === 'Devices.Diamond'));
  assert.ok(snapshot.unsupported.some(x => x.reason === 'source-build-not-audited'));
});

test('scan and entity limits yield explicit incomplete observations', () => {
  const { game, options } = fixture();
  const snapshot = createSnapshotExporter(game, { ...options, maxEntities: 3, maxContainerEntries: 2 }).capture();
  assert.equal(snapshot.coverage.requiredPresent, false);
  assert.ok(snapshot.unsupported.some(x => x.reason === 'entity-limit'));
  assert.ok(snapshot.unsupported.some(x => x.reason === 'container-scan-limit'));
});


test('real HTML5 Box/BoxPrototype movable crate exports body, sprite and state changes', () => {
  const {game,options}=fixture();
  const crate={options:{type:'box',id:23,properties:{}},
    body:body(151,220),sprite:sprite(151,220)};
  game.level.objects.push(crate);
  const exporter=createSnapshotExporter(game,options);
  const first=exporter.capture();
  const observed=first.mechanisms.find(x=>x.kind==='box');
  assert.ok(observed,'Box in level.objects must not be an unsupported mechanism');
  assert.deepEqual(observed.position,{x:151,y:220});
  assert.equal(observed.display.x,151);
  assert.ok(!first.unsupported.some(x=>x.reason==='mechanism-type-not-projected:box'));
  crate.body.x=170;
  crate.sprite.x=170;
  crate.sprite.rotation=.4;
  const next=exporter.capture();
  assert.equal(next.mechanisms.find(x=>x.id===observed.id).position.x,170);
  assert.ok(exporter.diff(first,next).changes.some(x=>x.id===observed.id));
});
