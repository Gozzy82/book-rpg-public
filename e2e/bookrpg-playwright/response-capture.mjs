// Keep game POST bodies outside Chromium's evictable inspector cache. Both
// submit() and network logging read the same captured, real server response.
export async function installGameResponseCapture(page, { origin, timeout, onError }) {
  const bodies = new WeakMap();
  await page.route(url => url.origin === origin
    && (url.pathname === '/api/games' || url.pathname.startsWith('/api/games/')), async route => {
    const request = route.request();
    if (request.method() !== 'POST') return route.continue();
    let response;
    try {
      // A turn mutates game state: never retry it to recover a missing body.
      // Leave redirects to the browser, just as with the original request.
      response = await route.fetch({ timeout, maxRetries: 0, maxRedirects: 0 });
      const body = await response.body();
      bodies.set(request, body.toString('utf8'));
      await route.fulfill({ response, body });
    } catch (error) {
      onError(error);
      await route.abort('failed').catch(() => {});
    } finally {
      await response?.dispose().catch(() => {});
    }
  });
  return async response => bodies.has(response.request())
    ? bodies.get(response.request())
    : response.text();
}
