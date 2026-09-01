import puppeteer from 'puppeteer';
const b = await puppeteer.connect({ browserURL: process.env.CDP_URL, defaultViewport: null });
const p = (await b.pages())[0];
console.log(await p.evaluate(() => ({
  detection: window.__performanceDetection,
  pref: window.app.appPreferences?.general?.lowPowerMode,
  isActive: window.app.isLowPowerModeActive?.(),
  tickRate: window.app.inputBufferManager?.tickRate,
  lowPowerModeFlag: window.app.inputBufferManager?.lowPowerMode,
  targetFPS: window.app.board?.targetFPS,
  hidden: document.hidden,
  dpr: window.devicePixelRatio,
  cores: navigator.hardwareConcurrency,
  mem: navigator.deviceMemory
})));
await b.disconnect();
