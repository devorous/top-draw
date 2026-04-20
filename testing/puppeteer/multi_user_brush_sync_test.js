#!/usr/bin/env node

/**
 * @fileoverview
 * Multi-user tool sync test with 3 concurrent bots.
 * 
 * Each user:
 * 1. Selects brush tool
 * 2. Draws 5 strokes with varying colors and sizes
 * 3. Waits for propagation
 * 
 * Then all users compare:
 * - Canvas hash (pixel-by-pixel equality)
 * - Layer count (same number of strokes applied)
 * - Stroke metadata (optional: detailed comparison)
 */

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const HEADLESS = process.env.HEADLESS !== 'false';
const NUM_USERS = 3;
const STROKES_PER_USER = 5;
const ROOM = `multi_user_brush_sync_${Date.now()}`;

class MultiUserBrushSyncTest {
  constructor() {
    this.bots = [];
    this.strokeDefinitions = [
      { x1: 100, y1: 100, x2: 300, y2: 300, color: [255, 0, 0, 1], size: 10 },
      { x1: 300, y1: 100, x2: 100, y2: 300, color: [0, 255, 0, 1], size: 15 },
      { x1: 150, y1: 50, x2: 150, y2: 400, color: [0, 0, 255, 1], size: 8 },
      { x1: 50, y1: 200, x2: 400, y2: 200, color: [255, 255, 0, 1], size: 12 },
      { x1: 200, y1: 150, x2: 250, y2: 350, color: [255, 0, 255, 1], size: 20 }
    ];
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
      if (txt.includes('[Sync]')) {
        console.log(`[${name}] ${txt}`);
      }
    });

    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(
      () => window.app !== undefined && window.app.self !== undefined && window.app.self !== null,
      { timeout: 60000 }
    );

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

  async drawStroke(bot, stroke) {
    const { x1, y1, x2, y2, color, size } = stroke;
    
    await bot.page.evaluate(
      async (sx1, sy1, sx2, sy2, col, sz) => {
        const app = window.app;
        
        // Select brush tool
        app.selectTool('brush');
        
        // Set color
        app.handleColorInputChange(col);
        
        // Set size
        app.handleSizeChange({ target: { value: sz } });

        const mockEv = (x, y) => ({
          button: 0,
          pointerType: 'mouse',
          offsetX: x,
          offsetY: y,
          clientX: x,
          clientY: y,
          preventDefault: () => {}
        });

        // Draw stroke
        app.handlePointerDown(mockEv(sx1, sy1));
        app.inputBufferManager.tick();

        const steps = 20;
        for (let j = 1; j <= steps; j++) {
          const t = j / steps;
          const curX = sx1 + (sx2 - sx1) * t;
          const curY = sy1 + (sy2 - sy1) * t;
          app.handlePointerMove(mockEv(curX, curY));
          app.inputBufferManager.tick();
          await new Promise(r => setTimeout(r, 8));
        }

        app.handlePointerUp(mockEv(sx2, sy2));
        app.inputBufferManager.tick();
      },
      x1,
      y1,
      x2,
      y2,
      color,
      size
    );

    // Small delay between strokes
    await new Promise(r => setTimeout(r, 300));
  }

  async getCanvasState(bot) {
    return await bot.page.evaluate(() => {
      const app = window.app;
      const canvas = app.board.mainCanvas;
      const ctx = canvas.getContext('2d');
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      
      // Compute canvas hash
      let hash = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        hash = ((hash << 5) - hash) + pixels[i] + pixels[i + 1] + pixels[i + 2] + pixels[i + 3];
        hash |= 0;
      }

      // Get layer/stroke count
      const lm = app.board.layerManager;
      let totalStrokes = 0;
      const layerCounts = [];
      
      lm.layerGroups.forEach((group, groupIdx) => {
        const groupStrokeCount = group.strokeStack.length;
        totalStrokes += groupStrokeCount;
        layerCounts.push({ groupIdx, count: groupStrokeCount });
      });

      return {
        hash,
        totalStrokes,
        layerCounts,
        layerGroupCount: lm.layerGroups.size
      };
    });
  }

  async run() {
    console.log(`🚀 Starting Multi-User Brush Sync Test`);
    console.log(`👥 Users: ${NUM_USERS}, Strokes per user: ${STROKES_PER_USER}`);
    console.log(`🏠 Room: ${ROOM}\n`);

    try {
      // Spawn all users
      console.log('👤 Spawning users...');
      for (let i = 0; i < NUM_USERS; i++) {
        const bot = await this.spawnBot(i);
        this.bots.push(bot);
      }
      console.log(`✅ All ${NUM_USERS} users connected and synced\n`);

      // Wait for all users to see each other
      await new Promise(r => setTimeout(r, 2000));

      // Each user draws strokes
      console.log(`📝 Each user drawing ${STROKES_PER_USER} strokes...\n`);
      for (let userIdx = 0; userIdx < NUM_USERS; userIdx++) {
        const bot = this.bots[userIdx];
        console.log(`  ${bot.name}: Drawing strokes...`);
        
        for (let strokeIdx = 0; strokeIdx < STROKES_PER_USER; strokeIdx++) {
          const stroke = this.strokeDefinitions[strokeIdx % this.strokeDefinitions.length];
          await this.drawStroke(bot, stroke);
        }
        
        console.log(`    ✅ ${STROKES_PER_USER} strokes drawn`);
      }

      console.log(`\n⏳ Waiting for full propagation (5 seconds)...`);
      await new Promise(r => setTimeout(r, 5000));

      // Collect state from all users
      console.log('\n📊 SYNC VERIFICATION:\n');
      const states = [];
      
      for (const bot of this.bots) {
        const state = await this.getCanvasState(bot);
        states.push({ bot: bot.name, ...state });
        
        console.log(`  ${bot.name}:`);
        console.log(`    Canvas Hash: ${state.hash}`);
        console.log(`    Total Strokes: ${state.totalStrokes}`);
        console.log(`    Layer Groups: ${state.layerGroupCount}`);
        console.log(`    Layer Details: ${state.layerCounts.map(lc => `G${lc.groupIdx}=${lc.count}`).join(', ')}`);
      }

      // Verify all match
      console.log('\n🔍 Comparison:\n');
      const allHashesMatch = states.every(s => s.hash === states[0].hash);
      const allStrokesMatch = states.every(s => s.totalStrokes === states[0].totalStrokes);
      const allGroupsMatch = states.every(s => s.layerGroupCount === states[0].layerGroupCount);

      console.log(`  Canvas Hashes Match: ${allHashesMatch ? '✅' : '❌'}`);
      if (!allHashesMatch) {
        states.forEach(s => {
          console.log(`    ${s.bot}: ${s.hash}`);
        });
      }

      console.log(`  Stroke Counts Match: ${allStrokesMatch ? '✅' : '❌'}`);
      if (!allStrokesMatch) {
        states.forEach(s => {
          console.log(`    ${s.bot}: ${s.totalStrokes}`);
        });
      }

      console.log(`  Layer Group Counts Match: ${allGroupsMatch ? '✅' : '❌'}`);
      if (!allGroupsMatch) {
        states.forEach(s => {
          console.log(`    ${s.bot}: ${s.layerGroupCount}`);
        });
      }

      const allPass = allHashesMatch && allStrokesMatch && allGroupsMatch;

      if (allPass) {
        console.log(`\n✅ SUCCESS: All ${NUM_USERS} users have perfectly synchronized state!`);
      } else {
        console.log(`\n❌ FAILURE: Sync divergence detected!`);
        
        // Take screenshots for debugging
        for (const bot of this.bots) {
          await bot.page.screenshot({ path: `fail_multi_sync_${bot.name}.png` });
          console.log(`  Screenshot: fail_multi_sync_${bot.name}.png`);
        }
      }

      // Cleanup
      for (const bot of this.bots) {
        await bot.browser.close();
      }

      process.exit(allPass ? 0 : 1);
    } catch (err) {
      console.error('❌ Test error:', err);
      for (const bot of this.bots) {
        try {
          await bot.browser.close();
        } catch (e) {}
      }
      process.exit(1);
    }
  }
}

new MultiUserBrushSyncTest().run().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
