import {ORIGINAL_SWF_BYTES, ORIGINAL_SWF_SHA256, sha256Hex} from './original-file.mjs';

const SWF_HEADER_BYTES = 8;
const BOX_IMAGE_CHECK_OFFSET = 8;
// In Box.brickExp, this unique block starts at the image/parent guard's branch
// and ends at removeChild(image). The compressed original is pinned above.
const BOX_IMAGE_CHECK = Uint8Array.of(
  0x12, 0x34, 0x00, 0x00, 0xd0, 0x66, 0xff, 0x0a,
  0x2c, 0xc2, 0x0a, 0x46, 0xf3, 0x43, 0x01,
  0x12, 0x16, 0x00, 0x00, 0xd0, 0x66, 0xff, 0x0a,
  0x66, 0xf0, 0x43, 0xd0, 0x66, 0xff, 0x0a, 0x66, 0xf4, 0x43, 0x4f, 0xf5, 0x43, 0x01,
);
// `getlex flash.utils.Proxy; istypelate; nop; nop; nop`. The same type test is
// already used by Box.dispose. It preserves both branches and their offsets.
const PROXY_TYPE_CHECK = Uint8Array.of(0x60, 0xf3, 0x09, 0xb3, 0x02, 0x02, 0x02);

// UILoading.initDis starts the Art_Res.swf request. Its callback always unloads
// the response and constructs the embedded Art_Loading. If the root finishes
// first, destroy() returns early and the original A10 transition never fires.
const UILOADING_INIT = Uint8Array.of(
  0xd0, 0x30, 0x5d, 0xa4, 0x02, 0x4a, 0xa4, 0x02, 0x00, 0x80, 0xa4, 0x02,
  0xd5, 0xd1, 0x66, 0xd1, 0x40, 0x60, 0xf2, 0x01, 0x66, 0xd2, 0x40, 0xd0,
  0x66, 0xa7, 0x02, 0x4f, 0xc4, 0x02, 0x02,
);
const UILOADING_COMPLETE = Uint8Array.of(
  0xd0, 0x30, 0x5d, 0xa4, 0x02, 0xd1, 0x66, 0xd7, 0x40, 0x66, 0xd8, 0x40,
  0x46, 0xa4, 0x02, 0x01, 0x4f, 0xd9, 0x40, 0x00, 0x60, 0xb2, 0x02, 0x80, 0x30,
);
// Call the existing onLoadComplete(null) directly; skip its external loader
// cleanup. Both edits preserve method sizes, constant pool and branch offsets.
const SHOW_EMBEDDED_LOADER = Uint8Array.of(0xd0, 0x20, 0x4f, 0xa7, 0x02, 0x01, 0x47);
const SKIP_EXTERNAL_UNLOAD = new Uint8Array(18).fill(0x02); // AVM2 nop.

function patchUnique(movie, description, original, offset, replacement) {
  let match = -1;
  for (let index = movie.indexOf(original[0], SWF_HEADER_BYTES);
    index >= 0 && index + original.length <= movie.length;
    index = movie.indexOf(original[0], index + 1)) {
    if (!original.every((byte, i) => movie[index + i] === byte)) continue;
    if (match !== -1) throw new Error(`SWF 中有多处${description}兼容修复位置。`);
    match = index;
  }
  if (match === -1) throw new Error(`SWF 中未找到${description}兼容修复位置。`);
  movie.set(replacement, match + offset);
}

export async function prepareOriginalSwfForRuffle(bytes, {signal} = {}) {
  signal?.throwIfAborted();
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== ORIGINAL_SWF_BYTES
      || bytes[0] !== 0x43 || bytes[1] !== 0x57 || bytes[2] !== 0x53 || sha256Hex(bytes) !== ORIGINAL_SWF_SHA256) {
    throw new Error('兼容修复需要已校验的原版 SWF。');
  }

  const length = new DataView(bytes.buffer, bytes.byteOffset, SWF_HEADER_BYTES).getUint32(4, true);
  const movie = new Uint8Array(length);
  movie.set(bytes.subarray(0, SWF_HEADER_BYTES));
  movie[0] = 0x46; // FWS, the uncompressed form of the verified CWS input.
  const reader = new Blob([bytes.subarray(SWF_HEADER_BYTES)]).stream()
    .pipeThrough(new DecompressionStream('deflate')).getReader();
  let written = SWF_HEADER_BYTES;
  try {
    while (true) {
      signal?.throwIfAborted();
      const {done, value} = await reader.read();
      if (done) break;
      if (written + value.byteLength > length) throw new Error('解压后的 SWF 长度超出原版文件声明。');
      movie.set(value, written);
      written += value.byteLength;
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (written !== length) throw new Error('解压后的 SWF 长度与原版文件声明不符。');

  patchUnique(movie, '障碍物', BOX_IMAGE_CHECK, BOX_IMAGE_CHECK_OFFSET, PROXY_TYPE_CHECK);
  patchUnique(movie, '加载画面', UILOADING_INIT, 2, SHOW_EMBEDDED_LOADER);
  patchUnique(movie, '加载回调', UILOADING_COMPLETE, 2, SKIP_EXTERNAL_UNLOAD);
  return movie;
}
