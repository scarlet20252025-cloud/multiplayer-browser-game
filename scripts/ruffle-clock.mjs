// Inject into an isolated movie page before loading the pinned Ruffle runtime.
export function installRuffleClock({epochMs, tickMs, constantDate = false}) {
  if (!Number.isSafeInteger(epochMs) || !Number.isFinite(tickMs) || tickMs <= 0)
    throw new RangeError('Invalid movie clock');

  let frame = 0;
  let nextCallbackId = 0;
  let firstWallFrame = constantDate ? null : 0;
  const pending = new Map();
  const now = () => frame * tickMs;
  const wallNow = () => epochMs + (firstWallFrame === null ? 0 : (frame - firstWallFrame) * tickMs);
  const OriginalDate = Date;

  globalThis.Date = new Proxy(OriginalDate, {
    apply() {
      return new OriginalDate(wallNow()).toString();
    },
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length ? args : [wallNow()], newTarget);
    },
    get(target, property, receiver) {
      if (property === 'now') return wallNow;
      return Reflect.get(target, property, receiver);
    },
  });
  Object.defineProperties(performance, {
    now: {value: now},
    timeOrigin: {value: epochMs},
  });
  globalThis.requestAnimationFrame = callback => {
    if (typeof callback !== 'function') throw new TypeError('Animation callback must be a function');
    const id = ++nextCallbackId;
    pending.set(id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = id => { pending.delete(id); };

  function runCallbacks(ticks) {
    frame += ticks;
    for (const id of [...pending.keys()]) {
      const callback = pending.get(id);
      if (!callback) continue;
      pending.delete(id);
      callback(now());
    }
  }

  globalThis.__ruffleClock = {
    get frame() { return frame; },
    resumeWallClock() { firstWallFrame ??= frame; },
    advance(frames) {
      if (!Number.isSafeInteger(frames) || frames < 1 || frames > 200)
        throw new RangeError('Movie clock requires 1–200 ticks per call');
      for (let index = 0; index < frames; index++) runCallbacks(1);
    },
    advanceBoot(ticks) {
      if (firstWallFrame !== null || !Number.isSafeInteger(ticks) || ticks < 1 || ticks > 5)
        throw new RangeError('Startup can combine 1–5 ticks before the match clock begins');
      runCallbacks(ticks);
    },
  };
}
