import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
const room = `diag2_${Date.now()}`;
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
    selfH: window.app.self.hardness, selfS: window.app.self.size, selfT: window.app.self.tool,
    selfO: window.app.self.opacity, selfC: window.app.self.color,
    others: Array.from(window.app.users.values()).filter(u => u.id !== window.app.self.id).map(u =>
      ({ n: u.username, h: u.hardness, s: u.size, t: u.tool, o: u.opacity, c: u.color }))
  }))));
  console.log(`--- ${label} ---`);
  out.forEach((o, i) => {
    console.log(`bot_${i}: self h=${o.selfH} s=${o.selfS} t=${o.selfT} o=${o.selfO} c=${JSON.stringify(o.selfC)}`);
    o.others.forEach(r => console.log(`   sees ${r.n}: h=${r.h} s=${r.s} t=${r.t} o=${r.o} c=${JSON.stringify(r.c)}`));
  });
};

const SETS = [
  { tool: 'brush', s: { size: 15, color: [255, 0, 0, 1], hardness: 100 } },
  { tool: 'brush', s: { size: 30, color: [0, 255, 0, 0.7], hardness: 50 } },
  { tool: 'brush', s: { size: 60, color: [0, 0, 255, 0.4], hardness: 10 } },
  { tool: 'brush', s: { size: 10, color: [0, 0, 0, 1], hardness: 90 } },
  { tool: 'brush', s: { size: 20, color: [255, 0, 255, 0.6], hardness: 30 } },
  { tool: 'line',  s: { size: 2, color: [0, 0, 0, 1] } },
  { tool: 'line',  s: { size: 6, color: [255, 0, 0, 0.8] } },
  { tool: 'line',  s: { size: 10, color: [0, 255, 0, 0.6] } },
  { tool: 'line',  s: { size: 4, color: [0, 0, 255, 1] } },  // line_step_4
];

for (const [i, t] of SETS.entries()) {
  await bots[0].page.evaluate((tool, s) => {
    const app = window.app;
    app.selectTool(tool);
    if (s.size !== undefined) app.handleSizeChange({ target: { value: s.size } });
    if (s.color !== undefined) app.handleColorInputChange(s.color);
    if (s.hardness !== undefined) app.handleHardnessChange({ target: { value: s.hardness } });
  }, t.tool, t.s);
  // Dump BEFORE drawing
  await bots[0].page.evaluate(() => window.app.inputBufferManager?.tick?.());
  await new Promise(r => setTimeout(r, 500));
  await dump(`PRE-DRAW step ${i+1}: ${t.tool} ${JSON.stringify(t.s)}`);
  // Simulate a quick draw
  await bots[0].page.evaluate(() => {
    const app = window.app;
    const ev = (cx,cy) => ({ button:0, pointerType:'mouse', clientX:cx, clientY:cy, preventDefault:()=>{} });
    app.handlePointerDown(ev(500, 500));
    app.inputBufferManager?.tick?.();
    app.handlePointerMove(ev(600, 600));
    app.inputBufferManager?.tick?.();
    app.handlePointerUp(ev(600, 600));
    app.inputBufferManager?.tick?.();
  });
  await new Promise(r => setTimeout(r, 700));
  await dump(`POST-DRAW step ${i+1}`);
  console.log('');
}

await browser.close();
