/** Analyze observations, not a substitute physics simulation or an engine proof. */
export function analyzeJumpTrace(trace, options = {}) {
  const config = { holdMs: 2000, minimumHeightPx: 10, landingTolerancePx: 3,
    minimumHeldStepsAfterLanding: 10, minimumHeldMsAfterLanding: 200,
    minimumPhysicsSamples: 20, maximumSampleGapMs: 250, ...options };
  const rows = trace?.samples ?? [];
  const failures = [];
  const blockers = [...(trace?.errors ?? [])];
  const median = values => { const sorted = [...values].sort((a,b) => a-b); return sorted[Math.floor(sorted.length / 2)]; };
  const physics = values => values.filter(row => row.kind === 'after-physics-step');
  const settled = physics(rows.filter(row => row.phase === 'settle')).slice(-15);
  if (settled.length < 10) blockers.push('Insufficient stable-ground observations before the first press');
  const baselineY = median(settled.map(row => row.water?.y).filter(Number.isFinite));
  const fireBaselineY = median(settled.map(row => row.fire?.y).filter(Number.isFinite));
  if (!Number.isFinite(baselineY) || !Number.isFinite(fireBaselineY)) blockers.push('Missing finite baseline body.y');
  if (settled.some(row => !Number.isFinite(row.water?.y) || Math.abs(row.water.y - baselineY) > config.landingTolerancePx || !(row.water.feetContacts > 0))) {
    blockers.push('Water character was not stably on the original ground before pressing');
  }
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!Number.isFinite(row.timeMs) || !Number.isSafeInteger(row.observedPhysicsSteps) ||
      !Number.isFinite(row.water?.y) || !Number.isFinite(row.fire?.y)) {
      blockers.push('Non-finite or missing observation data'); break;
    }
    if (index && (row.timeMs < rows[index-1].timeMs || row.observedPhysicsSteps < rows[index-1].observedPhysicsSteps)) {
      blockers.push('Observation time or physics counter moved backwards'); break;
    }
    if (!row.sameLevel || !row.sameCharacters || row.water.dying || row.water.dead) {
      blockers.push('Level/character identity changed or the water character died'); break;
    }
  }
  const stepRows=physics(rows);
  if(stepRows.some((row,index)=>index&&row.observedPhysicsSteps!==stepRows[index-1].observedPhysicsSteps+1)) {
    blockers.push('One or more real physics-step observations are missing or duplicated');
  }
  const summaries = {};
  const orderedPhases = [];
  for (const row of rows) {
    if (['settle','hold','release','repress'].includes(row.phase) && orderedPhases.at(-1) !== row.phase) orderedPhases.push(row.phase);
  }
  if (JSON.stringify(orderedPhases) !== JSON.stringify(['settle','hold','release','repress'])) {
    blockers.push('Observation phases must occur once in settle -> hold -> release -> repress order');
  }
  for (const name of ['hold', 'repress']) {
    const phaseRows = rows.filter(row => row.phase === name);
    const firstHeldIndex = phaseRows.findIndex(row => row.water?.up === true);
    const lastHeldIndex = phaseRows.findLastIndex(row => row.water?.up === true);
    // Distinct observations can share a timestamp. Their recorded order defines
    // the input edges; keep every row between them, including any intervening release.
    const windowRows = firstHeldIndex < 0 ? [] : phaseRows.slice(firstHeldIndex, lastHeldIndex + 1);
    const heldStart = windowRows[0]?.timeMs ?? Infinity;
    const heldEnd = windowRows.at(-1)?.timeMs ?? -Infinity;
    const active = physics(windowRows);
    const durationMs = windowRows.length > 1 ? heldEnd - heldStart : 0;
    if (durationMs < config.holdMs) blockers.push(`${name}: requested hold duration was not observed`);
    if (active.length < config.minimumPhysicsSamples) blockers.push(`${name}: insufficient real physics updates`);
    if (windowRows.some(row => !row.water.up || row.gamePaused || row.physicsPaused)) blockers.push(`${name}: input was released or game/physics was paused`);
    if (active.some((row,index) => index && row.timeMs - active[index-1].timeMs > config.maximumSampleGapMs)) blockers.push(`${name}: observation gaps are too large to exclude extra jumps`);
    if (!active.length || active[0].timeMs - heldStart > config.maximumSampleGapMs || heldEnd - active.at(-1).timeMs > config.maximumSampleGapMs) {
      blockers.push(`${name}: physics observations do not cover the held interval boundaries`);
    }
    if (active.some((row,index) => index && row.observedPhysicsSteps <= active[index-1].observedPhysicsSteps)) blockers.push(`${name}: duplicate or reversed physics observations`);
    const excursions = [];
    let current = null;
    for (const row of active) {
      const height = baselineY - row.water.y;
      if (!current && height >= config.minimumHeightPx) {
        current = { takeoffTimeMs: row.timeMs, takeoffStep: row.observedPhysicsSteps,
          minimumY: row.water.y, landingTimeMs: null, landingStep: null };
        excursions.push(current);
      }
      if (current) {
        current.minimumY = Math.min(current.minimumY, row.water.y);
        if (Math.abs(height) <= config.landingTolerancePx && row.water.feetContacts > 0) {
          current.landingTimeMs = row.timeMs;
          current.landingStep = row.observedPhysicsSteps;
          current = null;
        }
      }
    }
    if (excursions.length > 1) failures.push(`${name}: more than one jump while continuously held`);
    if (excursions.length === 0) failures.push(`${name}: no jump reached the predefined observation threshold`);
    const first = excursions[0];
    // A brief contact is not proof of landing: require a continuous, grounded
    // tail at the same height through the end of the still-held interval.
    const afterLanding = [];
    if (first?.landingStep != null) {
      for (let i=active.length-1;i>=0;i--) {
        const row=active[i];
        if (row.observedPhysicsSteps <= first.landingStep || Math.abs(row.water.y-baselineY)>config.landingTolerancePx || !(row.water.feetContacts>0)) break;
        afterLanding.unshift(row);
      }
    }
    const afterLandingMs = afterLanding.length>1 ? afterLanding.at(-1).timeMs-afterLanding[0].timeMs : 0;
    if (first && first.landingStep === null) blockers.push(`${name}: character did not return to the original ground within the observation window`);
    if (first && (afterLanding.length < config.minimumHeldStepsAfterLanding || afterLandingMs < config.minimumHeldMsAfterLanding)) {
      blockers.push(`${name}: insufficient still-held updates after landing`);
    }
    if (first && active.some(row => row.timeMs >= first.takeoffTimeMs && !row.water.prohibitJump)) failures.push(`${name}: jump latch cleared while the key was still held`);
    summaries[name] = { durationMs, heldStartMs: heldStart===Infinity?null:heldStart, heldEndMs: heldEnd===-Infinity?null:heldEnd, physicsSamples: active.length, baselineY,
      minimumY: active.length ? Math.min(...active.map(row => row.water.y)) : null,
      finalY: active.at(-1)?.water.y ?? null, excursions,
      stillHeldUpdatesAfterLanding: afterLanding.length, stillHeldMsAfterLanding: afterLandingMs };
  }
  const released = physics(rows.filter(row => row.phase === 'release' && row.timeMs > summaries.hold.heldEndMs && row.timeMs < summaries.repress.heldStartMs));
  const releaseConsumed = released.some(row => row.water.up === false && row.water.prohibitJump === false && !row.gamePaused && !row.physicsPaused);
  if (!releaseConsumed) blockers.push('No observed gameplay update consumed the release and cleared the latch');
  const experimentalRows = rows.filter(row => ['hold','release','repress'].includes(row.phase));
  const fireRange = experimentalRows.length ? Math.max(...experimentalRows.map(row => Math.abs(row.fire.y - fireBaselineY))) : null;
  if (fireRange !== null && fireRange > config.landingTolerancePx) blockers.push('Other character moved vertically; seat isolation needs separate review');
  return {
    status: failures.length ? 'failed' : blockers.length ? 'blocked' : 'passed',
    scope: 'Observed jump edge behavior for one instrumented game build and level only',
    config, failures: [...new Set(failures)], blockers: [...new Set(blockers)],
    releaseConsumed, fireMaximumVerticalDeviationPx: fireRange, phases: summaries,
  };
}
