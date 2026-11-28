/** Research instrumentation only. Observe real Box2D steps; never drive the clock. */
export function installJumpObserver(game, { maxSamples = 12000 } = {}) {
  const level = game?.level;
  const world = game?.physics?.box2d?.world;
  const water = level?.pers2;
  const fire = level?.pers1;
  if (!world || typeof world.Step !== 'function' || !water?.body || !fire?.body || !water.cursors?.up) {
    throw new Error('A loaded two-character Box2D level is required');
  }
  const originalStep = world.Step;
  const startedAt = performance.now();
  const samples = [];
  const errors = [];
  let phase = 'settle';
  let stepCount = 0;
  let stopped = false;
  const finite = value => Number.isFinite(value) ? value : null;
  function actor(value) {
    return {
      x: finite(value.body?.x), y: finite(value.body?.y),
      up: value.cursors?.up?.isDown === true,
      prohibitJump: value.prohibitJump === true,
      feetContacts: Array.isArray(value.feetSensor?.contacts) ? value.feetSensor.contacts.length : null,
      dying: value.dying === true, dead: value.dead === true || value.isDead === true,
    };
  }
  function capture(kind = 'observation', dt = null) {
    if (samples.length >= maxSamples) throw new Error('Jump observation sample limit reached');
    const sample = {
      sampleSeq: samples.length, timeMs: performance.now() - startedAt,
      phase, kind, observedPhysicsSteps: stepCount, stepSeconds: finite(dt),
      gamePaused: game.paused === true, physicsPaused: game.physics.box2d.paused === true,
      sameLevel: game.level === level,
      sameCharacters: game.level?.pers1 === fire && game.level?.pers2 === water,
      fire: actor(fire), water: actor(water),
    };
    samples.push(sample);
    return sample;
  }
  function wrappedStep(...args) {
    const returned = Reflect.apply(originalStep, this, args);
    stepCount++;
    try { capture('after-physics-step', args[0]); }
    catch (error) { if (errors.length < 10) errors.push(String(error.message)); }
    return returned;
  }
  world.Step = wrappedStep;
  return {
    capture,
    get stepCount() { return stepCount; },
    setPhase(value) {
      if (stopped || typeof value !== 'string' || !value || value.length > 40) throw new Error('Invalid observation phase');
      phase = value;
      return capture('phase-boundary');
    },
    setJump(held) {
      if (stopped || typeof held !== 'boolean' || game.level !== level || level.pers2 !== water) {
        throw new Error('Jump input requires the original live character and a boolean');
      }
      water.cursors.up.isDown = held;
      return capture('input-write');
    },
    read() { return { samples: samples.map(row => structuredClone(row)), errors: [...errors], observedPhysicsSteps: stepCount }; },
    stop() {
      if (stopped) return;
      water.cursors.up.isDown = false;
      if (world.Step === wrappedStep) world.Step = originalStep;
      else errors.push('World.Step changed after instrumentation; the newer wrapper was preserved');
      stopped = true;
    },
  };
}
