#!/usr/bin/env node

/**
 * @fileoverview
 * Integration test for verifying canvas sync with History snapshot region restore.
 * 
 * Scenario:
 * 1. User A joins and draws strokes
 * 2. User A saves a manual snapshot
 * 3. User A draws more strokes, then applies a region restore from history
 * 4. User B joins immediately after (triggering sequential sync)
 * 5. Verify both users see identical final canvas state
 * 
 * This tests the fix for the race condition where sync providers could snapshot
 * before async region-restore completion, causing late joiners to see stale state.
 */

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/top-draw/';
const HEADLESS = process.env.HEADLESS !== 'false';
const ROOM = `history_restore_sync_${Date.now()}`;

class HistoryRegionRestoreSyncTest {
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
      if (txt.includes('[Snapshot]') || txt.includes('[Sync]')) {
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

  async saveSnapshot(bot, name) {
    console.log(`    ${bot.name} saving snapshot: "${name}"...`);
    await bot.page.evaluate((snapName) => {
      window.app.snapshotManager.saveSnapshot(snapName);
    }, name);
    
    // Wait for snapshot save to complete
    await new Promise(r => setTimeout(r, 2000));
  }

  async getSnapshotList(bot) {
    return await bot.page.evaluate(() => {
      return new Promise(resolve => {
        const timeout = setTimeout(() => resolve([]), 20000);
        const handler = (data) => {
          clearTimeout(timeout);
          window.app.wsClient.removeListener('board_snapshot_list', handler);
          resolve(data.snapshotList || []);
        };
        window.app.wsClient.on('board_snapshot_list', handler);
        window.app.snapshotManager.requestList();
      });
    });
  }

  async applyRegionRestore(bot, snapshotId, rect) {
    console.log(`    ${bot.name} applying region restore from snapshot ${snapshotId}...`);
    await bot.page.evaluate((snapId, selection) => {
      window.app.wsClient.send({
        t: 103, // T.BOARD_SNAPSHOT_REGION_RESTORE
        snapshotId: snapId,
        a: false, // not lasso
        sx: Math.round(selection.x),
        sy: Math.round(selection.y),
        sw: Math.round(selection.width),
        sh: Math.round(selection.height),
        cr: []
      });
    }, snapshotId, rect);

    // Wait for region restore to apply asynchronously
    await new Promise(r => setTimeout(r, 2000));
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
    console.log(`🚀 Starting History Region-Restore Sync Test`);
    console.log(`🏠 Room: ${ROOM}`);
    
    try {
      // Spawn User A (provider)
      const userA = await this.spawnBot(0);
      this.bots.push(userA);
      console.log(`✅ User A ready\n`);

      // USER A: Draw initial strokes
      console.log('📝 User A: Drawing initial strokes...');
      await this.drawStroke(userA, 200, 150, 500, 400, [255, 0, 0, 1]); // Red diagonal
      await this.drawStroke(userA, 500, 150, 200, 400, [0, 255, 0, 1]); // Green diagonal
      console.log(`✅ Initial strokes drawn\n`);

      // USER A: Save snapshot
      console.log('💾 User A: Saving snapshot...');
      await this.saveSnapshot(userA, 'restore-test-snapshot');
      console.log(`✅ Snapshot saved\n`);

      // USER A: Draw more strokes (different color)
      console.log('📝 User A: Drawing additional strokes...');
      await this.drawStroke(userA, 250, 300, 450, 300, [0, 0, 255, 1]); // Blue horizontal
      console.log(`✅ Additional strokes drawn\n`);

      // USER A: Get snapshot list and apply region restore
      console.log('📸 User A: Fetching snapshots...');
      const snapshots = await this.getSnapshotList(userA);
      const targetSnap = snapshots.find(s => s.name === 'restore-test-snapshot');
      
      if (!targetSnap) {
        console.error('❌ Snapshot not found!');
        process.exit(1);
      }

      console.log(`📸 Applying region restore from snapshot ${targetSnap.id}...`);
      // Restore a 300x300 region centered on canvas
      await this.applyRegionRestore(userA, targetSnap.id, {
        x: 250,
        y: 200,
        width: 300,
        height: 300
      });
      console.log(`✅ Region restore applied\n`);

      // Get User A's canvas hash after restore
      const hashA_afterRestore = await this.getCanvasHash(userA);
      console.log(`📊 User A canvas hash after restore: ${hashA_afterRestore}\n`);

      // USER B: Join immediately (triggering sync while region restore may still be processing)
      console.log('👤 User B: Joining room (triggering sync)...');
      const userB = await this.spawnBot(1);
      this.bots.push(userB);
      console.log(`✅ User B joined and synced\n`);

      // Wait for User B's sync to fully stabilize
      await new Promise(r => setTimeout(r, 3000));

      // Compare canvas hashes
      console.log('\n📊 FINAL COMPARISON:');
      const hashA_final = await this.getCanvasHash(userA);
      const hashB_final = await this.getCanvasHash(userB);

      console.log(`  User A canvas hash: ${hashA_final}`);
      console.log(`  User B canvas hash: ${hashB_final}`);

      const hashesMatch = hashA_final === hashB_final;

      if (hashesMatch) {
        console.log('\n✅ SUCCESS: Both users have identical canvas state after region restore and sync!');
      } else {
        console.log('\n❌ FAILURE: Canvas state divergence detected!');
        console.log('  This indicates a sync race condition or incomplete region restore propagation.');
        
        // Take screenshots for debugging
        for (const bot of this.bots) {
          await bot.page.screenshot({ path: `fail_history_restore_${bot.name}.png` });
          console.log(`  Screenshot saved: fail_history_restore_${bot.name}.png`);
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

new HistoryRegionRestoreSyncTest().run().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
