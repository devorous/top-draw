/** Capture the weak client's board mid remote-stroke to check for tearing. */
import puppeteer from 'puppeteer';
const browser = await puppeteer.connect({ browserURL: process.env.CDP_URL || 'http://127.0.0.1:9222', defaultViewport: null });
const pages = await browser.pages();
const page = pages.find(p => p.url().includes('localhost:3000')) || pages[0];
await page.evaluate(() => { window.__oldBehavior = false; });
await new Promise(r => setTimeout(r, 2500));
const el = await page.$('#boardContainer');
await (el || page).screenshot({ path: process.env.OUT || 'testing/devtools/weak-new.png' });
console.log('saved', process.env.OUT || 'testing/devtools/weak-new.png');
await browser.disconnect();
