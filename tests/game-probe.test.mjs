import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {deflateSync} from 'node:zlib';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {probeHtml5Package, probeSwfPackage} from '../server/game-probe.mjs';

function rectBytes(width, height) {
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  push(15, 5);
  push(0, 15); push(width * 20, 15);
  push(0, 15); push(height * 20, 15);
  while (bits.length % 8) bits.push(0);
  const bytes = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, index) => { bytes[index >> 3] |= bit << (7 - (index & 7)); });
  return bytes;
}

function swfBody(width, height, extra = '') {
  const rect = rectBytes(width, height);
  const rest = Buffer.alloc(4);
  rest.writeUInt16LE(30 * 256, 0);
  rest.writeUInt16LE(5, 2);
  return Buffer.concat([rect, rest, Buffer.from(extra, 'latin1')]);
}

function fws(body) {
  const header = Buffer.alloc(8);
  header.write('FWS', 0, 'latin1');
  header[3] = 9;
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, body]);
}

function cws(body) {
  const packed = deflateSync(body);
  const header = Buffer.alloc(8);
  header.write('CWS', 0, 'latin1');
  header[3] = 9;
  header.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([header, packed]);
}

async function tempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'game-probe-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('probe parses an uncompressed SWF and classifies a plain package as ruffle research', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'plain.swf');
  await writeFile(file, fws(swfBody(800, 600, 'hello world')));
  const report = await probeSwfPackage({file});
  assert.equal(report.signature, 'FWS');
  assert.equal(report.width, 800);
  assert.equal(report.height, 600);
  assert.equal(report.frameRate, 30);
  assert.equal(report.frameCount, 5);
  assert.equal(report.truncated, false);
  assert.equal(report.runtime, 'flash-ruffle');
  assert.deepEqual(report.blockers, ['NO_BROWSER_RUNTIME', 'RUFFLE_COMPATIBILITY_UNVERIFIED']);
  assert.equal(report.verdict, 'RESEARCH_ONLY');
});

test('probe parses a compressed SWF and detects chained loader shell signatures', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'shell.swf');
  await writeFile(file, cws(swfBody(960, 540, 'A4399dv loadBytes checkAndPlay')));
  const report = await probeSwfPackage({file});
  assert.equal(report.signature, 'CWS');
  assert.equal(report.compressed, true);
  assert.equal(report.truncated, false);
  assert.equal(report.uncompressedBytes, 8 + swfBody(960, 540, 'A4399dv loadBytes checkAndPlay').length);
  assert.equal(report.width, 960);
  assert.equal(report.height, 540);
  assert.equal(report.signals.loaderLoadBytes, true);
  assert.equal(report.signals.checkAndPlay, true);
  assert.equal(report.runtime, 'flash-native');
  assert.deepEqual(report.blockers, ['NO_BROWSER_RUNTIME', 'CHAINED_LOADBYTES', 'PLATFORM_SHELL']);
});

test('probe rejects malformed SWF headers without throwing', async t => {
  const dir = await tempDir(t);
  const badSign = path.join(dir, 'bad-sign.swf');
  await writeFile(badSign, Buffer.from('ABC\x09\x08\x00\x00\x00xxxx'));
  const signReport = await probeSwfPackage({file: badSign});
  assert.equal(signReport.verdict, 'REJECTED');
  assert.ok(signReport.issues.includes('SWF_SIGNATURE_INVALID'));

  const lzma = path.join(dir, 'lzma.swf');
  await writeFile(lzma, Buffer.from('ZWS\x0d\x08\x00\x00\x00xxxx'));
  const lzmaReport = await probeSwfPackage({file: lzma});
  assert.equal(lzmaReport.verdict, 'REJECTED');
  assert.ok(lzmaReport.issues.includes('SWF_LZMA_UNSUPPORTED'));

  const short = path.join(dir, 'short.swf');
  await writeFile(short, Buffer.from('FWS'));
  assert.ok((await probeSwfPackage({file: short})).issues.includes('SWF_TOO_SHORT'));

  const corrupt = path.join(dir, 'corrupt.swf');
  const corruptHeader = Buffer.alloc(8);
  corruptHeader.write('CWS', 0, 'latin1');
  corruptHeader[3] = 9;
  corruptHeader.writeUInt32LE(8 + 11, 4);
  await writeFile(corrupt, Buffer.concat([corruptHeader, Buffer.from('not-zlib...')]));
  const corruptReport = await probeSwfPackage({file: corrupt});
  assert.equal(corruptReport.signature, 'CWS');
  assert.ok(corruptReport.issues.includes('SWF_DATA_INVALID'));
});

test('probe reports declared-length mismatches as issues, not fatal errors', async t => {
  const dir = await tempDir(t);
  const file = path.join(dir, 'truncated.swf');
  await writeFile(file, fws(swfBody(800, 600)));
  const buffer = await probeSwfPackage({file});
  assert.equal(buffer.truncated, false);
  const padded = Buffer.concat([await readFile(file), Buffer.alloc(4)]);
  await writeFile(file, padded);
  const report = await probeSwfPackage({file});
  assert.equal(report.truncated, true);
  assert.ok(report.issues.includes('SWF_DECLARED_LENGTH_MISMATCH'));
});

test('probe accepts a complete HTML5 pack and reports its levels', async t => {
  const dir = await tempDir(t);
  const pack = path.join(dir, 'pack');
  await mkdir(path.join(pack, 'data', 'forest'), { recursive: true });
  await writeFile(path.join(pack, 'index.html'),
    '<html><script src="lib/require.js" data-main="js/main"></script></html>');
  await writeFile(path.join(pack, 'game.json'), JSON.stringify({title: 'Forest'}));
  await writeFile(path.join(pack, 'data', 'forest', 'temple.json'), JSON.stringify({
    id: 'forest',
    levels: [{id: 0, filename: 'a.json'}, {id: 1, filename: 'b.json'}, {id: 1, filename: 'dup.json'}],
  }));
  const report = await probeHtml5Package({dir: pack});
  assert.equal(report.onlineEligible, true);
  assert.equal(report.levelsPath, 'data/forest/temple.json');
  assert.equal(report.templeId, 'forest');
  assert.equal(report.levels, 2);
  assert.equal(report.script, 'js/main');
});

test('probe blocks incomplete HTML5 packs with explicit issues', async t => {
  const dir = await tempDir(t);
  const missing = path.join(dir, 'missing');
  await mkdir(missing);
  const missingReport = await probeHtml5Package({dir: missing});
  assert.equal(missingReport.onlineEligible, false);
  assert.ok(missingReport.issues.includes('HTML5_ENTRY_MISSING'));

  const incomplete = path.join(dir, 'incomplete');
  await mkdir(incomplete);
  await writeFile(path.join(incomplete, 'index.html'), '<script src="require.js"></script>');
  const incompleteReport = await probeHtml5Package({dir: incomplete});
  assert.equal(incompleteReport.onlineEligible, false);
  assert.ok(incompleteReport.issues.includes('HTML5_ENTRY_INVALID'));
  assert.ok(incompleteReport.issues.includes('HTML5_GAME_JSON_MISSING'));
  assert.ok(incompleteReport.issues.includes('HTML5_LEVELS_MISSING'));
});
