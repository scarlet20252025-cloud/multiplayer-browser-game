export const PROTOCOL = 1;
export const GAME_ID = 'as3-probe';
export const BUILD_ID = 'as3-probe-1';
export const STEP_HZ = 25;
export const INPUT_TIMEOUT_MS = 600;
export const MAX_INPUTS_PER_SECOND = 120;

const allowedKeys = new Set(['type', 'seq', 'moveX', 'moveY', 'buttons', 'aimX', 'aimY']);

export function validateInput(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return 'INVALID_INPUT';
  if (Object.keys(message).some(key => !allowedKeys.has(key))) return 'UNKNOWN_INPUT_FIELD';
  if (!Number.isSafeInteger(message.seq) || message.seq < 0) return 'INVALID_SEQUENCE';
  if (![-1, 0, 1].includes(message.moveX) || ![-1, 0, 1].includes(message.moveY)) return 'INVALID_DIRECTION';
  if (!Number.isInteger(message.buttons) || message.buttons < 0 || message.buttons > 65535) return 'INVALID_BUTTONS';
  for (const key of ['aimX','aimY']) if (message[key] !== undefined &&
    (!Number.isFinite(message[key]) || message[key] < 0 || message[key] > 1)) return 'INVALID_AIM';
  return null;
}

/** Holds are replaceable; rising/falling edges survive a short tap between ticks. */
export class InputBuffer {
  seq = -1;
  moveX = 0;
  moveY = 0;
  buttons = 0;
  pressed = 0;
  released = 0;
  receivedAt = 0;
  aimX = .5;
  aimY = .5;

  receive(message, now) {
    const error = validateInput(message);
    if (error) return error;
    if (message.seq <= this.seq) return 'STALE_INPUT';
    this.pressed |= message.buttons & ~this.buttons;
    this.released |= this.buttons & ~message.buttons;
    this.seq = message.seq;
    this.moveX = message.moveX;
    this.moveY = message.moveY;
    this.buttons = message.buttons;
    if (message.aimX !== undefined) this.aimX = message.aimX;
    if (message.aimY !== undefined) this.aimY = message.aimY;
    this.receivedAt = now;
    return null;
  }

  release() {
    this.released |= this.buttons;
    this.moveX = 0;
    this.moveY = 0;
    this.buttons = 0;
  }

  /** Session boundaries discard pending actions but keep sequence/aim continuity. */
  resetPending() {
    this.moveX = 0;
    this.moveY = 0;
    this.buttons = 0;
    this.pressed = 0;
    this.released = 0;
    this.receivedAt = 0;
  }

  consume(now) {
    if (now - this.receivedAt > INPUT_TIMEOUT_MS) {
      this.release();
      this.pressed = 0;
    }
    const value = {moveX: this.moveX, moveY: this.moveY, buttons: this.buttons,
      pressed: this.pressed, released: this.released, seq: this.seq, aimX:this.aimX, aimY:this.aimY};
    this.pressed = 0;
    this.released = 0;
    return value;
  }
}

export function validateSnapshot(value, previousTick = -1) {
  if (!value || value.protocol !== PROTOCOL || value.version !== BUILD_ID) return false;
  if (!Number.isInteger(value.tick) || value.tick < 0 || value.tick > 2147483647 || value.tick <= previousTick) return false;
  if (!Array.isArray(value.players) || value.players.length !== 2) return false;
  return value.players.every((player, index) => player && player.id === index &&
    Number.isFinite(player.x) && player.x >= 16 && player.x <= 624 &&
    Number.isFinite(player.y) && player.y >= 16 && player.y <= 344 &&
    Number.isInteger(player.buttons) && player.buttons >= 0 && player.buttons <= 65535 &&
    Number.isFinite(player.aimX) && player.aimX >= 0 && player.aimX <= 1 &&
    Number.isFinite(player.aimY) && player.aimY >= 0 && player.aimY <= 1 &&
    ['pressedCount','releasedCount'].every(key => Number.isInteger(player[key]) &&
      player[key] >= 0 && player[key] <= 2147483647));
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)].toFixed(3));
}
