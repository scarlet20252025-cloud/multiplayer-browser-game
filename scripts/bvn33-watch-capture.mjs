const generation = Number(new URLSearchParams(location.search).get('g'));
const WIDTH = 384;
const HEIGHT = 288;
const BYTE_LIMIT = 32 * 1024;
const INTERVAL = 125;
let enabled = false;
let version = 0;
let lastFrame = -Infinity;
let busy = false;
let copy;
let context;

window.addEventListener('message', event => {
  const message = event.data;
  if (event.source !== parent || event.origin !== location.origin || message?.bvn !== true ||
      message.type !== 'watch-capture' || message.generation !== generation) return;
  enabled = message.active === true;
  version++;
});

// Run in the render task so the Ruffle WebGL buffer is still available.
export function captureGameFrame() {
  const now = performance.now();
  if (!enabled || busy || now - lastFrame < INTERVAL) return;
  const canvas = window.gamePlayer?.shadowRoot?.querySelector('canvas');
  if (!canvas?.width || !canvas.height) return;
  if (!copy) {
    copy = document.createElement('canvas');
    copy.width = WIDTH;
    copy.height = HEIGHT;
    context = copy.getContext('2d', {alpha: false});
  }
  if (!context) return;
  lastFrame = now;
  try {
    context.drawImage(canvas, 0, 0, WIDTH, HEIGHT);
    busy = true;
    const frameVersion = version;
    copy.toBlob(async blob => {
      try {
        if (!enabled || frameVersion !== version || blob?.type !== 'image/webp' || blob.size > BYTE_LIMIT) return;
        const bytes = await blob.arrayBuffer();
        if (enabled && frameVersion === version)
          parent.postMessage({bvn: true, generation, type: 'watch-capture-frame', bytes}, location.origin, [bytes]);
      } catch {
        // A failed frame can be skipped without interrupting the match.
      } finally { busy = false; }
    }, 'image/webp', .55);
  } catch { busy = false; }
}
