#!/usr/bin/env node

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000';
const TOOL = process.env.TOOL || 'brush';
const ROOM = `sim_sync_test_${TOOL}_${Date.now()}`;
const HEADLESS = process.env.HEADLESS !== 'false';
const NUM_BOTS = 4;

class SimilaritySyncTest {
  constructor() {
    this.bots = [];
  }

  async spawnBot(i) {
    const name = `bot_${i}`;
    console.log(`  Spawning ${name}...`);
    
    const browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1280, height: 720 }
    });
    
    const page = await browser.newPage();
    
    await page.goto(`${TARGET_URL}?room=${ROOM}`, { waitUntil: 'networkidle2' });
    await page.waitForFunction(() => window.app !== undefined, { timeout: 15000 });

    await page.evaluate((n, r) => {
      window.app.self.username = n;
      window.app.handleRoomSelected(r);
    }, name, ROOM);

    return { name, browser, page };
  }

  async run() {
    console.log(`🚀 Starting Multi-Stroke Sync Test (4 Users, ${TOOL}) in room: ${ROOM}`);
    
    // 1. Spawn bots
    const spawnPromises = [];
    for (let i = 0; i < NUM_BOTS; i++) {
      spawnPromises.push(this.spawnBot(i));
    }
    this.bots = await Promise.all(spawnPromises);
    console.log('  ✓ All bots spawned\n');

    // 2. Wait for stabilization
    console.log('👥 Waiting for bots to sync and see each other...');
    for (const bot of this.bots) {
      await bot.page.waitForFunction((total) => {
        return window.app.syncClient.hasCompletedSync && window.app.users.size >= total;
      }, { timeout: 60000 }, NUM_BOTS);
      console.log(`  ✓ ${bot.name} is ready`);
    }

    // 3. Clear board
    console.log('\n🧹 Clearing board...');
    await this.bots[0].page.evaluate(() => window.app.handleClear());
    await new Promise(r => setTimeout(r, 3000));

    // 4. Draw multiple strokes per bot
    console.log(`✍️ Drawing 5 lines per bot with ${TOOL}...`);
    
    const drawPromises = this.bots.map((bot, botIdx) => {
      return bot.page.evaluate(async (botI, toolName) => {
        const app = window.app;
        app.selectTool(toolName);

        const mockEv = (x, y) => ({
          button: 0, pointerType: 'mouse',
          offsetX: x, offsetY: y, clientX: x, clientY: y,
          preventDefault: () => {}
        });

        for (let s = 0; s < 5; s++) {
           const sectorX = (botI % 2) * 600;
           const sectorY = Math.floor(botI / 2) * 350;
           
           // Deterministic positions based on stroke index s
           const start = { x: sectorX + 50 + s * 20, y: sectorY + 50 + s * 10 };
           const end = { x: sectorX + 400 - s * 10, y: sectorY + 200 + s * 20 };
           const color = [botI * 50, 255 - botI * 50, 128, 1];
           
           app.handleColorInputChange(color);
           app.handleSizeChange({ target: { value: 5 + s * 2 } });

           app.handlePointerDown(mockEv(start.x, start.y));
           app.handlePointerMove(mockEv(end.x, end.y));
           app.handlePointerUp(mockEv(end.x, end.y));
           await new Promise(r => setTimeout(r, 200));
        }
      }, botIdx, TOOL);
    });

    await Promise.all(drawPromises);
    console.log('  ✓ All 20 strokes finished');

    // 5. Final flush
    console.log('\n⏳ Flushing and compositing...');
    await new Promise(r => setTimeout(r, 5000));
    for (const bot of this.bots) {
      await bot.page.evaluate(() => {
        if (window.app.wsClient._processMessageQueue) window.app.wsClient._processMessageQueue();
        if (window.app.inputBufferManager.tick) window.app.inputBufferManager.tick();
        window.app.board.compositeAllLayers();
      });
    }

    // 6. Compare Canvases (Similarity)
    console.log('\n📊 Analyzing Similarity:');
    const pixelDatas = [];
    for (const bot of this.bots) {
      const data = await bot.page.evaluate(() => {
        const canvas = window.app.board.mainCanvas;
        return Array.from(canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data);
      });
      pixelDatas.push({ name: bot.name, data });
    }

    const baseline = pixelDatas[0];
    for (let i = 1; i < pixelDatas.length; i++) {
      const target = pixelDatas[i];
      let matches = 0;
      let totalPixels = baseline.data.length / 4;
      
      for (let j = 0; j < baseline.data.length; j += 4) {
        const rMatch = baseline.data[j] === target.data[j];
        const gMatch = baseline.data[j+1] === target.data[j+1];
        const bMatch = baseline.data[j+2] === target.data[j+2];
        const aMatch = baseline.data[j+3] === target.data[j+3];
        if (rMatch && gMatch && bMatch && aMatch) matches++;
      }
      
      const percent = (matches / totalPixels * 100).toFixed(4);
      console.log(`  Similarity (${baseline.name} vs ${target.name}): ${percent}%`);
    }

    // Cleanup
    for (const bot of this.bots) {
      await bot.browser.close();
    }
  }
}

new SimilaritySyncTest().run().catch(console.error);
