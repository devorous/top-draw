#!/usr/bin/env node

/**
 * @fileoverview
 * Three-user active-layer stroke comparison with concurrent drawing.
 *
 * All 3 users draw one stroke simultaneously.
 * Compare active-layer stroke records (cropped stroke canvases) pairwise to
 * verify per-stroke sync quality under concurrent writes.
 */

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const HEADLESS = process.env.HEADLESS !== 'false';
const ROOM = `three_user_pixel_test_${Date.now()}`;

class ThreeUserPixelTest {
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

  async drawStroke(bot, offsetX = 0) {
    await bot.page.evaluate(async (offset) => {
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

      const x1 = 200 + offset;
      const y1 = 200;
      const x2 = 400 + offset;
      const y2 = 400;

      app.handlePointerDown(mockEv(x1, y1));
      app.inputBufferManager.tick();

      const steps = 20;
      for (let j = 1; j <= steps; j++) {
        const t = j / steps;
        const curX = x1 + (x2 - x1) * t;
        const curY = y1 + (y2 - y1) * t;
        app.handlePointerMove(mockEv(curX, curY));
        app.inputBufferManager.tick();
        await new Promise(r => setTimeout(r, 8));
      }

      app.handlePointerUp(mockEv(x2, y2));
      app.inputBufferManager.tick();
    }, offsetX);

    await new Promise(r => setTimeout(r, 500));
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
      return { error: `Stroke count mismatch (${stateA.strokeCount} vs ${stateB.strokeCount})` };
    }

    let totalPixels = 0;
    let divergentPixels = 0;
    let totalDifference = 0;

    for (let strokeIdx = 0; strokeIdx < stateA.records.length; strokeIdx++) {
      const a = stateA.records[strokeIdx];
      const b = stateB.records[strokeIdx];

      if (!b) return { error: `Missing matching stroke at index ${strokeIdx}` };

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
        const rDiff = Math.abs(p1[1] - p2[1]);
        const gDiff = Math.abs(p1[2] - p2[2]);
        const bDiff = Math.abs(p1[3] - p2[3]);
        const aDiff = Math.abs(p1[4] - p2[4]);

        const pixelDiff = Math.max(rDiff, gDiff, bDiff, aDiff);
        if (pixelDiff > 0) {
          divergentPixels++;
          totalDifference += pixelDiff;
        }
      }
    }

    const percentDifferent = ((divergentPixels / totalPixels) * 100).toFixed(3);
    const avgDifference = divergentPixels > 0 ? (totalDifference / divergentPixels).toFixed(1) : 0;

    return {
      divergentPixels,
      percentDifferent,
      avgDifference,
      verdict:
        percentDifferent < 0.1 ? '✅' :
        percentDifferent < 0.5 ? '✅' :
        percentDifferent < 2.0 ? '⚠️' :
        '❌'
    };
  }

  async run() {
    console.log(`🚀 Three-User Concurrent Pixel Comparison Test\n`);

    try {
      // Spawn all users
      console.log(`👥 Spawning users...`);
      const bots = [];
      for (let i = 0; i < 3; i++) {
        bots.push(await this.spawnBot(i));
      }
      console.log(`✅ All users connected and synced\n`);

      // All users draw concurrently
      console.log(`📝 All users drawing strokes concurrently...`);
      await Promise.all(
        bots.map((bot, i) => this.drawStroke(bot, i * 50))
      );
      console.log(`✅ All strokes drawn\n`);

      // Wait for sync
      console.log(`⏳ Waiting for sync propagation...`);
      await new Promise(r => setTimeout(r, 3000));

      // Capture stroke records
      console.log(`📸 Capturing active-layer stroke records from all users...\n`);
      const states = await Promise.all(
        bots.map(bot => this.getActiveLayerStrokeRecords(bot))
      );
      states.forEach((state, idx) => {
        console.log(`  ${bots[idx].name}: ${state.strokeCount} stroke(s) on layer ${state.activeLayer}`);
      });
      console.log('');

      // Compare all pairs
      console.log(`📊 PAIRWISE PIXEL COMPARISONS:\n`);
      for (let i = 0; i < bots.length; i++) {
        for (let j = i + 1; j < bots.length; j++) {
          const comp = this.compareStrokeRecords(states[i], states[j]);
          const divergence = comp.percentDifferent || '0.000';
          console.log(`  ${bots[i].name} vs ${bots[j].name}:`);
          if (comp.error) {
            console.log(`    Divergence: ❌ ERROR`);
            console.log(`    Details: ${comp.error}`);
            continue;
          }
          console.log(`    Divergence: ${comp.verdict} ${divergence}%`);
          if (comp.divergentPixels > 0) {
            console.log(`    Details: ${comp.divergentPixels.toLocaleString()} pixels differ (avg: ±${comp.avgDifference})`);
          }
        }
      }

      // Overall verdict
      console.log(`\n🎯 OVERALL RESULT:`);
      let allPerfect = true;
      for (let i = 0; i < bots.length; i++) {
        for (let j = i + 1; j < bots.length; j++) {
          const comp = this.compareStrokeRecords(states[i], states[j]);
          if (comp.error || parseFloat(comp.percentDifferent) > 0.5) {
            allPerfect = false;
          }
        }
      }

      if (allPerfect) {
        console.log(`✅ PERFECT SYNC: All users render identically!`);
      } else {
        console.log(`⚠️ DIVERGENCE DETECTED: Some users render differently`);
      }

      console.log(`\n✅ Test complete`);
      await Promise.all(bots.map(b => b.browser.close()));
      process.exit(0);
    } catch (err) {
      console.error('❌ Test error:', err);
      process.exit(1);
    }
  }
}

new ThreeUserPixelTest().run().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
