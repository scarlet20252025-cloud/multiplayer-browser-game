export const LOCKSTEP_RUNTIME = 'browser-lockstep';
export const FRAME_RATE = 30;
export const CHECKPOINT_FRAMES = 30;
// How many frames the server may run ahead of the slowest acknowledgement.
// Four frames (100 ms at 40 Hz) stalls on any public-route round trip, so keep
// enough slack to absorb a ~250 ms ack while the client catches up.
export const MAX_FRAME_LEAD = 10;
export const MIN_LOCKSTEP_PLAYERS = 2;
export const MAX_LOCKSTEP_PLAYERS = 4;

export const BOMB_IT_MAPS = Object.freeze([
  'FashionShop', 'Cake', 'Classroom', 'Forest', 'Race', 'Ranch', 'ToyShop', 'Christmas', 'Sand',
]);
export const BOMB_IT_MODES = Object.freeze(['kill', 'collect', 'pacMan', 'frozen']);
export const BOMB_IT_DEFAULT_SETTINGS = Object.freeze({mapId: 'FashionShop', modeId: 'kill'});
export const isBombItSettings = value => BOMB_IT_MAPS.includes(value?.mapId) && BOMB_IT_MODES.includes(value?.modeId);

export const CONTROLS = Object.freeze({
  KeyA: 1, KeyD: 2, KeyW: 4, KeyS: 8, KeyJ: 16,
  KeyK: 32, KeyL: 64, KeyU: 128, KeyI: 256, KeyO: 512,
});
export const MAX_INPUT_MASK = Object.values(CONTROLS).reduce((mask, bit) => mask | bit, 0);
export const isStateHash = value => typeof value === 'string' && /^[a-f0-9]{8,64}$/.test(value);
export const isFrameRate = value => Number.isInteger(value) && value >= 1 && value <= 120;
export const isLockstepPlayerCount = value =>
  Number.isInteger(value) && value >= MIN_LOCKSTEP_PLAYERS && value <= MAX_LOCKSTEP_PLAYERS;
export const isWinner = (value, playerCount = MIN_LOCKSTEP_PLAYERS) =>
  value === null || (Number.isInteger(value) && value >= 0 && value < playerCount);
export const isCheckpoint = frame => frame === 1 || frame % CHECKPOINT_FRAMES === 0;
