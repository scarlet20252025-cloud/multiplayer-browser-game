/**
 * Original adapter for the inspected Forest Temple HTML5 candidate.
 * This module is NOT a transport or a server authorization implementation.
 *
 * Source observations (candidate SHA-256 337125629748bace45e23b040e54b0d206e4cd78c9c8709d7785faa637e00677):
 * - The level binds togglePause to itself, then registers it on P with no context.
 * - HUD pause and the pause menu's Resume button call level.togglePause dynamically.
 * - The native toggle changes game.paused, the pause menu and the gameplay clock.
 *   It does not write physics.box2d.paused. Calling the native handler preserves
 *   engine pause/resume signals and UI behavior; assigning only a physics flag does not.
 *
 * Install after the level is ready. A host must deliver trusted, ordered room
 * state to applyAuthoritativeState, own focus/ad pause policy separately, and
 * uninstall({restoreNative:false}) before destroying a level. clientId identifies
 * this client game incarnation; use a fresh clientId after a full page/game restart.
 * No browser/game
 * compatibility is established by the authored unit tests for this module.
 */

const installations = new WeakMap();
// Keep command IDs distinct across level changes or reinstallations in one game.
// The whole table becomes collectible with that game; it contains no game assets.
const commandCounters = new WeakMap();

function identity(value, name) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) {
    throw new TypeError(`${name} must be a nonempty string of at most 128 characters`);
  }
}

function requireSignal(signal) {
  if (!signal || !['has', 'add', 'remove'].every(name => typeof signal[name] === 'function')) {
    throw new TypeError('pauseKey.onDown must support has/add/remove');
  }
  if (signal.memorize === true) throw new Error('A memorizing pause signal is not supported');
}

export function installPauseBridge({level, sendRoomCommand, roomEpoch, clientId} = {}) {
  if (!level || typeof level !== 'object') throw new TypeError('level is required');
  if (typeof sendRoomCommand !== 'function') throw new TypeError('sendRoomCommand is required');
  identity(roomEpoch, 'roomEpoch');
  identity(clientId, 'clientId');

  const existing = installations.get(level);
  if (existing) {
    if (existing.sender !== sendRoomCommand || existing.epoch !== roomEpoch || existing.client !== clientId) {
      throw new Error('A different pause bridge is already installed on this level');
    }
    if (level.togglePause !== existing.replacement || !existing.signal.has(existing.keyHandler, null)) {
      throw new Error('The installed pause bridge was changed by another owner');
    }
    return existing.controller;
  }

  const originalDescriptor = Object.getOwnPropertyDescriptor(level, 'togglePause');
  if (!originalDescriptor || typeof originalDescriptor.value !== 'function' || !originalDescriptor.writable) {
    throw new TypeError('Expected the ready level to own a writable, bound togglePause function');
  }
  const nativeToggle = originalDescriptor.value;
  const game = level.game;
  if (!game || typeof game.paused !== 'boolean') throw new TypeError('game.paused must be boolean');
  const pauseKey = level.pauseKey;
  const signal = pauseKey?.onDown;
  requireSignal(signal);
  // null is the inspected Signal implementation's default registration context.
  if (!signal.has(nativeToggle, null)) throw new Error('Expected native P listener was not found');

  let counters = commandCounters.get(game);
  if (!counters) { counters = new Map(); commandCounters.set(game, counters); }
  const counterKey = JSON.stringify([roomEpoch, clientId]);
  let counter = counters.get(counterKey);
  if (!counter) { counter = {value: 0}; counters.set(counterKey, counter); }

  let installed = true;
  let revision = -1;
  let confirmedPaused = game.paused;
  let pending = null;
  let lastTransportError = null;

  function assertInstalled() {
    if (!installed) throw new Error('Pause bridge is uninstalled');
  }

  function inspect() {
    return {
      installed, roomEpoch, revision, confirmedPaused,
      localGamePaused: game.paused,
      localPhysicsPaused: typeof game.physics?.box2d?.paused === 'boolean' ? game.physics.box2d.paused : null,
      pendingCommand: pending ? {...pending} : null,
      lastTransportError: lastTransportError ? {...lastTransportError} : null,
    };
  }

  function transportFailure(command, error) {
    if (installed && pending?.commandId === command.commandId) {
      lastTransportError = {commandId: command.commandId, message: String(error?.message ?? error)};
    }
  }

  function send(command) {
    lastTransportError = null;
    try {
      const result = sendRoomCommand(command);
      // A resolved send is not an acknowledgement. State arrives separately.
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(error => transportFailure(command, error));
      }
      return {sent: true, command: {...command}};
    } catch (error) {
      transportFailure(command, error);
      return {sent: false, reason: 'transport-error', command: {...command}};
    }
  }

  function requestPaused(desiredPaused) {
    assertInstalled();
    if (typeof desiredPaused !== 'boolean') throw new TypeError('desiredPaused must be boolean');
    // One outstanding intent avoids repeated input toggling against stale room state.
    if (pending) return {sent: false, reason: 'pending', command: {...pending}};
    if (desiredPaused === confirmedPaused) return {sent: false, reason: 'already-confirmed'};
    if (counter.value === Number.MAX_SAFE_INTEGER) throw new Error('Pause command sequence exhausted');
    const sequence = ++counter.value;
    pending = Object.freeze({
      type: 'room-command', command: 'pause.set', roomEpoch,
      commandId: `${clientId}:${sequence}`, sequence, baseRevision: revision, desiredPaused,
    });
    return send(pending);
  }

  function requestToggle() {
    // Return no false value: Phaser.Signal treats false as stop-propagation.
    requestPaused(!confirmedPaused);
  }

  function onKeyDown() {
    // Phaser normally dispatches only the down transition. Its input reset can
    // reset that latch on resume; a native repeated key event is still not a new intent.
    if (pauseKey.event?.repeat === true) return;
    requestToggle();
  }

  function applyAuthoritativeState(state) {
    assertInstalled();
    if (!state || typeof state !== 'object' || typeof state.paused !== 'boolean'
      || !Number.isSafeInteger(state.revision) || state.revision < 0) {
      throw new TypeError('Authoritative pause state requires boolean paused and a nonnegative safe revision');
    }
    if (state.roomEpoch !== roomEpoch) return {accepted: false, changed: false, reason: 'wrong-epoch'};
    if (state.revision < revision) return {accepted: false, changed: false, reason: 'stale'};
    if (state.revision === revision) {
      if (state.paused !== confirmedPaused) throw new Error('Conflicting pause values for the same revision');
      return {accepted: true, changed: false, reason: 'duplicate'};
    }
    const changed = game.paused !== state.paused;
    if (changed) {
      // Use the captured native handler, not our request-producing replacement.
      nativeToggle.call(level);
      if (game.paused !== state.paused) throw new Error('Native pause handler did not reach the requested state');
    }
    revision = state.revision;
    confirmedPaused = state.paused;
    pending = null;
    lastTransportError = null;
    return {accepted: true, changed, reason: 'applied'};
  }

  function retryPending() {
    assertInstalled();
    return pending ? send(pending) : {sent: false, reason: 'no-pending'};
  }

  function uninstall({restoreNative = true} = {}) {
    if (!installed) return {removed: false, originalListenerRestored: false};
    if (typeof restoreNative !== 'boolean') throw new TypeError('restoreNative must be boolean');
    const ownsMethod = Object.getOwnPropertyDescriptor(level, 'togglePause')?.value === requestToggle;
    // Never overwrite a later adapter's function or unexpectedly re-enable its native P path.
    if (ownsMethod) Object.defineProperty(level, 'togglePause', originalDescriptor);
    signal.remove(onKeyDown, null);
    const restoreListener = restoreNative && ownsMethod && (!game.level || game.level === level);
    if (restoreListener && !signal.has(nativeToggle, null)) signal.add(nativeToggle, null);
    installed = false;
    pending = null;
    installations.delete(level);
    return {removed: true, originalMethodRestored: ownsMethod, originalListenerRestored: restoreListener};
  }

  const controller = Object.freeze({applyAuthoritativeState, requestPaused, retryPending, inspect, uninstall});
  // Validate first, then alter only the exact known binding and this method.
  Object.defineProperty(level, 'togglePause', {...originalDescriptor, value: requestToggle});
  try {
    signal.remove(nativeToggle, null);
    signal.add(onKeyDown, null);
  } catch (error) {
    signal.remove(onKeyDown, null);
    Object.defineProperty(level, 'togglePause', originalDescriptor);
    if (!signal.has(nativeToggle, null)) signal.add(nativeToggle, null);
    throw error;
  }
  installations.set(level, {controller, sender: sendRoomCommand, epoch: roomEpoch, client: clientId,
    replacement: requestToggle, keyHandler: onKeyDown, signal});
  return controller;
}
