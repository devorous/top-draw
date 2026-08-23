/** Inspect the already-open tabs on the tunnelled Chromebook Chrome. */
import puppeteer from 'puppeteer';

const browser = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9222', defaultViewport: null });
for (const page of await browser.pages()) {
  const url = page.url();
  if (!url.startsWith('http')) { console.log('skip', url); continue; }
  const s = await page.evaluate(() => ({
    ready: document.readyState,
    hasApp: typeof window.app !== 'undefined',
    ws: window.app?.wsClient?.connected ?? null,
    session: window.app?.sessionIndex ?? null,
    bodyText: document.body.innerText.replace(/\s+/g, ' ').slice(0, 180),
    perf: {
      resources: performance.getEntriesByType('resource').length,
      domContentLoaded: Math.round(performance.timing.domContentLoadedEventEnd - performance.timing.navigationStart),
      loadEvent: performance.timing.loadEventEnd
        ? Math.round(performance.timing.loadEventEnd - performance.timing.navigationStart)
        : 'not fired yet',
    },
    pending: performance.getEntriesByType('resource').filter((r) => r.responseEnd === 0).length,
  })).catch((e) => ({ err: String(e) }));
  console.log(url, '\n', JSON.stringify(s, null, 2));
}
await browser.disconnect();
