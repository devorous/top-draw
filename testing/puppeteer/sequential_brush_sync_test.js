#!/usr/bin/env node

/**
 * @fileoverview
 * Sequential multi-user sync test with 3 bots.
 * 
 * Users draw *sequentially* (User A finishes all strokes before User B starts)
 * to eliminate stroke ordering issues. If hashes still diverge, it's a real sync bug.
 */

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const HEADLESS = process.env.HEADLESS !== 'false';
const NUM_USERS = 3;
const STROKES_PER_USER = 5;
const ROOM = `sequential_brush_sync_${Date.now()}`;

class SequentialBrushSyncTest {
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
        app.selectTool('brush');
        app.handleColorInputChange(col);
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

    await new Promise(r => setTimeout(r, 300));
  }

  async getCanvasState(bot) {
    return await bot.page.evaluate(() => {
      const app = window.app;
      const canvas = app.board.mainCanvas;
      const ctx = canvas.getContext('2d');
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      
      let hash = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        hash = ((hash << 5) - hash) + pixels[i] + pixels[i + 1] + pixels[i + 2] + pixels[i + 3];
        hash |= 0;
      }

      const lm = app.board.layerManager;
      let totalStrokes = 0;
      lm.layerGroups.forEach((group) => {
        totalStrokes += group.strokeStack.length;
      });

      return { hash, totalStrokes };
    });
  }

  async run() {
    console.log(`🚀 Starting Sequential Multi-User Brush Sync Test`);
    console.log(`👥 Users: ${NUM_USERS}, Strokes per user: ${STROKES_PER_USER} (drawn sequentially)\n`);
    console.log(`🏠 Room: ${ROOM}\n`);

    try {
      // Spawn all users
      console.log('👤 Spawning users...');
      for (let i = 0; i < NUM_USERS; i++) {
        const bot = await this.spawnBot(i);
        this.bots.push(bot);
      }
      console.log(`✅ All ${NUM_USERS} users connected and synced\n`);

      await new Promise(r => setTimeout(r, 2000));

      // Each user draws strokes SEQUENTIALLY
      console.log(`📝 Users drawing ${STROKES_PER_USER} strokes each (one at a time):\n`);
      
      for (let userIdx = 0; userIdx < NUM_USERS; userIdx++) {
        const bot = this.bots[userIdx];
        console.log(`  ${bot.name}: Drawing strokes...`);
        
        for (let strokeIdx = 0; strokeIdx < STROKES_PER_USER; strokeIdx++) {
          const stroke = this.strokeDefinitions[strokeIdx];
          await this.drawStroke(bot, stroke);
        }
        
        console.log(`    ✅ ${STROKES_PER_USER} strokes drawn\n`);
        
        // Wait for full propagation before next user starts
        if (userIdx < NUM_USERS - 1) {
          console.log(`  ⏳ Waiting for propagation before next user...\n`);
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      console.log(`⏳ Final propagation wait (5 seconds)...\n`);
      await new Promise(r => setTimeout(r, 5000));

      // Collect state from all users
      console.log('📊 FINAL STATE:\n');
      const states = [];
      
      for (const bot of this.bots) {
        const state = await this.getCanvasState(bot);
        states.push({ bot: bot.name, ...state });
        console.log(`  ${bot.name}: Hash=${state.hash}, Strokes=${state.totalStrokes}`);
      }

      // Verify all match
      console.log('\n🔍 Comparison:\n');
      const allHashesMatch = states.every(s => s.hash === states[0].hash);
      const allStrokesMatch = states.every(s => s.totalStrokes === states[0].totalStrokes);

      console.log(`  Canvas Hashes Match: ${allHashesMatch ? '✅' : '❌'}`);
      console.log(`  Stroke Counts Match: ${allStrokesMatch ? '✅' : '❌'}`);

      const allPass = allHashesMatch && allStrokesMatch;

      if (allPass) {
        console.log(`\n✅ SUCCESS: Sequential drawing fully synced across all users!`);
      } else {
        console.log(`\n❌ FAILURE: Sync divergence detected!`);
        for (const bot of this.bots) {
          await bot.page.screenshot({ path: `fail_seq_sync_${bot.name}.png` });
          console.log(`  Screenshot: fail_seq_sync_${bot.name}.png`);
        }
      }

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

new SequentialBrushSyncTest().run().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
