#!/usr/bin/env node

/**
 * @fileoverview
 * Two-user active-layer stroke comparison test.
 *
 * User A draws one stroke, User B joins immediately.
 * Both clients inspect the active layer stroke stack and compare the committed
 * cropped stroke canvas (bounds + pixels) directly.
 */

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3001/go/';
const HEADLESS = process.env.HEADLESS !== 'false';
const ROOM = `two_user_pixel_test_${Date.now()}`;

class TwoUserPixelTest {
  async spawnBot(i) {
    const name = `user_${i}`;
    console.log(`Spawning ${name}...`);
    
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

  async drawStroke(bot) {
    await bot.page.evaluate(async () => {
      const app = window.app;
      app.selectTool('brush');
      app.handleColorInputChange([255, 0, 0, 1]); // Red
      app.handleSizeChange({ target: { value: 15 } });

      const mockEv = (x, y) => ({
        button: 0,
        pointerType: 'mouse',
        offsetX: x,
        offsetY: y,
        clientX: x,
        clientY: y,
        preventDefault: () => {}
      });

      app.handlePointerDown(mockEv(200, 200));
      app.inputBufferManager.tick();

      const steps = 20;
      for (let j = 1; j <= steps; j++) {
        const t = j / steps;
        const curX = 200 + (400 - 200) * t;
        const curY = 200 + (400 - 200) * t;
        app.handlePointerMove(mockEv(curX, curY));
        app.inputBufferManager.tick();
        await new Promise(r => setTimeout(r, 8));
      }

      app.handlePointerUp(mockEv(400, 400));
      app.inputBufferManager.tick();
    });

    await new Promise(r => setTimeout(r, 1000));
  }

  async getActiveLayerStrokeRecords(bot) {
    return await bot.page.evaluate(() => {
      const app = window.app;
      const lm = app.board.layerManager;
      const activeLayer = app.self?.activeLayer ?? 0;
      const group = lm.layerGroups?.[activeLayer];
      const strokeStack = group?.strokeStack || [];

      const records = strokeStack.map((stroke) => {
        const width = stroke.width || stroke.canvas?.width || 0;
        const height = stroke.height || stroke.canvas?.height || 0;
        const ctx = stroke.ctx || stroke.canvas?.getContext('2d');
        const imageData = (ctx && width > 0 && height > 0)
          ? ctx.getImageData(0, 0, width, height)
          : { data: new Uint8ClampedArray() };

        const sparsePixels = [];
        const rgba = imageData.data;
        for (let i = 0; i < rgba.length; i += 4) {
          const alpha = rgba[i + 3];
          if (alpha === 0) continue;
          sparsePixels.push([
            i / 4,
            rgba[i],
            rgba[i + 1],
            rgba[i + 2],
            alpha
          ]);
        }

        return {
          userId: stroke.userId,
          x: stroke.x,
          y: stroke.y,
          width,
          height,
          blendMode: stroke.blendMode,
          timestamp: stroke.timestamp,
          sparsePixels
        };
      });

      records.sort((a, b) => {
        if (a.userId !== b.userId) return a.userId - b.userId;
        if (a.x !== b.x) return a.x - b.x;
        if (a.y !== b.y) return a.y - b.y;
        if (a.width !== b.width) return a.width - b.width;
        if (a.height !== b.height) return a.height - b.height;
        if (a.blendMode !== b.blendMode) return String(a.blendMode).localeCompare(String(b.blendMode));
        return (a.timestamp || 0) - (b.timestamp || 0);
      });

      return {
        activeLayer,
        strokeCount: records.length,
        records
      };
    });
  }

  compareStrokeRecords(stateA, stateB) {
    if (!stateA || !stateB) {
      return { error: 'Missing stroke state' };
    }

    if (stateA.strokeCount !== stateB.strokeCount) {
      return {
        error: `Stroke count mismatch (${stateA.strokeCount} vs ${stateB.strokeCount})`
      };
    }

    let totalPixels = 0;
    let divergentPixels = 0;
    let totalDifference = 0;
    let maxDifference = 0;
    const pixelDifferences = [];

    for (let strokeIdx = 0; strokeIdx < stateA.records.length; strokeIdx++) {
      const a = stateA.records[strokeIdx];
      const b = stateB.records[strokeIdx];

      if (!b) {
        return { error: `Missing matching stroke at index ${strokeIdx}` };
      }

      const sameMeta =
        a.userId === b.userId &&
        a.x === b.x &&
        a.y === b.y &&
        a.width === b.width &&
        a.height === b.height &&
        a.blendMode === b.blendMode;

      if (!sameMeta) {
        return {
          error: `Stroke metadata mismatch at index ${strokeIdx}`,
          strokeA: { userId: a.userId, x: a.x, y: a.y, width: a.width, height: a.height, blendMode: a.blendMode },
          strokeB: { userId: b.userId, x: b.x, y: b.y, width: b.width, height: b.height, blendMode: b.blendMode }
        };
      }

      totalPixels += (a.width * a.height);

      const mapA = new Map(a.sparsePixels.map((entry) => [entry[0], entry]));
      const mapB = new Map(b.sparsePixels.map((entry) => [entry[0], entry]));
      const indices = new Set([...mapA.keys(), ...mapB.keys()]);

      for (const pxIdx of indices) {
        const p1 = mapA.get(pxIdx) || [pxIdx, 0, 0, 0, 0];
        const p2 = mapB.get(pxIdx) || [pxIdx, 0, 0, 0, 0];

        const r1 = p1[1];
        const g1 = p1[2];
        const b1 = p1[3];
        const a1 = p1[4];

        const r2 = p2[1];
        const g2 = p2[2];
        const b2 = p2[3];
        const a2 = p2[4];

        const rDiff = Math.abs(r1 - r2);
        const gDiff = Math.abs(g1 - g2);
        const bDiff = Math.abs(b1 - b2);
        const aDiff = Math.abs(a1 - a2);
        const pixelDiff = Math.max(rDiff, gDiff, bDiff, aDiff);

        if (pixelDiff > 0) {
          divergentPixels++;
          totalDifference += pixelDiff;
          maxDifference = Math.max(maxDifference, pixelDiff);

          if (pixelDifferences.length < 10) {
            pixelDifferences.push({
              strokeIndex: strokeIdx,
              pixelIndex: pxIdx,
              rDiff,
              gDiff,
              bDiff,
              aDiff,
              maxChannelDiff: pixelDiff
            });
          }
        }
      }
    }

    const percentDifferent = ((divergentPixels / totalPixels) * 100).toFixed(3);
    const avgDifference = divergentPixels > 0 ? (totalDifference / divergentPixels).toFixed(1) : 0;

    return {
      totalPixels: totalPixels.toLocaleString(),
      divergentPixels: divergentPixels.toLocaleString(),
      percentDifferent,
      avgDifference,
      maxDifference,
      sampleDifferences: pixelDifferences,
      verdict:
        percentDifferent < 0.1 ? '✅ EXCELLENT (< 0.1% divergence)' :
        percentDifferent < 0.5 ? '✅ ACCEPTABLE (0.1-0.5% divergence)' :
        percentDifferent < 2.0 ? '⚠️ NOTABLE (0.5-2% divergence)' :
        '❌ SIGNIFICANT (> 2% divergence)'
    };
  }

  async run() {
    console.log(`🚀 Two-User Pixel Comparison Test`);
    console.log(`Room: ${ROOM}\n`);

    try {
      // Spawn User A
      console.log(`👤 User A: Connecting...`);
      const userA = await this.spawnBot(0);
      console.log(`✅ User A connected\n`);

      // User A draws
      console.log(`📝 User A: Drawing stroke...`);
      await this.drawStroke(userA);
      console.log(`✅ Stroke drawn\n`);

      // User B joins
      console.log(`👤 User B: Joining...`);
      const userB = await this.spawnBot(1);
      console.log(`✅ User B connected and synced\n`);

      // Wait for sync to settle
      console.log(`⏳ Waiting for sync propagation...`);
      await new Promise(r => setTimeout(r, 2000));

      // Capture stroke records from both
      console.log(`📸 Capturing active-layer stroke records from both users...\n`);
      const stateA = await this.getActiveLayerStrokeRecords(userA);
      const stateB = await this.getActiveLayerStrokeRecords(userB);
      console.log(`✅ Captured A:${stateA.strokeCount} stroke(s), B:${stateB.strokeCount} stroke(s) on layer ${stateA.activeLayer}\n`);

      // Compare
      console.log(`📊 STROKE-CANVAS PIXEL COMPARISON:\n`);
      const comparison = this.compareStrokeRecords(stateA, stateB);

      if (comparison.error) {
        console.log(`  ❌ Error: ${comparison.error}`);
      } else {
        console.log(`  Total Pixels: ${comparison.totalPixels}`);
        console.log(`  Divergent Pixels: ${comparison.divergentPixels}`);
        console.log(`  Percentage Different: ${comparison.percentDifferent}%`);
        console.log(`  Avg Difference (per divergent pixel): ${comparison.avgDifference}`);
        console.log(`  Max Difference (any channel): ${comparison.maxDifference}\n`);
        console.log(`  🎯 Verdict: ${comparison.verdict}`);

        if (comparison.sampleDifferences.length > 0) {
          console.log(`\n  📌 Sample Divergent Pixels:`);
          comparison.sampleDifferences.forEach((diff, i) => {
            console.log(`    ${i + 1}. Stroke ${diff.strokeIndex}, Pixel ${diff.pixelIndex}: R±${diff.rDiff} G±${diff.gDiff} B±${diff.bDiff} A±${diff.aDiff}`);
          });
        }
      }

      console.log(`\n✅ Test complete`);
      await userA.browser.close();
      await userB.browser.close();
      process.exit(0);
    } catch (err) {
      console.error('❌ Test error:', err);
      process.exit(1);
    }
  }
}

new TwoUserPixelTest().run().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
