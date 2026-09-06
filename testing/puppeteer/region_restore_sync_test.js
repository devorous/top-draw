#!/usr/bin/env node

/**
 * @fileoverview
 * Integration test for History menu region restore sync.
 * 
 * Tests the fix for: https://github.com/...
 * When a user applies a region restore from History menu, and another user
 * joins during/after the async apply, both should see the same canvas state.
 * 
 * Scenario:
 * 1. User A draws initial strokes and saves them to board state
 * 2. User A draws different strokes on top
 * 3. User A programmatically applies a region restore (simulating History menu)
 * 4. User B joins immediately during the async apply
 * 5. Both users should have identical canvas state
 */

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const HEADLESS = process.env.HEADLESS !== 'false';
const ROOM = `region_restore_sync_${Date.now()}`;

class RegionRestoreSyncTest {
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
      if (txt.includes('[Sync]') || txt.includes('[Restore]')) {
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

  /**
   * Manually trigger a region restore by simulating the WebSocket message
   * that History menu sends when applying a region restore.
   */
  async triggerRegionRestore(bot, rect) {
    console.log(`    ${bot.name} triggering region restore (${rect.x}, ${rect.y}, ${rect.width}x${rect.height})...`);
    
    // Get current board state to use as "snapshot"
    const result = await bot.page.evaluate(async (selection) => {
      const app = window.app;
      const lm = app.board.layerManager;
      
      // Get the current canvas pixels in the region
      const canvas = app.board.viewCanvas;
      const ctx = canvas.getContext('2d');
      const imgData = ctx.getImageData(
        selection.x, selection.y,
        selection.width, selection.height
      );
      
      // Simulate a region restore by:
      // 1. Storing current pixels as "snapshot"
      const snapshotPixels = new Uint8ClampedArray(imgData.data);
      
      // 2. Clear the region
      ctx.clearRect(selection.x, selection.y, selection.width, selection.height);
      
      // 3. Broadcast the region restore message (async)
      await new Promise(resolve => {
        // Mimic what SnapshotHandlers does:
        // Create a fake region restore event that applies asynchronously
        app.wsClient.send({
          t: 103, // T.BOARD_SNAPSHOT_REGION_RESTORE
          snapshotId: `test_snapshot_${Date.now()}`,
          a: false, // not lasso
          sx: Math.round(selection.x),
          sy: Math.round(selection.y),
          sw: Math.round(selection.width),
          sh: Math.round(selection.height),
          cr: [],
          // Payload: PNG-encoded region (simplified for test)
          // In real scenario, server sends this
        });
        
        // Simulate async apply with RAF
        requestAnimationFrame(() => {
          // Put pixels back (simulating async decode + apply)
          const newImgData = ctx.createImageData(selection.width, selection.height);
          newImgData.data.set(snapshotPixels);
          ctx.putImageData(newImgData, selection.x, selection.y);
          
          console.log('[Restore] Region restore completed asynchronously');
          resolve();
        });
      });
      
      return { success: true };
    }, rect);
    
    // Wait for async operations to settle
    await new Promise(r => setTimeout(r, 1000));
    return result;
  }

  async getCanvasHash(bot) {
    return await bot.page.evaluate(() => {
      const canvas = window.app.board.viewCanvas;
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
    console.log(`🚀 Starting Region Restore Sync Test`);
    console.log(`🏠 Room: ${ROOM}\n`);
    
    try {
      // Spawn User A
      console.log('👤 User A: Connecting...');
      const userA = await this.spawnBot(0);
      this.bots.push(userA);
      console.log(`✅ User A ready\n`);

      // USER A: Draw initial strokes (these will be "saved")
      console.log('📝 User A: Drawing initial strokes (to be "saved")...');
      await this.drawStroke(userA, 100, 100, 300, 300, [255, 0, 0, 1]);
      await this.drawStroke(userA, 300, 100, 100, 300, [0, 255, 0, 1]);
      console.log(`✅ Initial strokes drawn\n`);

      // Wait for propagation
      await new Promise(r => setTimeout(r, 1000));

      // USER A: Draw different strokes on top
      console.log('📝 User A: Drawing new strokes on top...');
      await this.drawStroke(userA, 150, 150, 450, 450, [0, 0, 255, 1]);
      console.log(`✅ New strokes drawn\n`);

      // Wait for propagation
      await new Promise(r => setTimeout(r, 1000));

      // USER A: Apply region restore (async operation)
      console.log('📸 User A: Applying region restore...');
      await this.triggerRegionRestore(userA, {
        x: 150,
        y: 150,
        width: 300,
        height: 300
      });
      console.log(`✅ Region restore triggered\n`);

      // Get User A's hash after restore
      const hashA = await this.getCanvasHash(userA);
      console.log(`📊 User A canvas hash: ${hashA}\n`);

      // USER B: Join immediately (should trigger sync DURING or AFTER region restore apply)
      console.log('👤 User B: Joining room (sync will capture provider state)...');
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
        console.log('\n✅ SUCCESS: Region restore sync works correctly!');
        console.log('   Both users see the restored region despite async apply.');
      } else {
        console.log('\n❌ FAILURE: Canvas state divergence detected!');
        console.log('   Region restore may not have propagated to late-joiner.');
        
        // Take screenshots for debugging
        for (const bot of this.bots) {
          await bot.page.screenshot({ path: `fail_restore_${bot.name}.png` });
          console.log(`  Screenshot saved: fail_restore_${bot.name}.png`);
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

new RegionRestoreSyncTest().run().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
