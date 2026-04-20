#!/usr/bin/env node

/**
 * @fileoverview
 * Multi-user sync test with diagnostic output.
 * 
 * Spawns multiple bots, has them draw concurrently, then collects
 * and compares canvas state from all users via Puppeteer.
 */

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const HEADLESS = process.env.HEADLESS !== 'false';
const NUM_USERS = 3;
const ROOM = `diagnostic_sync_${Date.now()}`;

class DiagnosticSyncTest {
  constructor() {
    this.bots = [];
    this.strokes = [
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
      
      // Compute canvas hash
      let hash = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        hash = ((hash << 5) - hash) + pixels[i] + pixels[i + 1] + pixels[i + 2] + pixels[i + 3];
        hash |= 0;
      }

      // Get layer/stroke count
      const lm = app.board.layerManager;
      let totalStrokes = 0;
      const strokesByUser = {};
      
      lm.layerGroups.forEach((group) => {
        group.strokeStack.forEach((stroke) => {
          totalStrokes++;
          const userId = stroke.userId;
          if (!strokesByUser[userId]) {
            strokesByUser[userId] = 0;
          }
          strokesByUser[userId]++;
        });
      });

      return {
        hash,
        layerCount: totalStrokes,
        strokesByUser
      };
    });
  }

  async queryCanvasStatesFromServer() {
    try {
      const response = await fetch(`${API_URL}/api/diagnostic/room/${ROOM}/canvas-states?timeout=10000`);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      return await response.json();
    } catch (err) {
      console.error('[Diagnostic] Failed to query server:', err.message);
      return null;
    }
  }

  async run() {
    console.log(`🚀 Starting Server-Side Diagnostic Sync Test`);
    console.log(`👥 Users: ${NUM_USERS}`);
    console.log(`🏠 Room: ${ROOM}\n`);

    try {
      // Spawn all users
      console.log('👤 Spawning users...');
      for (let i = 0; i < NUM_USERS; i++) {
        const bot = await this.spawnBot(i);
        this.bots.push(bot);
      }
      console.log(`✅ All ${NUM_USERS} users connected\n`);

      await new Promise(r => setTimeout(r, 2000));

      // Each user draws strokes sequentially
      console.log(`📝 Drawing strokes:\n`);
      
      for (let userIdx = 0; userIdx < NUM_USERS; userIdx++) {
        const bot = this.bots[userIdx];
        console.log(`  ${bot.name}: Drawing...`);
        
        for (let strokeIdx = 0; strokeIdx < 3; strokeIdx++) {
          const stroke = this.strokes[strokeIdx];
          await this.drawStroke(bot, stroke);
        }
        
        console.log(`    ✅ 3 strokes drawn\n`);
        
        if (userIdx < NUM_USERS - 1) {
          await new Promise(r => setTimeout(r, 2000));
        }
      }

      // Query canvas state from each bot
      console.log(`📡 Collecting canvas state from all users...\n`);
      const states = [];
      
      for (const bot of this.bots) {
        const state = await this.getCanvasState(bot);
        states.push({
          username: bot.name,
          ...state
        });
      }

      // Display individual states
      console.log('📊 CANVAS STATES:\n');
      states.forEach((state, i) => {
        console.log(`  ${i + 1}. ${state.username}:`);
        console.log(`     Hash: ${state.hash}`);
        console.log(`     Strokes: ${state.layerCount}`);
        if (Object.keys(state.strokesByUser).length > 0) {
          console.log(`     Strokes by user: ${JSON.stringify(state.strokesByUser)}`);
        }
      });

      // Compare states
      console.log('\n🔍 COMPARISON:\n');
      
      const baselineHash = states[0].hash;
      const baselineCount = states[0].layerCount;
      
      const hashMatch = states.every(s => s.hash === baselineHash);
      const countMatch = states.every(s => s.layerCount === baselineCount);

      console.log(`  Baseline (${states[0].username}):`);
      console.log(`    Hash: ${baselineHash}`);
      console.log(`    Strokes: ${baselineCount}\n`);

      console.log(`  Canvas Hashes Match: ${hashMatch ? '✅' : '❌'}`);
      if (!hashMatch) {
        states.forEach((s, i) => {
          if (s.hash !== baselineHash) {
            console.log(`    ${i + 1}. ${s.username}: ${s.hash} (DIVERGENT)`);
          }
        });
      }

      console.log(`\n  Stroke Counts Match: ${countMatch ? '✅' : '❌'}`);
      if (!countMatch) {
        states.forEach((s, i) => {
          if (s.layerCount !== baselineCount) {
            console.log(`    ${i + 1}. ${s.username}: ${s.layerCount} (expected ${baselineCount})`);
          }
        });
      }

      const allPass = hashMatch && countMatch;

      if (allPass) {
        console.log(`\n✅ SUCCESS: All ${NUM_USERS} users have synchronized canvas!`);
      } else {
        console.log(`\n❌ FAILURE: Canvas divergence detected!`);
        for (const bot of this.bots) {
          await bot.page.screenshot({ path: `fail_diag_${bot.name}.png` });
          console.log(`  Screenshot: fail_diag_${bot.name}.png`);
        }
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
    } finally {
      for (const bot of this.bots) {
        try {
          await bot.browser.close();
        } catch (e) {}
      }
    }
  }
}

new DiagnosticSyncTest().run().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
