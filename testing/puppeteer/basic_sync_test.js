#!/usr/bin/env node

/**
 * @fileoverview
 * Basic integration test for verifying canvas sync between two users.
 * 
 * Scenario:
 * 1. User A joins and draws strokes
 * 2. User B joins immediately (triggering sequential sync)
 * 3. Verify both users see identical final canvas state
 * 
 * This is the baseline Puppeteer test before adding complex features like
 * snapshot history and region restore.
 */

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const HEADLESS = process.env.HEADLESS !== 'false';
const ROOM = `basic_sync_test_${Date.now()}`;

class BasicSyncTest {
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
      if (txt.includes('[Sync]')) {
        console.log(`[${name}] ${txt}`);
      }
    });

    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app !== undefined && window.app.self !== undefined && window.app.self !== null, { timeout: 60000 });

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

  async drawStroke(bot, x1, y1, x2, y2, color) {
    await bot.page.evaluate(async (startX, startY, endX, endY, col) => {
      const app = window.app;
      app.selectTool('brush');
      app.handleColorInputChange(col);
      app.handleSizeChange({ target: { value: 15 } });

      const mockEv = (x, y) => ({
        button: 0, pointerType: 'mouse',
        offsetX: x, offsetY: y, clientX: x, clientY: y,
        preventDefault: () => {}
      });

      app.handlePointerDown(mockEv(startX, startY));
      app.inputBufferManager.tick();

      const steps = 15;
      for (let j = 1; j <= steps; j++) {
        const t = j / steps;
        const curX = startX + (endX - startX) * t;
        const curY = startY + (endY - startY) * t;
        app.handlePointerMove(mockEv(curX, curY));
        app.inputBufferManager.tick();
        await new Promise(r => setTimeout(r, 10));
      }

      app.handlePointerUp(mockEv(endX, endY));
      app.inputBufferManager.tick();
    }, x1, y1, x2, y2, color);

    await new Promise(r => setTimeout(r, 500));
  }

  async getCanvasHash(bot) {
    return await bot.page.evaluate(() => {
      const canvas = window.app.board.mainCanvas;
      const ctx = canvas.getContext('2d');
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      
      let h = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        h = ((h << 5) - h) + pixels[i] + pixels[i+1] + pixels[i+2] + pixels[i+3];
        h |= 0;
      }
      return h;
    });
  }

  async run() {
    console.log(`🚀 Starting Basic Canvas Sync Test`);
    console.log(`🏠 Room: ${ROOM}\n`);
    
    try {
      // Spawn User A
      console.log('👤 User A: Connecting...');
      const userA = await this.spawnBot(0);
      this.bots.push(userA);
      console.log(`✅ User A ready\n`);

      // USER A: Draw strokes
      console.log('📝 User A: Drawing strokes...');
      await this.drawStroke(userA, 200, 150, 500, 400, [255, 0, 0, 1]); // Red diagonal
      await this.drawStroke(userA, 500, 150, 200, 400, [0, 255, 0, 1]); // Green diagonal
      await this.drawStroke(userA, 250, 300, 450, 300, [0, 0, 255, 1]); // Blue horizontal
      console.log(`✅ Strokes drawn\n`);

      // Wait for strokes to propagate
      await new Promise(r => setTimeout(r, 2000));

      // Get User A's hash
      const hashA = await this.getCanvasHash(userA);
      console.log(`📊 User A canvas hash: ${hashA}\n`);

      // USER B: Join immediately (triggering sequential sync)
      console.log('👤 User B: Joining room...');
      const userB = await this.spawnBot(1);
      this.bots.push(userB);
      console.log(`✅ User B joined and synced\n`);

      // Wait for sync to stabilize
      await new Promise(r => setTimeout(r, 3000));

      // FINAL COMPARISON
      console.log('📊 FINAL COMPARISON:');
      const hashB = await this.getCanvasHash(userB);
      console.log(`  User A canvas hash: ${hashA}`);
      console.log(`  User B canvas hash: ${hashB}`);

      const hashesMatch = hashA === hashB;

      if (hashesMatch) {
        console.log('\n✅ SUCCESS: Both users have identical canvas state!');
      } else {
        console.log('\n❌ FAILURE: Canvas state divergence detected!');
        
        // Take screenshots for debugging
        for (const bot of this.bots) {
          await bot.page.screenshot({ path: `fail_sync_${bot.name}.png` });
          console.log(`  Screenshot saved: fail_sync_${bot.name}.png`);
        }
      }

      // Cleanup
      for (const bot of this.bots) {
        await bot.browser.close();
      }

      process.exit(hashesMatch ? 0 : 1);
    } catch (err) {
      console.error('❌ Test error:', err);
      for (const bot of this.bots) {
        try { await bot.browser.close(); } catch (e) {}
      }
      process.exit(1);
    }
  }
}

new BasicSyncTest().run().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
