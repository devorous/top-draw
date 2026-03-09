#!/usr/bin/env node

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000';
const TOOL = process.env.TOOL || 'line';
const ROOM = `simple_${TOOL}_test_${Date.now()}`;
const HEADLESS = process.env.HEADLESS !== 'false';

class SimpleToolTest {
  constructor() {
    this.browser = null;
    this.bots = [];
    this.results = { match: false, hash: null };
  }

  async run() {
    console.log(`🚀 Starting Simple ${TOOL} Sync Test in room: ${ROOM}`);
    
    this.browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ['--no-sandbox'],
      defaultViewport: { width: 1280, height: 720 }
    });

    // 1. Spawn 3 bots (2 drawers, 1 observer)
    for (let i = 0; i < 3; i++) {
      const isObserver = i === 2;
      const name = isObserver ? `observer` : `drawer_${i}`;
      const page = await this.browser.newPage();
      
      page.on('console', msg => {
        const txt = msg.text();
        if (txt.includes('[WS]') || txt.includes('[USERS]') || txt.includes('[Test]')) {
          console.log(`[${name}] ${txt}`);
        }
      });
      
      console.log(`  Spawning ${name}...`);
      await page.goto(`${TARGET_URL}?room=${ROOM}`, { waitUntil: 'networkidle2' });
      
      // Wait for App to be ready
      await page.waitForFunction(() => window.app !== undefined, { timeout: 15000 });

      // Join room and set name
      await page.evaluate((n, r) => {
        window.app.self.username = n;
        window.app.handleRoomSelected(r);
      }, name, ROOM);

      // Wait for sync to complete (or for being the only user)
      await page.waitForFunction(() => {
        return window.app.syncClient.hasCompletedSync || 
               (window.app.wsClient.connected && window.app.users.size <= 1);
      }, { timeout: 30000 });
      
      console.log(`  ✓ ${name} joined and ready`);
      this.bots.push({ page, name, isObserver });
    }

    // 1.5 Wait for all bots to see each other
    console.log('\n👥 Waiting for all bots to see each other...');
    const expectedTotal = 3;
    for (const bot of this.bots) {
      console.log(`  Waiting for ${bot.name} to see everyone (target >= ${expectedTotal})...`);
      try {
        await bot.page.waitForFunction((total) => {
          return window.app.users.size >= total;
        }, { timeout: 20000 }, expectedTotal);
      } catch (err) {
        const currentSize = await bot.page.evaluate(() => window.app.users.size);
        console.error(`  ❌ ${bot.name} timed out! Current size: ${currentSize}`);
      }
      
      const userList = await bot.page.evaluate(() => {
        return Array.from(window.app.users.values()).map(u => `${u.username}(${u.id})`);
      });
      console.log(`  ✓ ${bot.name} sees: ${userList.join(', ')}`);
    }

    // 2. Clear board initially
    console.log('\n🧹 Clearing board...');
    await this.bots[0].page.evaluate(() => window.app.handleClear());
    await new Promise(r => setTimeout(r, 1000));

    // 2.5 Pre-draw background if testing a blur tool
    if (TOOL.includes('Blur') || TOOL === 'blur') {
      console.log('🎨 Pre-drawing background for blur testing...');
      await this.bots[0].page.evaluate(() => {
        const app = window.app;
        app.selectTool('brush');
        app.handleColorInputChange([0, 0, 0, 1]); // Black background
        app.handleSizeChange({ target: { value: 50 } });

        const mockEv = (x, y) => ({
          button: 0, pointerType: 'mouse',
          offsetX: x, offsetY: y, clientX: x, clientY: y,
          preventDefault: () => {}
        });

        app.handlePointerDown(mockEv(100, 100));
        app.handlePointerMove(mockEv(800, 600));
        app.handlePointerUp(mockEv(800, 600));
        app.inputBufferManager.tick();
        app.board.compositeAllLayers();
      });
      await new Promise(r => setTimeout(r, 2000));
    }

    // 3. Draw strokes (Simultaneous)
    console.log(`✍️ Drawing with ${TOOL} (Simultaneous)...`);
    const strokesPerBot = [
      [
        { start: { x: 100, y: 100 }, end: { x: 300, y: 300 }, color: [255, 0, 0, 0.5], size: 5, smoothing: 0 },
        { start: { x: 100, y: 300 }, end: { x: 300, y: 100 }, color: [0, 0, 255, 0.8], size: 10, smoothing: 10 },
        { start: { x: 200, y: 100 }, end: { x: 200, y: 300 }, color: [255, 255, 0, 1.0], size: 15, smoothing: 20 }
      ],
      [
        { start: { x: 500, y: 100 }, end: { x: 700, y: 300 }, color: [0, 255, 0, 0.5], size: 5, smoothing: 5 },
        { start: { x: 500, y: 300 }, end: { x: 700, y: 100 }, color: [255, 0, 255, 0.8], size: 10, smoothing: 15 },
        { start: { x: 600, y: 100 }, end: { x: 600, y: 300 }, color: [0, 255, 255, 1.0], size: 15, smoothing: 25 }
      ]
    ];

    const drawPromises = [];
    for (let i = 0; i < 2; i++) {
      const bot = this.bots[i];
      const botStrokes = strokesPerBot[i];
      
      const p = (async () => {
        for (const stroke of botStrokes) {
          await bot.page.evaluate(async (s, toolName) => {
            const app = window.app;
            app.selectTool(toolName);
            app.handleColorInputChange(s.color);
            app.handleSizeChange({ target: { value: s.size } });
            
            if (s.smoothing !== undefined && app.handleSmoothingChange) {
              app.handleSmoothingChange({ target: { value: s.smoothing } });
            }

            if (toolName === 'imageBrush' && app.brushGallery) {
              let attempts = 0;
              while ((!app.brushGallery.brushes || app.brushGallery.brushes.length === 0) && attempts < 50) {
                await new Promise(r => setTimeout(r, 100));
                attempts++;
              }
              const brushItems = document.querySelectorAll('.brushItem');
              if (brushItems.length > 0) brushItems[0].click();
            }

            const mockEv = (x, y) => ({
              button: 0, pointerType: 'mouse',
              offsetX: x, offsetY: y, clientX: x, clientY: y,
              preventDefault: () => {}
            });

            app.handlePointerDown(mockEv(s.start.x, s.start.y));
            app.inputBufferManager.tick();

            const isShape = ['line', 'rectangle', 'circle'].includes(toolName);
            const steps = isShape ? 1 : 5;
            for (let j = 1; j <= steps; j++) {
              const t = j / steps;
              app.handlePointerMove(mockEv(s.start.x + (s.end.x - s.start.x) * t, s.start.y + (s.end.y - s.start.y) * t));
              app.inputBufferManager.tick();
            }

            app.handlePointerUp(mockEv(s.end.x, s.end.y));
            app.inputBufferManager.tick();
          }, stroke, TOOL);
          
          console.log(`  ✓ ${bot.name} finished a stroke`);
          await new Promise(r => setTimeout(r, 100)); // Short gap
        }
      })();
      drawPromises.push(p);
    }

    await Promise.all(drawPromises);

    // 4. Wait for propagation and force final composite
    console.log('⏳ Waiting for propagation and forcing final composite...');
    await new Promise(r => setTimeout(r, 3000));
    
    for (const bot of this.bots) {
      await bot.page.evaluate(() => {
        if (window.app.wsClient._processMessageQueue) window.app.wsClient._processMessageQueue();
        if (window.app.inputBufferManager.tick) window.app.inputBufferManager.tick();
        window.app.board.compositeAllLayers();
      });
    }

    // 5. Compare Hashes
    console.log('\n📊 Comparing Canvas Hashes:');
    const hashes = [];
    for (const bot of this.bots) {
      const result = await bot.page.evaluate(() => {
        const canvas = window.app.board.mainCanvas;
        const ctx = canvas.getContext('2d');
        const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
        
        let h = 0;
        let drawnPixels = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] !== 255 || pixels[i+1] !== 255 || pixels[i+2] !== 255) {
            drawnPixels++;
          }
          h = ((h << 5) - h) + pixels[i] + pixels[i+1] + pixels[i+2] + pixels[i+3];
          h |= 0;
        }
        return { hash: h, drawnPixels };
      });
      console.log(`  ${bot.name}: Hash=${result.hash}, DrawnPixels=${result.drawnPixels}`);
      hashes.push(result.hash);
    }

    const allMatch = hashes.every(h => h === hashes[0] && h !== 0);
    if (allMatch) {
      console.log(`\n✅ SUCCESS: All canvases match perfectly for ${TOOL}!`);
    } else {
      console.log(`\n❌ FAILURE: Canvas hashes differ for ${TOOL}!`);
    }

    await this.browser.close();
    process.exit(allMatch ? 0 : 1);
  }
}

new SimpleToolTest().run().catch(err => {
  console.error(err);
  process.exit(1);
});
