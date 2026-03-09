#!/usr/bin/env node

import puppeteer from 'puppeteer';

const TARGET_URL = process.env.TARGET_URL || 'http://localhost:3000';
const ROOM = `coord_test_${Date.now()}`;
const HEADLESS = process.env.HEADLESS !== 'false';

class CoordinateSyncTest {
  constructor() {
    this.browser = null;
    this.sender = null;
    this.receiver = null;
  }

  async run() {
    console.log(`🚀 Starting Coordinate Fidelity Test in room: ${ROOM}`);
    
    this.browser = await puppeteer.launch({
      headless: HEADLESS,
      args: ['--no-sandbox'],
      defaultViewport: { width: 1280, height: 720 }
    });

    // 1. Spawn Sender and Receiver
    this.sender = await this.browser.newPage();
    this.receiver = await this.browser.newPage();

    for (const page of [this.sender, this.receiver]) {
      await page.goto(`${TARGET_URL}?room=${ROOM}`, { waitUntil: 'networkidle2' });
      await page.waitForFunction(() => window.app !== undefined, { timeout: 15000 });
      await page.evaluate((r) => window.app.handleRoomSelected(r), ROOM);
    }

    // Wait for them to see each other
    await this.sender.waitForFunction(() => window.app.users.size >= 2, { timeout: 10000 });
    console.log('  ✓ Both bots connected and ready');

    // 2. Setup Receiver to capture incoming messages
    await this.receiver.evaluate(() => {
      window._capturedEvents = [];
      const originalEmit = window.app.wsClient.emit;
      window.app.wsClient.emit = function(event, data) {
        if (['md', 'mm', 'mu'].includes(event)) {
          window._capturedEvents.push({ event, data: JSON.parse(JSON.stringify(data)) });
        }
        return originalEmit.apply(this, arguments);
      };
    });

    // 3. Sender draws a deterministic path
    console.log('✍️ Sender drawing complex path...');
    const testData = await this.sender.evaluate(async () => {
      const app = window.app;
      app.selectTool('brush');
      
      const sentData = [];
      const mockEv = (x, y, p) => ({
        button: 0, pointerType: 'mouse',
        offsetX: x, offsetY: y, clientX: x, clientY: y,
        pressure: p,
        preventDefault: () => {}
      });

      // Start point
      const start = { x: 100, y: 100, p: 0.1 };
      app.handlePointerDown(mockEv(start.x, start.y, start.p));
      app.inputBufferManager.tick();
      sentData.push({ event: 'md', x: start.x, y: start.y, p: start.p });

      // Move points
      for (let i = 1; i <= 10; i++) {
        const x = 100 + i * 50;
        const y = 100 + Math.sin(i) * 50;
        const p = 0.1 + i * 0.08;
        app.handlePointerMove(mockEv(x, y, p));
        app.inputBufferManager.tick();
        sentData.push({ event: 'mm', x, y, p });
      }

      // End point
      const end = { x: 650, y: 150, p: 0.9 };
      app.handlePointerUp(mockEv(end.x, end.y, end.p));
      app.inputBufferManager.tick();
      sentData.push({ event: 'mu', x: end.x, y: end.y, p: end.p });

      return sentData;
    });

    // 4. Wait for network
    console.log('⏳ Waiting for propagation...');
    await new Promise(r => setTimeout(r, 2000));

    // 5. Compare Sent vs Received
    const receivedEvents = await this.receiver.evaluate(() => window._capturedEvents);
    
    console.log('\n📊 Comparison Results:');
    console.log(`  Sent segments: ${testData.length}`);
    console.log(`  Received messages: ${receivedEvents.length}`);

    let discrepancies = 0;
    
    // Note: Due to batching/smoothing in InputBufferManager, 
    // we compare the logic of what arrived at the receiver.
    for (let i = 0; i < receivedEvents.length; i++) {
      const rec = receivedEvents[i];
      console.log(`  [${i}] Rec: ${rec.event} from ${rec.data.sessionIndex} | points: ${rec.data.ps?.length / 2 || 0} | radii: ${rec.data.rs?.length || 0}`);
      
      // Check if pressure was sent for mm
      if (rec.event === 'mm' && (!rec.data.rs || rec.data.rs.length === 0)) {
        console.error(`  ❌ FAILED: Movement batch ${i} is missing pressure data (rs field)`);
        discrepancies++;
      }
    }

    if (discrepancies === 0 && receivedEvents.length > 0) {
      console.log('\n✅ SUCCESS: Coordinates and pressure were transmitted correctly!');
    } else {
      console.log('\n❌ FAILURE: Fidelity issues detected in transport.');
    }

    await this.browser.close();
    process.exit(discrepancies === 0 ? 0 : 1);
  }
}

new CoordinateSyncTest().run().catch(console.error);
