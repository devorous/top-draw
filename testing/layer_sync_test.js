#!/usr/bin/env node

/**
 * Layer Synchronization Test
 *
 * Spawns drawing bots and observer bots to detect rendering discrepancies:
 * - 3 drawing bots that cycle through tools and draw on the canvas
 * - 2 observer bots that watch and compare their rendered layers
 *
 * Usage:
 *   npm run test:layer-sync
 *
 * Options:
 *   DRAWING_BOTS=3     Number of bots that draw (default: 3)
 *   OBSERVER_BOTS=2    Number of bots that observe (default: 2)
 *   DURATION=120       Test duration in seconds (default: 120)
 *   CHECK_INTERVAL=10  Seconds between layer checks (default: 10)
 *   HEADLESS=false     Show browser windows (default: true)
 *   TARGET_URL=http://localhost:3000
 *   ROOM=layer_test
 */

import puppeteer from 'puppeteer';

const DRAWING_BOTS = parseInt(process.env.DRAWING_BOTS || '3');
const OBSERVER_BOTS = parseInt(process.env.OBSERVER_BOTS || '2');
const DURATION = parseInt(process.env.DURATION || '120') * 1000;
const CHECK_INTERVAL = parseInt(process.env.CHECK_INTERVAL || '10') * 1000;
const HEADLESS = process.env.HEADLESS !== 'false';
const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000';
const ROOM = process.env.ROOM || 'layer_sync_test';

const TOOLS = ['line', 'circle', 'brush', 'flowPen', 'rectangle', 'ink'];

class LayerSyncTest {
  constructor() {
    this.browser = null;
    this.drawingBots = [];
    this.observerBots = [];
    this.results = {
      checksPerformed: 0,
      discrepanciesFound: 0,
      detailedResults: []
    };
    this.startTime = Date.now();
  }

  async setup() {
    console.log('🚀 Starting Layer Sync Test');
    console.log(`   Drawing Bots: ${DRAWING_BOTS}`);
    console.log(`   Observer Bots: ${OBSERVER_BOTS}`);
    console.log(`   Duration: ${DURATION / 1000}s`);
    console.log(`   Check Interval: ${CHECK_INTERVAL / 1000}s`);
    console.log(`   Target: ${TARGET_URL}?room=${ROOM}`);
    console.log('');

    this.browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
      defaultViewport: { width: 1920, height: 1080 }
    });

    // Spawn drawing bots
    console.log('Spawning drawing bots...');
    for (let i = 0; i < DRAWING_BOTS; i++) {
      const page = await this.spawnBot(i, 'drawer');
      this.drawingBots.push(page);
      await this.startDrawing(page, i);
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Spawn observer bots
    console.log('Spawning observer bots...');
    for (let i = 0; i < OBSERVER_BOTS; i++) {
      const page = await this.spawnBot(i, 'observer');
      this.observerBots.push(page);
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    // Signal all bots to start drawing
    console.log('\n🚀 All bots connected and synced. Signaling start...');
    
    // Clear the board once at the start
    await this.drawingBots[0].evaluate(() => {
      if (window.app.handleClear) {
        console.log('[Bot] Clearing board for initial state');
        window.app.handleClear();
      }
    });

    for (const page of this.drawingBots) {
      await page.evaluate(() => { window._allBotsJoined = true; });
    }

    console.log(`✅ All bots connected and synced (${DRAWING_BOTS} drawing, ${OBSERVER_BOTS} observing)\n`);
  }

  async spawnBot(id, type) {
    const page = await this.browser.newPage();

    page.on('console', msg => {
      const text = msg.text();
      if (text.includes('[Bot]') || text.includes('ERROR') || text.includes('Warning')) {
        console.log(`[${type}_${id}] ${text}`);
      }
    });

    // Navigate to app
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' });

    // Wait for app and join room
    await page.waitForFunction(() => window.app !== undefined, { timeout: 15000 });

    const success = await page.evaluate((botId, botType, roomId) => {
      try {
        const username = `${botType}_${botId}`;
        console.log(`[Bot] Initializing as ${username}`);

        // Set global flags
        window._allBotsJoined = false;
        window._shouldSwapTool = false;
        window._shouldClearBoard = false;

        // Set username
        if (window.app.self) {
          window.app.self.username = username;
        }

        // Join room
        if (window.app.handleRoomSelected) {
          console.log(`[Bot] Joining room: ${roomId}`);
          window.app.handleRoomSelected(roomId);
          return true;
        } else {
          console.error('[Bot] No handleRoomSelected method');
          return false;
        }
      } catch (err) {
        console.error('[Bot] Error during setup:', err);
        return false;
      }
    }, id, type, ROOM);

    if (!success) {
      throw new Error(`Failed to initialize ${type} bot ${id}`);
    }

    // Wait for connection AND sync to complete
    console.log(`  ... ${type}_${id} waiting for sync`);
    await page.waitForFunction(() => {
      return window.app?.wsClient?.connected && 
             window.app?.wsClient?.sessionIndex !== null &&
             window.app?.syncClient?.hasCompletedSync === true;
    }, { timeout: 45000 });

    const sessionIndex = await page.evaluate(() => window.app.wsClient.sessionIndex);
    console.log(`  ✓ ${type}_${id} connected and synced (session: ${sessionIndex})`);

    return page;
  }

  async startDrawing(page, botId) {
    await page.evaluate((id, toolsList) => {
      console.log('[Bot] Starting drawing behavior');

      let currentToolIndex = 0;
      let strokeCount = 0;
      const hexColors = ['#FF0000', '#00FF00', '#0000FF', '#FFFF00', '#FF00FF', '#00FFFF'];

      // Helper to convert hex to RGBA array [r, g, b, a]
      const hexToRgba = (hex) => {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return [r, g, b, 1];
      };

      // Random starting position
      let x = 300 + Math.random() * 1000;
      let y = 300 + Math.random() * 400;

      const drawStroke = () => {
        // Wait for all bots signal
        if (!window._allBotsJoined) return;
        
        if (!window.app?.board) return;

        let transitioned = false;

        // One bot clears the board when signaled
        if (window._shouldClearBoard) {
          if (id === 0 && window.app.handleClear) {
            console.log('[Bot] Clearing board due to signal');
            window.app.handleClear();
          }
          window._shouldClearBoard = false;
          transitioned = true;
        }

        // Switch tool only when signaled by a layer check
        if (window._shouldSwapTool) {
          const toolName = toolsList[currentToolIndex % toolsList.length];
          console.log(`[Bot] Swapping tool due to signal: ${toolName}`);

          // Use selectTool to ensure broadcasting
          window.app.selectTool(toolName);

          // Set random color via handleColorInputChange
          const rgba = hexToRgba(hexColors[currentToolIndex % hexColors.length]);
          window.app.handleColorInputChange(rgba);

          // Set random size via handleSizeChange
          const size = 20 + (currentToolIndex % 3) * 20;
          window.app.handleSizeChange({ target: { value: size } });

          currentToolIndex++;
          window._shouldSwapTool = false; // Reset signal
          transitioned = true;
        }

        // Skip drawing if we just transitioned (cleared or swapped tool)
        if (transitioned) {
          console.log('[Bot] Transitioned state, skipping stroke for this cycle');
          return;
        }

        // Random walk to new position
        x += (Math.random() - 0.5) * 200;
        y += (Math.random() - 0.5) * 200;
        x = Math.max(100, Math.min(1800, x));
        y = Math.max(100, Math.min(900, y));

        const startX = x;
        const startY = y;

        console.log(`[Bot] Drawing stroke #${strokeCount} at (${startX.toFixed(0)}, ${startY.toFixed(0)})`);

        // Use DrawingApp event handlers to ensure proper buffering and broadcasting
        const mockEvent = (ox, oy) => ({
          button: 0,
          pointerType: 'mouse',
          offsetX: ox,
          offsetY: oy,
          clientX: ox, // Simplified for bot
          clientY: oy, // Simplified for bot
          preventDefault: () => {}
        });

        // Pointer down
        window.app.handlePointerDown(mockEvent(startX, startY));

        // Draw a 'wandering' stroke with 6-10 points
        let curX = startX;
        let curY = startY;
        const numPoints = 6 + Math.floor(Math.random() * 5);
        
        // General direction for this stroke
        const dirX = (Math.random() - 0.5) * 40;
        const dirY = (Math.random() - 0.5) * 40;

        for (let i = 0; i < numPoints; i++) {
          // Move in general direction with added jitter for realism
          curX += dirX + (Math.random() - 0.5) * 20;
          curY += dirY + (Math.random() - 0.5) * 20;
          
          // Clamp to board dimensions
          curX = Math.max(50, Math.min(1950, curX));
          curY = Math.max(50, Math.min(1030, curY));
          
          window.app.handlePointerMove(mockEvent(curX, curY));
        }

        // Pointer up
        window.app.handlePointerUp(mockEvent(curX, curY));

        strokeCount++;
        // Use end of stroke as next starting point (with clamping)
        x = curX;
        y = curY;
      };

      // Draw a stroke every 2 seconds
      window._botDrawInterval = setInterval(drawStroke, 2000);

      // Draw first stroke immediately
      setTimeout(drawStroke, 500);

    }, botId, TOOLS);

    console.log(`  ✓ drawer_${botId} now drawing`);
  }

  async captureLayerData(page, botType, botId) {
    return await page.evaluate((type, id) => {
      if (!window.app?.board) {
        return { error: 'No board' };
      }

      try {
        // Capture the main composited canvas (what the user actually sees)
        const canvas = window.app.board.mainCanvas;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const pixels = imageData.data;

        // Count pixels and compute hash (excluding white background)
        let totalPixels = 0;
        let drawnPixelCount = 0;
        let hash = 0;
        let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;

        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          const a = pixels[i + 3];

          // Count as drawn if it's not white (or if alpha is 0 for transparency)
          const isDrawn = !(r === 255 && g === 255 && b === 255 && a === 255);

          if (isDrawn) {
            const pixelIdx = i / 4;
            const x = pixelIdx % canvas.width;
            const y = Math.floor(pixelIdx / canvas.width);

            drawnPixelCount++;
            hash = ((hash << 5) - hash) + r + g + b + a;
            hash = hash & hash;

            // Track bounding box of drawn content
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x);
            maxY = Math.max(maxY, y);
          }
          totalPixels++;
        }

        // Calculate sizes
        const canvasSizeKB = (pixels.length / 1024).toFixed(2);
        const dataSizeKB = (drawnPixelCount * 4 / 1024).toFixed(2);
        const percentFilled = ((drawnPixelCount / totalPixels) * 100).toFixed(2);

        const boundingBox = drawnPixelCount > 0
          ? { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 }
          : null;

        return {
          botType: type,
          botId: id,
          sessionIndex: window.app.wsClient?.sessionIndex,
          canvas: {
            width: canvas.width,
            height: canvas.height,
            totalPixels,
            drawnPixels: drawnPixelCount,
            hash,
            canvasSizeKB,
            dataSizeKB,
            percentFilled,
            boundingBox
          }
        };
      } catch (err) {
        return { error: err.message, stack: err.stack };
      }
    }, botType, botId);
  }

  async performLayerCheck() {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    console.log(`\n🔍 Layer Check #${this.results.checksPerformed + 1} @ ${elapsed}s`);
    console.log('─'.repeat(80));

    // Capture from all bots
    const allData = [];

    for (let i = 0; i < this.drawingBots.length; i++) {
      const data = await this.captureLayerData(this.drawingBots[i], 'drawer', i);
      allData.push(data);
    }

    for (let i = 0; i < this.observerBots.length; i++) {
      const data = await this.captureLayerData(this.observerBots[i], 'observer', i);
      allData.push(data);
    }

    // Log canvas stats
    console.log('\nCanvas Statistics:');
    for (const bot of allData) {
      if (bot.error) {
        console.log(`  ${bot.botType}_${bot.botId}: ERROR - ${bot.error}`);
        continue;
      }

      const c = bot.canvas;
      const bbox = c.boundingBox
        ? `[${c.boundingBox.minX},${c.boundingBox.minY} → ${c.boundingBox.maxX},${c.boundingBox.maxY}] (${c.boundingBox.width}x${c.boundingBox.height})`
        : 'empty';

      console.log(`  ${bot.botType}_${bot.botId} (session ${bot.sessionIndex}):`);
      console.log(`    Pixels: ${c.drawnPixels.toLocaleString()} drawn / ${c.totalPixels.toLocaleString()} total (${c.percentFilled}%)`);
      console.log(`    Size: ${c.dataSizeKB} KB data, ${c.canvasSizeKB} KB canvas`);
      console.log(`    Hash: ${c.hash}`);
      console.log(`    BBox: ${bbox}`);
    }

    // Compare hashes
    const discrepancies = this.compareHashes(allData);

    this.results.checksPerformed++;

    // Signal all drawing bots to swap tools and clear board for the next round
    for (const page of this.drawingBots) {
      await page.evaluate(() => { 
        window._shouldSwapTool = true; 
        window._shouldClearBoard = true;
      });
    }

    if (discrepancies.length > 0) {
      this.results.discrepanciesFound++;
      console.log(`\n❌ DISCREPANCIES FOUND:`);
      for (const disc of discrepancies) {
        console.log(`   ${disc.versions.length} different canvas versions detected:`);
        for (const version of disc.versions) {
          console.log(`     - Hash ${version.hash} (${version.pixelCount} pixels): ${version.bots.join(', ')}`);
        }
      }
      this.results.detailedResults.push({ timestamp: elapsed, discrepancies });
    } else {
      console.log(`\n✅ All canvases match perfectly!`);
    }
  }

  compareHashes(allData) {
    const hashMap = new Map(); // hash -> [{ bot, pixelCount }]

    for (const bot of allData) {
      if (bot.error || !bot.canvas) continue;

      const botName = `${bot.botType}_${bot.botId}`;
      const hash = bot.canvas.hash;
      const pixelCount = bot.canvas.drawnPixels;

      // Only compare non-empty canvases
      if (pixelCount === 0) continue;

      if (!hashMap.has(hash)) {
        hashMap.set(hash, []);
      }
      hashMap.get(hash).push({ bot: botName, pixelCount });
    }

    // Check for discrepancies
    if (hashMap.size === 0) {
      return []; // All empty
    }

    if (hashMap.size === 1) {
      return []; // All match
    }

    // Multiple hashes = discrepancy
    const versions = Array.from(hashMap.entries()).map(([hash, botsData]) => ({
      hash,
      bots: botsData.map(b => b.bot),
      pixelCount: botsData[0].pixelCount
    }));

    return [{
      type: 'hash_mismatch',
      versions
    }];
  }

  async run() {
    await this.setup();

    // First check after 5 seconds
    await new Promise(resolve => setTimeout(resolve, 5000));
    await this.performLayerCheck();

    // Periodic checks
    const checkTimer = setInterval(() => {
      this.performLayerCheck();
    }, CHECK_INTERVAL);

    // Run for duration
    await new Promise(resolve => setTimeout(resolve, DURATION - 5000));

    clearInterval(checkTimer);

    // Final check
    console.log('\n🏁 Test Complete - Final Check');
    await this.performLayerCheck();

    await this.cleanup();
    this.printReport();
  }

  async cleanup() {
    console.log('\n🧹 Cleaning up...');

    // Stop drawing
    for (const page of this.drawingBots) {
      try {
        await page.evaluate(() => {
          if (window._botDrawInterval) {
            clearInterval(window._botDrawInterval);
          }
        });
      } catch (e) {}
    }

    if (this.browser) {
      await this.browser.close();
    }
  }

  printReport() {
    console.log('\n' + '═'.repeat(80));
    console.log('FINAL REPORT'.padStart(45));
    console.log('═'.repeat(80));
    console.log(`Total checks: ${this.results.checksPerformed}`);
    console.log(`Checks with discrepancies: ${this.results.discrepanciesFound}`);
    console.log(`Success rate: ${((1 - this.results.discrepanciesFound / this.results.checksPerformed) * 100).toFixed(1)}%`);
    console.log('═'.repeat(80));

    process.exit(this.results.discrepanciesFound > 0 ? 1 : 0);
  }
}

// Run
const test = new LayerSyncTest();
test.run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
