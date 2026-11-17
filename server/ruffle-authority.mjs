import { chromium } from 'playwright';
import { BUILD_ID, PROTOCOL, validateSnapshot } from './protocol.mjs';

export async function launchAuthorityBrowser() {
  const configured = process.env.CHROMIUM_PATH;
  const executablePath = configured || undefined;
  return chromium.launch({
    headless: true,
    ...(executablePath ? {executablePath} : {}),
    args: ['--disable-dev-shm-usage', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
  });
}

/** Each room owns a context. No screenshot, canvas extraction, video or media track. */
export async function createRuffleAuthority(browser, baseUrl) {
  const context = await browser.newContext({viewport: {width: 680, height: 400}});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(`${baseUrl}/authority.html`, {waitUntil: 'load'});
    await page.waitForFunction(() => window.probeReady === true, null, {timeout: 30000});
    const hello = await page.evaluate(() => window.probeHello);
    if (hello.protocol !== PROTOCOL || hello.version !== BUILD_ID || hello.role !== 'authority') {
      throw new Error('Unexpected AS3 authority handshake');
    }
    let state = await page.evaluate(() => window.probeRead());
    if (!validateSnapshot(state)) throw new Error('Invalid AS3 initial snapshot');
    return {
      hello,
      errors,
      read: () => structuredClone(state),
      async step(inputs) {
        const next = await page.evaluate(values => window.probeStep(values), inputs);
        if (!validateSnapshot(next, state.tick)) throw new Error('Invalid or nonmonotonic AS3 snapshot');
        state = next;
        return structuredClone(state);
      },
      async close() { await context.close(); },
    };
  } catch (error) {
    await context.close();
    throw error;
  }
}
