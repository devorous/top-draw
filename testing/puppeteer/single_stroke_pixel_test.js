#!/usr/bin/env node

/**
 * @fileoverview
 * Simplest possible test: single user, single stroke.
 * Compare canvas pixel-by-pixel to measure actual divergence.
 */

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000/go/';
const HEADLESS = process.env.HEADLESS !== 'false';
const ROOM = `single_stroke_test_${Date.now()}`;

class SingleStrokeTest {
  async spawnBot() {
    const name = 'user_0';
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
    console.log(`\nDrawing one stroke...`);
    
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

      // Single diagonal stroke
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

  /**
   * Get full pixel data from canvas
   */
  async getPixelData(bot) {
    return await bot.page.evaluate(() => {
      const canvas = window.app.board.mainCanvas;
      const ctx = canvas.getContext('2d');
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      return {
        width: canvas.width,
        height: canvas.height,
        data: Array.from(imageData.data) // Convert to array for serialization
      };
    });
  }

  /**
   * Compare two pixel buffers
   */
  comparePixels(pixels1, pixels2) {
    if (!pixels1 || !pixels2) {
      return { error: 'Missing pixel data' };
    }

    if (pixels1.data.length !== pixels2.data.length) {
      return { error: 'Pixel data length mismatch' };
    }

    const totalPixels = pixels1.data.length / 4; // 4 channels per pixel (RGBA)
    let divergentPixels = 0;
    let totalDifference = 0;

    for (let i = 0; i < pixels1.data.length; i++) {
      const diff = Math.abs(pixels1.data[i] - pixels2.data[i]);
      if (diff > 0) {
        divergentPixels += (i % 4 === 3 ? 0 : 1); // Count once per pixel, not per channel
        totalDifference += diff;
      }
    }

    const pixelsWithDifference = divergentPixels / 4; // Convert back to pixel count
    const percentDifferent = ((pixelsWithDifference / totalPixels) * 100).toFixed(2);
    const avgDiffPerChannel = (totalDifference / pixels1.data.length).toFixed(2);

    return {
      totalPixels,
      pixelsWithDifference,
      percentDifferent,
      avgDiffPerChannel,
      verdict: percentDifferent < 0.5 ? '✅ ACCEPTABLE (< 0.5% divergence)' : '⚠️ SIGNIFICANT (> 0.5% divergence)'
    };
  }

  async run() {
    console.log(`🚀 Single-Stroke Pixel Comparison Test`);
    console.log(`Room: ${ROOM}\n`);

    try {
      const bot = await this.spawnBot();
      console.log(`✅ User connected\n`);

      await this.drawStroke(bot);
      console.log(`✅ Stroke drawn\n`);

      // Get pixel data immediately
      console.log(`Capturing canvas pixels...`);
      const snapshot1 = await this.getPixelData(bot);
      console.log(`✅ Canvas snapshot 1 captured (${snapshot1.width}x${snapshot1.height})\n`);

      // Wait a bit and capture again
      await new Promise(r => setTimeout(r, 2000));
      
      console.log(`Capturing canvas pixels again...`);
      const snapshot2 = await this.getPixelData(bot);
      console.log(`✅ Canvas snapshot 2 captured\n`);

      // Compare
      console.log(`📊 PIXEL COMPARISON:\n`);
      const comparison = this.comparePixels(snapshot1, snapshot2);

      if (comparison.error) {
        console.log(`  Error: ${comparison.error}`);
      } else {
        console.log(`  Total Pixels: ${comparison.totalPixels.toLocaleString()}`);
        console.log(`  Pixels with Difference: ${comparison.pixelsWithDifference.toLocaleString()}`);
        console.log(`  Percentage Different: ${comparison.percentDifferent}%`);
        console.log(`  Avg Difference per Channel: ${comparison.avgDiffPerChannel}\n`);
        console.log(`  Verdict: ${comparison.verdict}`);
      }

      console.log(`\n✅ Test complete`);
      await bot.browser.close();
      process.exit(0);
    } catch (err) {
      console.error('❌ Test error:', err);
      process.exit(1);
    }
  }
}

new SingleStrokeTest().run().catch(err => {
  console.error('Uncaught error:', err);
  process.exit(1);
});
