import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const room = `diag_${Date.now()}`;
const bots = [];
for (let i = 0; i < 2; i++) {
  const page = await browser.newPage();
  await page.evaluateOnNewDocument(() => {
    let s = 12345;
    Math.random = () => { s = (s*9301+49297)%233280; return s/233280; };
    const d = new Date('2026-05-05T12:00:00Z').getTime();
    Date.now = () => d;
  });
  await page.goto('http://localhost:3000/go/', { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.app?.self != null, { timeout: 30000 });
  await page.evaluate((n, r) => {
    window.app.self.username = n;
    window.app.handleRoomSelected(r);
  }, `bot_${i}`, room);
  await page.waitForFunction(() => window.app?.wsClient?.connected && (window.app?.syncClient?.hasCompletedSync || window.app?.users?.size <= 1), { timeout: 30000 });
  await page.evaluate(() => window.app.inputBufferManager?.stopTickLoop?.());
  bots.push({ name: `bot_${i}`, page });
}

const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  const sz = await Promise.all(bots.map(b => b.page.evaluate(() => window.app.users.size)));
  if (sz.every(s => s >= 2)) break;
  await new Promise(r => setTimeout(r, 250));
}

const dump = async (label) => {
  const out = await Promise.all(bots.map(b => b.page.evaluate(() => ({
    selfHardness: window.app.self.hardness,
    selfSize: window.app.self.size,
    selfOpacity: window.app.self.opacity,
    selfTool: window.app.self.tool,
    users: Array.from(window.app.users.values()).map(u => ({
      name: u.username, hardness: u.hardness, size: u.size, opacity: u.opacity, tool: u.tool,
    })),
  }))));
  console.log(`\n--- ${label} ---`);
  out.forEach((o, i) => console.log(`bot_${i}: self h=${o.selfHardness} s=${o.selfSize} o=${o.selfOpacity} t=${o.selfTool}\n   remotes: ${JSON.stringify(o.users)}`));
};

const flushDrawer = async () => {
  await bots[0].page.evaluate(() => window.app.inputBufferManager?.tick?.());
  await new Promise(r => setTimeout(r, 600));
};

const TESTS = [
  { tool: 'brush', settings: { size: 30, color: [0, 255, 0, 0.7], hardness: 50 } },
  { tool: 'brush', settings: { size: 60, color: [0, 0, 255, 0.4], hardness: 10 } },
  { tool: 'brush', settings: { size: 20, color: [255, 0, 255, 0.6], hardness: 30 } },
  { tool: 'line',  settings: { size: 2,  color: [0, 0, 0, 1] } },
  { tool: 'line',  settings: { size: 10, color: [0, 255, 0, 0.6] } },
  { tool: 'line',  settings: { size: 4,  color: [0, 0, 255, 1] } },
];

for (const [i, t] of TESTS.entries()) {
  await bots[0].page.evaluate((tool, s) => {
    const app = window.app;
    app.selectTool(tool);
    if (s.size !== undefined) app.handleSizeChange({ target: { value: s.size } });
    if (s.color !== undefined) app.handleColorInputChange(s.color);
    if (s.hardness !== undefined) app.handleHardnessChange({ target: { value: s.hardness } });
  }, t.tool, t.settings);
  await flushDrawer();
  await dump(`Step ${i+1}: ${t.tool} ${JSON.stringify(t.settings)}`);
}

await browser.close();
