#!/usr/bin/env node

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/top-draw/';
const TOOL = process.env.TOOL || 'brush';
const ROOM = `single_stroke_sync_${TOOL}_${Date.now()}`;
const HEADLESS = process.env.HEADLESS !== 'false';
const NUM_BOTS = 2;

class SingleStrokeSyncTest {
  constructor() {
    this.bots = [];
  }

  async spawnBot(i) {
    const name = `user_${i}`;
    console.log(`  Spawning ${name}...`);
    
    const browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1280, height: 720 }
    });
    
    const page = await browser.newPage();
    
    page.on('console', msg => {
      const txt = msg.text();
      if (txt.includes('[SYNC]')) {
        console.log(`[${name}] ${txt}`);
      }
    });

    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app !== undefined, { timeout: 60000 });

    await page.evaluate((n, r) => {
      window.app.self.username = n;
      window.app.handleRoomSelected(r);
    }, name, ROOM);

    await page.waitForFunction(() => {
      return window.app?.wsClient?.connected && 
             window.app?.syncClient?.hasCompletedSync === true;
    }, { timeout: 60000 });

    return { name, browser, page };
  }

  async run() {
    console.log(`🚀 Starting Single-Stroke Multi-User Sync Test [Bots: ${NUM_BOTS}, Tool: ${TOOL}]`);
    console.log(`🏠 Room: ${ROOM}`);
    
    try {
      for (let i = 0; i < NUM_BOTS; i++) {
        this.bots.push(await this.spawnBot(i));
      }
    } catch (err) {
      console.error('Failed to spawn bots:', err);
      process.exit(1);
    }

    console.log('👥 Waiting for all bots to see each other...');
    for (const bot of this.bots) {
      await bot.page.waitForFunction((n) => window.app.users.size >= n, { timeout: 10000 }, NUM_BOTS);
    }

    console.log('🧹 Clearing board...');
    await this.bots[0].page.evaluate(() => window.app.handleClear());
    await new Promise(r => setTimeout(r, 1000));

    // Define colors
    const colors = [
      [255, 0, 0, 1], // Red
      [0, 255, 0, 1], // Green
      [0, 0, 255, 1], // Blue
    ];

    // Fixed coordinates for 1 stroke each
    const strokes = [
      { start: { x: 200, y: 200 }, end: { x: 400, y: 400 } },
      { start: { x: 400, y: 200 }, end: { x: 200, y: 400 } },
      { start: { x: 300, y: 150 }, end: { x: 300, y: 450 } }
    ];

    console.log(`✍️ Drawing 3 total strokes...`);
    for (let b = 0; b < NUM_BOTS; b++) {
      const stroke = strokes[b];
      const bot = this.bots[b];
      
      console.log(`  ${bot.name} drawing...`);
      await bot.page.evaluate(async (st, toolName, color) => {
        const app = window.app;
        app.selectTool(toolName);
        app.handleColorInputChange(color);
        app.handleSizeChange({ target: { value: 10 } });
        
        if (toolName === 'imageBrush' && !app.self.imageBrush) {
          const mockDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
          const brushData = { type: 'image', fileName: 'mock.png', gimpUrl: mockDataUrl, brushName: 'mock', width: 1, height: 1 };
          const img = new Image();
          await new Promise(res => { img.onload = res; img.src = brushData.gimpUrl; });
          brushData.image = img;
          app.handleBrushSelect(brushData);
        }

        const mockEvInner = (x, y) => ({
          button: 0, pointerType: 'mouse',
          offsetX: x, offsetY: y, clientX: x, clientY: y,
          preventDefault: () => {}
        });

        app.handlePointerDown(mockEvInner(st.start.x, st.start.y));
        app.inputBufferManager.tick();

        const steps = 10;
        for (let j = 1; j <= steps; j++) {
          const t = j / steps;
          const curX = st.start.x + (st.end.x - st.start.x) * t;
          const curY = st.start.y + (st.end.y - st.start.y) * t;
          app.handlePointerMove(mockEvInner(curX, curY));
          app.inputBufferManager.tick();
          await new Promise(r => setTimeout(r, 20));
        }

        app.handlePointerUp(mockEvInner(st.end.x, st.end.y));
        app.inputBufferManager.tick();
      }, stroke, TOOL, colors[b]);
      
      await new Promise(r => setTimeout(r, 1000));
    }

    console.log('⏳ Waiting for final propagation...');
    await new Promise(r => setTimeout(r, 5000));
    
    console.log('\n📊 FINAL COMPARISON:');
    const results = [];
    for (const bot of this.bots) {
      const data = await bot.page.evaluate(() => {
        const lm = window.app.board.layerManager;
        // Collect detailed stroke metadata
        const strokes = [];
        lm.layerGroups.forEach((g, gIdx) => {
          g.strokeStack.forEach((s, sIdx) => {
            strokes.push({
              layer: gIdx,
              index: sIdx,
              userId: s.userId,
              blendMode: s.blendMode,
              bounds: { x: s.x, y: s.y, w: s.width, h: s.height },
              timestamp: s.timestamp
            });
          });
        });

        const canvas = window.app.board.mainCanvas;
        const ctx = canvas.getContext('2d');
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        
        let h = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          h = ((h << 5) - h) + pixels[i] + pixels[i+1] + pixels[i+2] + pixels[i+3];
          h |= 0;
        }
        return { name: window.app.self.username, totalStrokes: strokes.length, hash: h, strokes };
      });
      results.push(data);
    }

    for (const r of results) {
      console.log(`  ${r.name}: Strokes=${r.totalStrokes}, Hash=${r.hash}`);
      r.strokes.forEach((s, i) => {
        console.log(`    [${i}] Layer ${s.layer} | User ${s.userId} | ${s.blendMode} | Bounds: (${s.bounds.x}, ${s.bounds.y}, ${s.bounds.w}, ${s.bounds.h})`);
      });
    }

    const strokesMatch = results.every(r => r.totalStrokes === results[0].totalStrokes);
    const hashesMatch = results.every(r => r.hash === results[0].hash);

    if (strokesMatch && hashesMatch) {
      console.log('  ✅ SUCCESS: All clients match perfectly!');
    } else {
      console.log('  ❌ FAILURE: Rendering discrepancies detected!');
      for (const bot of this.bots) {
        await bot.page.screenshot({ path: `fail_${TOOL}_${bot.name}.png` });
      }
    }

    for (const bot of this.bots) {
      await bot.browser.close();
    }
    process.exit((strokesMatch && hashesMatch) ? 0 : 1);
  }
}

new SingleStrokeSyncTest().run().catch(err => {
  console.error(err);
  process.exit(1);
});
