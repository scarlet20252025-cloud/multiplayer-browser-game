#!/usr/bin/env node
import assert from 'node:assert/strict';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright';
import {startGameLobby} from './start-game-lobby.mjs';

const {values} = parseArgs({options: {
  swf: {type: 'string', default: 'local/original-games/bomb-it/bomb-it-7.swf'},
  seed: {type: 'string', default: '43'},
  preview: {type: 'string', default: 'local/bomb-it-preview'},
  shots: {type: 'string'},
}});
const seed = Number(values.seed);
assert.ok(Number.isSafeInteger(seed) && seed >= 0 && seed <= 0xffff_ffff);
const preview = path.resolve(values.preview);
const directions = [
  {name: 'right', dx: 1, dy: 0, mask: 2},
  {name: 'down', dx: 0, dy: 1, mask: 8},
  {name: 'left', dx: -1, dy: 0, mask: 1},
  {name: 'up', dx: 0, dy: -1, mask: 4},
];

function findBreakableBox(snapshot) {
  const grid = snapshot[5];
  const [, startX, startY] = snapshot[2][0];
  const [, opponentX, opponentY] = snapshot[2][1];
  const visited = new Set([`${startX},${startY}`, `${opponentX},${opponentY}`]);
  const queue = [{x: startX, y: startY, moves: []}];
  for (const position of queue) {
    for (const direction of directions) {
      const x = position.x + direction.dx;
      const y = position.y + direction.dy;
      const cell = grid[x]?.[y];
      if (!cell) continue;
      if (cell[6] === true) return {x, y, direction, moves: position.moves};
      const key = `${x},${y}`;
      if (cell[5] !== null || cell[3] || visited.has(key)) continue;
      visited.add(key);
      queue.push({x, y, moves: [...position.moves, {x, y, direction}]});
    }
  }
  throw new Error('The original map has no accessible breakable obstacle');
}

let app, browser;
try {
  app = await startGameLobby({
    root: path.join(preview, 'empty'), manifestsDir: path.join(preview, 'manifests'),
    shanyiRoot: path.join(preview, 'packages'),
    roomsFile: path.join(preview, 'obstacle-verification-rooms.json'),
    host: '127.0.0.1', viewerPort: 17695, lobbyPort: 17696, bombItSwf: values.swf,
  });
  browser = await chromium.launch();
  const page = await browser.newPage({viewport: {width: 750, height: 550}, deviceScaleFactor: 0.5});
  const errors = [];
  const recordError = message => {
    errors.push(message.slice(0, 2500));
    if (errors.length > 5) errors.shift();
  };
  page.on('pageerror', error => recordError(error.message));
  page.on('console', message => {
    if (message.type() === 'error' || /%c(?:ERROR|WARN)%c/.test(message.text())) recordError(message.text());
  });
  await page.route('**/__verify-bomb-it-obstacle__', route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Bomb It obstacle verification</title><main style="width:700px"></main>',
  }));
  await page.route('**/bomb-it-7/netplay.mjs', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = '      stateHash() {';
    assert.ok(source.includes(marker), 'Could not expose the existing state probe to the local test');
    await route.fulfill({response, body: source.replace(marker, `      inspectForTest: inspect,\n${marker}`)});
  });
  await page.goto(new URL('/__verify-bomb-it-obstacle__', app.url).href);
  const probeResponse = page.waitForResponse(response => response.ok() && new URL(response.url()).pathname === '/bomb-it-7/snapshot-probe.swf',
    {timeout: 45_000});
  const starting = page.evaluate(async seed => {
    const {createGame} = await import('/bomb-it-7/netplay.mjs');
    const game = await createGame({mount: document.querySelector('main'), seed, tickRate: 40});
    let frame = 0;
    globalThis.bombItTest = {
      inspect: () => game.inspectForTest(),
      step: (mask = 0, pressed = 0) => game.step({frame: ++frame, masks: [mask, 0], pressed: [pressed, 0]}),
      get frame() { return frame; },
    };
    return bombItTest.inspect();
  }, seed);
  starting.catch(() => {});
  const probe = await probeResponse;
  assert.equal(await probe.finished(), null);
  console.log('The browser received the staged Bomb It bridge and SWF probe.');
  const beforeState = await starting;
  assert.ok(beforeState[5].some(column => column.some(cell => cell?.[6] === true)),
    'The deployed probe needs live Grid.box and canDestroy fields');
  const target = findBreakableBox(beforeState);
  await page.evaluate(({moves, direction}) => {
    const test = globalThis.bombItTest;
    for (const move of moves) {
      let reached = false;
      for (let step = 0; step < 24; step++) {
        test.step(move.direction.mask, step === 0 ? move.direction.mask : 0);
        const [, x, y] = test.inspect()[2][0];
        if (x === move.x && y === move.y) {
          reached = true;
          break;
        }
      }
      if (!reached) throw new Error(`Could not walk to tile ${move.x},${move.y}`);
      for (let step = 0; step < 8; step++) test.step();
    }
    test.step(direction.mask, direction.mask);
    for (let step = 0; step < 4; step++) test.step();
  }, target);
  const prior = await page.evaluate(({x, y}) => {
    const state = bombItTest.inspect();
    return {box: state[5][x][y], robot: state[2][0].slice(1, 3)};
  }, target);
  assert.deepEqual(prior.robot, [target.x - target.direction.dx, target.y - target.direction.dy]);
  assert.equal(prior.box[6], true);

  // Original 700×510 Fashion Shop projection: X offset 160 and 32-pixel cells.
  const frame = await page.locator('main iframe').boundingBox();
  assert.ok(frame && frame.width === 700 && frame.height === 510);
  const clip = {x: frame.x + 160 + target.x * 32 + 6, y: frame.y + target.y * 32 + 6, width: 20, height: 20};
  const before = await page.screenshot({clip, scale: 'css'});
  errors.length = 0;
  const result = await page.evaluate(({x, y}) => {
    const test = globalThis.bombItTest;
    const initial = test.inspect();
    const firstStrikeFrame = test.frame + 1;
    let destructionFrame;
    for (let step = 0; step < 80; step++) {
      test.step(step < 8 ? 16 : 0, step === 0 ? 16 : 0);
      const state = test.inspect();
      if (state[5][x][y][5] === null) {
        destructionFrame = test.frame;
        break;
      }
    }
    if (destructionFrame) for (let step = 0; step < 32; step++) test.step();
    const state = test.inspect();
    const cleared = [];
    for (const [ix, column] of initial[5].entries()) {
      for (const [iy, cell] of column.entries()) {
        if (cell?.[5] && state[5][ix][iy]?.[5] === null) cleared.push([ix, iy]);
      }
    }
    return {
      firstStrikeFrame, destructionFrame, finalFrame: test.frame, finalCell: state[5][x][y], cleared,
      playerBefore: initial[3][0], playerAfter: state[3][0], robotAfter: state[2][0],
    };
  }, target);
  const after = await page.screenshot({clip, scale: 'css'});
  if (values.shots) {
    await mkdir(values.shots, {recursive: true});
    await Promise.all([
      writeFile(path.join(values.shots, 'obstacle-before.png'), before),
      writeFile(path.join(values.shots, 'obstacle-after.png'), after),
    ]);
  }
  assert.ok(result.destructionFrame, `The hammer did not clear Grid.box at ${target.x},${target.y}: ${JSON.stringify({...result, errors})}`);
  assert.equal(result.finalCell[5], null, 'The destroyed obstacle returned to the live grid');
  const changedPixels = await page.evaluate(async encoded => {
    const pixels = await Promise.all(encoded.map(async base64 => {
      const bytes = Uint8Array.from(atob(base64), digit => digit.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], {type: 'image/png'}));
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    }));
    let changed = 0;
    for (let index = 0; index < pixels[0].length; index += 4) {
      const difference = Math.abs(pixels[0][index] - pixels[1][index])
        + Math.abs(pixels[0][index + 1] - pixels[1][index + 1])
        + Math.abs(pixels[0][index + 2] - pixels[1][index + 2]);
      if (difference >= 60) changed++;
    }
    return changed;
  }, [before, after].map(image => image.toString('base64')));
  assert.ok(changedPixels >= 40, `Expected the obstacle crop to visibly change, got ${changedPixels}/400 pixels`);
  console.log(JSON.stringify({passed: true, seed, tile: [target.x, target.y], changedPixels, ...result}));
} finally {
  await browser?.close();
  await app?.close();
}
