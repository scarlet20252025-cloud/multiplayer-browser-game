import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {
  ORIGINAL_SWF_BYTES, ORIGINAL_SWF_SHA256, readOriginalSwf, sha256Hex,
} from '../experiments/bomb-it-netplay/original-file.mjs';

test('SHA-256 works without Web Crypto and handles padding and typed-array offsets', () => {
  const encoder = new TextEncoder();
  const vectors = [
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ];
  for (const [message, expected] of vectors) {
    assert.equal(sha256Hex(encoder.encode(message)), expected);
  }
  const backing = encoder.encode('x' + 'a'.repeat(140));
  for (const count of [55, 56, 63, 64, 65, 127, 128]) {
    const bytes = backing.subarray(1, count + 1);
    assert.equal(sha256Hex(bytes), createHash('sha256').update(bytes).digest('hex'));
  }
});

test('original-file gate rejects empty, wrong-size and same-size unpinned files', async () => {
  await assert.rejects(readOriginalSwf(), /请选择/);
  await assert.rejects(readOriginalSwf(new Blob(['CWS'])), /文件大小/);
  const bytes = new Uint8Array(ORIGINAL_SWF_BYTES);
  bytes.set(new TextEncoder().encode('CWS'));
  await assert.rejects(readOriginalSwf(new Blob([bytes])), /指纹/);
});

test('the pinned original is accepted byte-for-byte when available on this device', async t => {
  const source = new URL('../local/original-games/bomb-it/bomb-it-7.swf', import.meta.url);
  const data = await readFile(source).catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!data) return t.skip('Local publisher SWF is absent');

  assert.equal(createHash('sha256').update(data).digest('hex'), ORIGINAL_SWF_SHA256);
  const selected = await readOriginalSwf(new Blob([data]));
  assert.equal(selected.byteLength, ORIGINAL_SWF_BYTES);
  assert.equal(Buffer.compare(data, selected), 0);
});
