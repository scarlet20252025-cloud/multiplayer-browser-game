#!/usr/bin/env node
// Two isolated browser contexts, the same original movie, and an identical input trace.
// Capture comparisons are visual evidence. This does not export the ActionScript heap.
import {createHash} from 'node:crypto';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright';
import {startOriginalGameHost} from './original-game-host.mjs';
import {installRuffleClock} from './ruffle-clock.mjs';
import {duelActionEffects} from './bomb-it-duel-evidence.mjs';

const {values} = parseArgs({options: {
  root: {type: 'string'},
  entry: {type: 'string'},
  dpr: {type: 'string'},
  'boot-frames': {type: 'string'},
  shots: {type: 'string'},
  probe: {type: 'boolean'},
  preload: {type: 'boolean'},
  'constant-date': {type: 'boolean'},
  duel: {type: 'boolean'},
  report: {type: 'string'},
  'synthetic-pointer': {type: 'boolean'},
  'menu-only': {type: 'boolean'},
}});
const root = values.root ?? 'local/original-games/bomb-it';
const entry = values.entry ?? 'bomb-it-7.swf';
const dpr = Number(values.dpr ?? 0.25);
const bootFrames = Number(values['boot-frames'] ?? 1800);
if (!Number.isFinite(dpr) || dpr < 0.25 || dpr > 2 || !Number.isSafeInteger(bootFrames) || bootFrames < 1)
  throw new Error('Invalid browser scale or boot frame count');
if (values.preload && !values.probe) throw new Error('--preload requires --probe and its preload wrapper');
if (values.duel && !values.probe) throw new Error('--duel requires --probe to verify zero bots and both players');
const host = await startOriginalGameHost({root, entry});
let browser;
const checkpoints = [];
const evidence = {entry, bootFrames, deviceScaleFactor: dpr, checkpoints};
const statePrefix = 'BOMB_IT_PROBE_STATE ';
const advance = (page, frames) => page.evaluate(count => globalThis.__ruffleClock.advance(count), frames);
const applyKeys = (page, keys, down) => page.evaluate(({keys, down}) => {
  for (const code of keys) {
    const key = code === 'KeyD' ? 'd' : code === 'Space' ? ' ' : code;
    globalThis.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
      code, key, cancelable: true, bubbles: true,
    }));
  }
}, {keys, down});
const syntheticStageClick = (page, x, y) => page.evaluate(({logicalX, logicalY}) => {
  const player = globalThis.__baseline.player;
  const canvas = player.shadowRoot.querySelector('#container canvas');
  const rect = canvas.getBoundingClientRect();
  const clientX = rect.left + logicalX * rect.width / 700;
  const clientY = rect.top + logicalY * rect.height / 510;
  player.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
  for (const type of ['pointerenter', 'pointermove', 'pointerdown', 'pointerup']) {
    canvas.dispatchEvent(new PointerEvent(type, {
      clientX, clientY, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      button: 0, buttons: type === 'pointerdown' ? 1 : 0,
      composed: true, bubbles: true, cancelable: true,
    }));
  }
}, {logicalX: x - 162, logicalY: y - 129});
const toPayload = message => message?.startsWith(statePrefix) ? message.slice(statePrefix.length) : null;
function snapshotShape(snapshot) {
  if (!snapshot) return null;
  const robots = snapshot[2];
  const grid = snapshot[5];
  const cells = grid?.flat();
  const clock = snapshot[1]?.slice(0, 4);
  const gridBombs = cells?.reduce((count, cell) => count + (cell?.at(-1)?.length ?? 0), 0);
  const modelBombs = robots?.some(robot => Array.isArray(robot[6]))
    ? robots.reduce((count, robot) => count + (robot[6]?.[1]?.length ?? 0), 0)
    : null;
  return {
    rate: snapshot[0],
    robots: robots?.length,
    players: snapshot[3]?.length,
    rows: grid?.length,
    bombs: modelBombs ?? gridBombs,
    clock,
  };
}
const readyToCompare = shape => shape?.rows > 0 && shape?.robots >= 2 && shape?.players >= 2;
function firstDifference(left, right, at = []) {
  if (left === right) return null;
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length)
    return {at, left, right};
  for (let index = 0; index < left.length; index++) {
    const diff = firstDifference(left[index], right[index], [...at, index]);
    if (diff) return diff;
  }
  return null;
}

async function capture(run, checkpoint, index) {
  const {data} = await run.cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: {x: 162, y: 129, width: 700, height: 510, scale: 1},
  });
  const bytes = Buffer.from(data, 'base64');
  if (values.shots) await writeFile(path.join(values.shots, `${checkpoint}-${index + 1}.png`), bytes);
  return createHash('sha256').update(bytes).digest('hex');
}

try {
  if (values.shots) await mkdir(values.shots, {recursive: true});
  browser = await chromium.launch();
  const runs = await Promise.all(Array.from({length: 2}, async () => {
    const context = await browser.newContext({
      viewport: {width: 1024, height: 768},
      deviceScaleFactor: dpr,
      locale: 'en-US',
      timezoneId: 'UTC',
    });
    await context.addInitScript(installRuffleClock, {
      epochMs: 1_700_000_000_000,
      tickMs: 25,
      constantDate: values['constant-date'] ?? false,
    });
    const page = await context.newPage();
    await page.goto(host.url);
    await page.waitForFunction(() => globalThis.__baseline?.metadata?.width === 700, null, {polling: 100});
    await page.waitForFunction(() => globalThis.__baseline?.status === 'loaded', null, {polling: 100});
    if (values.probe) {
      await page.evaluate(() => {
        globalThis.__probeMessages = [];
        globalThis.__baseline.player.ruffle().traceObserver = message => {
          if (message.startsWith('BOMB_IT_PROBE_')) globalThis.__probeMessages.push(message);
        };
      });
    }
    return {page, cdp: await context.newCDPSession(page)};
  }));
  console.log('Both independent Ruffle players loaded matching 700×510 stages.');

  let previousDuelState = null;
  const getProbeStates = () => Promise.all(runs.map(async ({page}) => {
    await applyKeys(page, ['F9'], true);
    await applyKeys(page, ['F9'], false);
    return page.evaluate(() => globalThis.__probeMessages.splice(0).at(-1) ?? null);
  }));
  const compare = async (label, inspectState = false) => {
    const hashes = await Promise.all(runs.map((run, index) => capture(run, checkpoints.length, index)));
    const frame = await runs[0].page.evaluate(() => globalThis.__ruffleClock.frame);
    const result = {label, frame, match: hashes[0] === hashes[1], hashes};
    if (values.probe && inspectState) {
      const states = await getProbeStates();
      const payloads = states.map(toPayload);
      const snapshots = payloads.map(payload => JSON.parse(payload));
      result.stateShape = snapshots.map(snapshotShape);
      result.stateMatch = result.stateShape.every(readyToCompare)
        && payloads[0] === payloads[1];
      if (snapshots.every(Boolean) && !result.stateMatch)
        result.firstDifference = firstDifference(snapshots[0], snapshots[1]);
      result.states = payloads.map((payload, index) => payload
        ? createHash('sha256').update(payload).digest('hex') : states[index]);
      if (values.duel && result.stateMatch) {
        const shape = result.stateShape[0];
        const positions = snapshots[0][2].map(robot => robot.slice(1, 3));
        result.duel = shape.robots === 2 && shape.players === 2
          && positions.every(pair => pair.length === 2 && pair.every(Number.isFinite));
        if (previousDuelState && label === 'two independent directions')
          result.duel &&= positions.every((pair, index) =>
            pair.some((value, axis) => value !== previousDuelState.positions[index][axis]));
        const grid = snapshots[0][5];
        if (previousDuelState && label === 'two independent action keys') {
          result.actionEffects = duelActionEffects(previousDuelState.grid, grid, positions);
          result.duel &&= result.actionEffects.length === 2;
        }
        if (previousDuelState && label === 'clock advances after actions')
          result.duel &&= shape.clock.some((value, index) => value !== previousDuelState.clock[index]);
        previousDuelState = {positions, grid, clock: shape.clock};
      }
      if (values.shots) {
        const scope = checkpoints.length;
        await Promise.all(states.map((message, index) => writeFile(
          path.join(values.shots, `${scope}-state-${index + 1}.txt`),
          (message ?? 'No probe output.') + '\n',
        )));
      }
    }
    checkpoints.push(result);
    console.log(JSON.stringify(checkpoints.at(-1)));
  };
  const stepBoth = async frames => {
    for (let remaining = frames; remaining > 0;) {
      const count = Math.min(200, remaining);
      await Promise.all(runs.map(({page}) => advance(page, count)));
      remaining -= count;
    }
  };
  const waitForActors = async () => {
    let last;
    for (let batch = 0; batch < 10; batch++) {
      const messages = await getProbeStates();
      const shapes = messages.map(toPayload).map(payload => snapshotShape(JSON.parse(payload)));
      if (shapes.every(readyToCompare)) {
        evidence.actorsReadyAfterExtraTicks = batch * 20;
        return;
      }
      last = shapes.map((shape, index) => shape ?? messages[index]);
      if (batch < 9) await stepBoth(20);
    }
    throw new Error('Two-player map never reached an observable initialized state: ' + JSON.stringify(last));
  };
  const clickBoth = (x, y, overlay = false) => Promise.all(runs.map(({page}) =>
    values['synthetic-pointer'] && !overlay ? syntheticStageClick(page, x, y) : page.mouse.click(x, y)));
  if (values.preload) {
    await stepBoth(3);
    await Promise.all(runs.map(({page}) => page.waitForFunction(
      () => globalThis.__probeMessages.includes('BOMB_IT_PROBE_FETCHED 8740427'),
      null,
      {polling: 100, timeout: 10_000},
    )));
    console.log('Both original SWFs fully fetched before virtual child start.');
    await Promise.all(runs.map(async ({page}) => {
      await page.evaluate(() => {
        globalThis.__baseline.player.dispatchEvent(new FocusEvent('focusin', {bubbles: true}));
      });
      await applyKeys(page, ['F8'], true);
      await applyKeys(page, ['F8'], false);
    }));
    let ready = false;
    for (let batch = 0; batch < 8 && !ready; batch++) {
      await stepBoth(4);
      const statuses = await Promise.all(runs.map(({page}) => page.evaluate(
        () => globalThis.__probeMessages.some(message => message.startsWith('BOMB_IT_PROBE_READY ')),
      )));
      ready = statuses.every(Boolean);
    }
    if (!ready) {
      const diagnostics = await Promise.all(runs.map(({page}) => page.evaluate(() => globalThis.__probeMessages)));
      throw new Error('The synchronized child SWFs did not initialize: ' + JSON.stringify(diagnostics));
    }
    console.log('Both child SWFs initialized after the shared virtual F8 gate.');
  }
  for (let processed = 0; processed < bootFrames;) {
    const count = Math.min(200, bootFrames - processed);
    const started = performance.now();
    await stepBoth(count);
    processed += count;
    console.log(`Boot frame ${processed}/${bootFrames}, ${Math.round(performance.now() - started)}ms elapsed this batch.`);
  }
  await compare('cold boot');

  for (const [label, x, y, frames] of [
    ['hardware overlay', 821, 152, 2],
    ['mode menu', 747, 356, 500],
    ...(values.duel ? [['battle royale mode', 772, 407, 20]] : []),
    ['settings', 713, 594, 45],
    ['two players', 449, 270, 8],
    ...(values.duel ? [['zero bots', 592, 307, 8]] : []),
    ['boutique arena', 410, 386, 8],
    ['character selection', 711, 595, 35],
  ]) {
    await clickBoth(x, y, label === 'hardware overlay');
    await stepBoth(frames);
    await compare(label);
  }
  if (values['menu-only']) {
    evidence.passed = checkpoints.every(result => result.match);
    if (!evidence.passed) process.exitCode = 1;
  } else {
    await clickBoth(704, 594);
    await stepBoth(475);
    await compare('stage mission overlay');
    if (values.probe) await waitForActors();
    if (values['constant-date']) await Promise.all(runs.map(({page}) =>
      page.evaluate(() => globalThis.__ruffleClock.resumeWallClock())));
    await clickBoth(710, 585);
    await stepBoth(30);
    await compare('active stage', true);

    for (const [label, keys, frames] of [
      ['two independent directions', ['KeyD', 'ArrowLeft'], 18],
      ['two independent action keys', ['Space', 'Enter'], 28],
      ['clock advances after actions', [], 140],
    ]) {
      for (const down of [true, false]) {
        await Promise.all(runs.map(({page}) => applyKeys(page, keys, down)));
        if (down) await stepBoth(frames);
      }
      await compare(label, true);
    }

    if (checkpoints.some(result => values.probe
      ? result.stateMatch === false || result.duel === false
      : !result.match)) process.exitCode = 1;
    evidence.passed = !process.exitCode;
  }
} catch (error) {
  evidence.passed = false;
  evidence.error = error.message;
  throw error;
} finally {
  await browser?.close();
  await host.close();
  if (values.report) {
    await mkdir(path.dirname(values.report), {recursive: true});
    await writeFile(values.report, JSON.stringify(evidence, null, 2) + '\n');
  }
}
