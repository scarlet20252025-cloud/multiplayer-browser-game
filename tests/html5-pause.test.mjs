// Authored fake Signal/game tests only. They do not run Phaser or the original game.
import test from 'node:test';
import assert from 'node:assert/strict';
import {installPauseBridge} from '../adapters/fireboy-html5/pause-bridge.mjs';

class FakeSignal {
  listeners = [];
  has(fn, context = null) { return this.listeners.some(item => item.fn === fn && item.context === context); }
  add(fn, context = null) { if (!this.has(fn, context)) this.listeners.push({fn, context}); }
  remove(fn, context = null) {
    this.listeners = this.listeners.filter(item => item.fn !== fn || item.context !== context);
  }
  dispatch(...args) {
    for (const item of [...this.listeners]) if (item.fn.apply(item.context, args) === false) break;
  }
}

function fixture(sender) {
  const sent = [];
  const effects = {native: 0, menuShown: 0, menuHidden: 0, clockPaused: 0, clockResumed: 0};
  const game = {paused: false, physics: {box2d: {paused: false}}};
  const level = {
    game,
    pauseKey: {onDown: new FakeSignal(), event: {repeat: false}},
    togglePause() {
      effects.native += 1;
      game.paused = !game.paused;
      if (game.paused) { effects.menuShown += 1; effects.clockPaused += 1; }
      else { effects.menuHidden += 1; effects.clockResumed += 1; }
    },
  };
  game.level = level;
  level.togglePause = level.togglePause.bind(level);
  const native = level.togglePause;
  level.pauseKey.onDown.add(native);
  const options = {level, roomEpoch: 'room-epoch-1', clientId: 'client-a', sendRoomCommand: sender ?? (command => sent.push(command))};
  return {level, game, effects, native, sent, options, install: () => installPauseBridge(options)};
}

function state(revision, paused, roomEpoch = 'room-epoch-1') { return {roomEpoch, revision, paused}; }

test('P requests explicit room pause without local pause or removal of unrelated handlers', () => {
  const f = fixture();
  let otherCalls = 0;
  const context = {label: 'other'};
  function unrelated() { assert.equal(this, context); otherCalls += 1; }
  f.level.pauseKey.onDown.add(unrelated, context);
  const bridge = f.install();
  f.level.pauseKey.onDown.dispatch();
  assert.equal(otherCalls, 1);
  assert.equal(f.effects.native, 0);
  assert.equal(f.game.paused, false);
  assert.equal(f.game.physics.box2d.paused, false);
  assert.equal(f.level.pauseKey.onDown.has(f.native, null), false);
  assert.equal(f.level.pauseKey.onDown.has(unrelated, context), true);
  assert.deepEqual(f.sent, [{type: 'room-command', command: 'pause.set', roomEpoch: 'room-epoch-1',
    commandId: 'client-a:1', sequence: 1, baseRevision: -1, desiredPaused: true}]);
  assert.equal(bridge.inspect().pendingCommand.commandId, 'client-a:1');
});

test('dynamic HUD/Resume calls request state; installation and native restoration are idempotent', () => {
  const f = fixture();
  const before = Object.getOwnPropertyDescriptor(f.level, 'togglePause');
  const bridge = f.install();
  assert.equal(f.install(), bridge);
  assert.equal(f.level.pauseKey.onDown.listeners.length, 1);
  f.level.togglePause();
  assert.equal(f.sent.length, 1);
  assert.equal(f.effects.native, 0);
  assert.equal(bridge.uninstall().originalListenerRestored, true);
  assert.equal(bridge.uninstall().removed, false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(f.level, 'togglePause'), before);
  f.level.pauseKey.onDown.dispatch();
  assert.equal(f.effects.native, 1);
  assert.throws(() => bridge.requestPaused(true), /uninstalled/);
});

test('reinstallation in the same game cannot reuse an earlier room command id', () => {
  const f = fixture();
  const first = f.install();
  first.requestPaused(true);
  first.uninstall();
  const second = f.install();
  second.requestPaused(true);
  assert.deepEqual(f.sent.map(command => command.commandId), ['client-a:1', 'client-a:2']);
  assert.notEqual(first, second);
});

test('authority desired state preserves native menu/clock effects and leaves Box2D flag alone', () => {
  const f = fixture();
  const bridge = f.install();
  assert.deepEqual(bridge.applyAuthoritativeState(state(0, false)), {accepted: true, changed: false, reason: 'applied'});
  f.level.togglePause();
  assert.equal(bridge.applyAuthoritativeState(state(1, true)).changed, true);
  assert.deepEqual(f.effects, {native: 1, menuShown: 1, menuHidden: 0, clockPaused: 1, clockResumed: 0});
  assert.equal(f.game.physics.box2d.paused, false);
  assert.equal(bridge.inspect().pendingCommand, null);
  f.level.togglePause();
  assert.equal(f.sent[1].desiredPaused, false);
  assert.equal(f.sent[1].baseRevision, 1);
  assert.equal(bridge.applyAuthoritativeState(state(2, false)).changed, true);
  assert.deepEqual(f.effects, {native: 2, menuShown: 1, menuHidden: 1, clockPaused: 1, clockResumed: 1});
  assert.equal(f.game.physics.box2d.paused, false);
  assert.equal(f.sent.length, 2, 'applying state must never produce a new request');
});

test('duplicate, stale, conflicting and foreign-epoch state cannot toggle again', () => {
  const f = fixture();
  const bridge = f.install();
  bridge.applyAuthoritativeState(state(4, true));
  assert.equal(bridge.applyAuthoritativeState(state(4, true)).reason, 'duplicate');
  assert.equal(bridge.applyAuthoritativeState(state(3, false)).reason, 'stale');
  assert.equal(bridge.applyAuthoritativeState(state(50, false, 'old-room')).reason, 'wrong-epoch');
  assert.throws(() => bridge.applyAuthoritativeState(state(4, false)), /Conflicting/);
  assert.equal(f.effects.native, 1);
  assert.equal(f.game.paused, true);
  assert.equal(bridge.inspect().revision, 4);
});

test('one pending intent and native repeat guard avoid unwanted flip; retry reuses command id', () => {
  const f = fixture();
  const bridge = f.install();
  f.level.pauseKey.onDown.dispatch();
  f.level.pauseKey.onDown.dispatch();
  assert.equal(bridge.requestPaused(false).reason, 'pending');
  assert.equal(f.sent.length, 1);
  bridge.retryPending();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent[0], f.sent[1]);
  bridge.applyAuthoritativeState(state(0, true));
  f.level.pauseKey.event = {repeat: true};
  f.level.pauseKey.onDown.dispatch();
  assert.equal(f.sent.length, 2);
  f.level.pauseKey.event = {repeat: false};
  f.level.pauseKey.onDown.dispatch();
  assert.equal(f.sent.length, 3);
  assert.equal(f.sent[2].desiredPaused, false);
  assert.equal(f.sent[2].commandId, 'client-a:2');
});

test('transport failures retain an idempotent retry and never pause locally', async () => {
  let rejectSend = true;
  const f = fixture(() => {
    if (rejectSend) throw new Error('offline');
    return Promise.reject(new Error('socket closed'));
  });
  const bridge = f.install();
  assert.equal(bridge.requestPaused(true).reason, 'transport-error');
  assert.equal(bridge.inspect().lastTransportError.message, 'offline');
  assert.equal(f.game.paused, false);
  rejectSend = false;
  bridge.retryPending();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(bridge.inspect().lastTransportError.message, 'socket closed');
  assert.equal(bridge.inspect().pendingCommand.commandId, 'client-a:1');
  bridge.applyAuthoritativeState(state(0, true));
  assert.equal(bridge.inspect().lastTransportError, null);
  assert.equal(bridge.retryPending().reason, 'no-pending');
});

test('reentrant acknowledgement during send clears pending without recursive requests', () => {
  let bridge;
  const f = fixture(command => bridge.applyAuthoritativeState(state(0, command.desiredPaused)));
  bridge = f.install();
  bridge.requestPaused(true);
  assert.equal(bridge.inspect().pendingCommand, null);
  assert.equal(f.effects.native, 1);
});

test('teardown and foreign replacement do not re-enable a stale native P listener', () => {
  const f = fixture();
  const bridge = f.install();
  assert.equal(bridge.uninstall({restoreNative: false}).originalListenerRestored, false);
  assert.equal(f.level.pauseKey.onDown.listeners.length, 0);
  const g = fixture();
  const otherBridge = g.install();
  const foreign = () => {};
  g.level.togglePause = foreign;
  assert.equal(otherBridge.uninstall().originalListenerRestored, false);
  assert.equal(g.level.togglePause, foreign);
  assert.equal(g.level.pauseKey.onDown.listeners.length, 0);
  const h = fixture();
  const oldBridge = h.install();
  h.game.level = {};
  assert.equal(oldBridge.uninstall().originalListenerRestored, false);
});

test('unknown listener layout, configuration changes and invalid states fail without hidden mutation', () => {
  const f = fixture();
  f.level.pauseKey.onDown.remove(f.native);
  f.level.pauseKey.onDown.add(f.native, f.level);
  assert.throws(() => f.install(), /Expected native P listener/);
  assert.equal(f.level.togglePause, f.native);
  const g = fixture();
  const bridge = g.install();
  assert.throws(() => installPauseBridge({...g.options, roomEpoch: 'other'}), /different pause bridge/);
  for (const invalid of [state(-1, true), state(0.5, true), state(0, 1), null]) {
    assert.throws(() => bridge.applyAuthoritativeState(invalid), /requires/);
  }
  assert.throws(() => bridge.requestPaused(1), /boolean/);
  assert.equal(g.effects.native, 0);
  assert.equal(bridge.inspect().revision, -1);
});
