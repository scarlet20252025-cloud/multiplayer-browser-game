export const LOCKSTEP_RUNTIME = 'browser-lockstep';
export const FRAME_RATE = 30;
export const CHECKPOINT_FRAMES = 30;
export const MAX_FRAME_LEAD = 4;

export const CONTROLS = Object.freeze({
  KeyA: 1, KeyD: 2, KeyW: 4, KeyS: 8, KeyJ: 16,
  KeyK: 32, KeyL: 64, KeyU: 128, KeyI: 256, KeyO: 512,
});
export const MAX_INPUT_MASK = Object.values(CONTROLS).reduce((mask, bit) => mask | bit, 0);
export const isStateHash = value => typeof value === 'string' && /^[a-f0-9]{8,64}$/.test(value);
export const isWinner = value => value === 0 || value === 1 || value === null;
export const isCheckpoint = frame => frame === 1 || frame % CHECKPOINT_FRAMES === 0;
