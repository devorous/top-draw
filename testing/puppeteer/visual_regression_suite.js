#!/usr/bin/env node

/**
 * @fileoverview Visual Regression Test Suite for Top Draw.
 * Performs granular, deterministic tool operations and compares results against baselines.
 * 
 * Usage:
 *   node testing/puppeteer/visual_regression_suite.js [--generate]
 */

import puppeteer from 'puppeteer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Config ────────────────────────────────────────────────────────────────

const TARGET_URL    = process.env.TARGET_URL     || 'http://localhost:3000/go/';
const HEADLESS      = process.env.HEADLESS !== 'false';
const BASELINES_DIR = path.join(__dirname, '..', 'baselines');
const OUTPUTS_DIR   = path.join(__dirname, '..', 'outputs');
const DIFFS_DIR     = path.join(__dirname, '..', 'diffs');
const REPORT_FILE   = path.join(__dirname, '..', 'VISUAL_REPORT.md');
const PY_COMPARE    = path.join(__dirname, '..', 'compare_images.py');

const IS_GENERATE   = process.argv.includes('--generate');
const GEN_MISSING   = process.argv.includes('--generate-missing');

// ─── Deterministic Randomness ──────────────────────────────────────────────

let seed = 12345;
function random() {
  seed = (seed * 9301 + 49297) % 233280;
  return seed / 233280;
}

function resetRandom() {
  seed = 12345;
}

// ─── Deterministic Stroke Patterns ────────────────────────────────────────

const STROKE_PATTERNS = [];
function generatePatterns() {
  resetRandom();
  for (let i = 0; i < 50; i++) {
    const path = [];
    const steps = 8 + Math.floor(random() * 8);
    const startX = 200 + random() * 1500;
    const startY = 100 + random() * 800;
    
    path.push({ x: startX, y: startY });
    for (let s = 1; s < steps; s++) {
      path.push({ 
        x: startX + (random() - 0.5) * 400, 
        y: startY + (random() - 0.5) * 400 
      });
    }
    STROKE_PATTERNS.push(path);
  }
}
generatePatterns();

// ─── Test Case Definitions ─────────────────────────────────────────────────

const TOOLS_TO_TEST = [
  { name: 'ink', category: 'brush', settings: [
    { size: 10, color: [255, 0, 0, 1], smoothing: 0.1 },
    { size: 20, color: [0, 255, 0, 0.8], smoothing: 0.4 },
    { size: 30, color: [0, 0, 255, 0.6], smoothing: 0.7 },
    { size: 50, color: [255, 255, 0, 0.4], smoothing: 0.2 },
    { size: 15, color: [0, 0, 0, 1], smoothing: 0.9 }
  ]},
  { name: 'brush', category: 'brush', settings: [
    { size: 15, color: [255, 0, 0, 1], hardness: 1.0 },
    { size: 30, color: [0, 255, 0, 0.7], hardness: 0.5 },
    { size: 60, color: [0, 0, 255, 0.4], hardness: 0.1 },
    { size: 10, color: [0, 0, 0, 1], hardness: 0.9 },
    { size: 20, color: [255, 0, 255, 0.6], hardness: 0.3 }
  ]},
  { name: 'pixel', category: 'brush', settings: [
    { size: 1, color: [0, 0, 0, 1] },
    { size: 1, color: [255, 0, 0, 1] },
    { size: 1, color: [0, 255, 0, 1] },
    { size: 1, color: [0, 0, 255, 1] },
    { size: 1, color: [100, 100, 100, 1] }
  ]},
  { name: 'flowPen', category: 'brush', settings: [
    { size: 10, color: [255, 0, 0, 1] },
    { size: 20, color: [0, 255, 0, 0.8] },
    { size: 40, color: [0, 0, 255, 0.6] },
    { size: 15, color: [200, 200, 0, 0.4] },
    { size: 25, color: [0, 0, 0, 1] }
  ]},
  { name: 'rectangle', category: 'shape', settings: [
    { size: 4, color: [255, 0, 0, 1] },
    { size: 8, color: [0, 255, 0, 0.7] },
    { size: 12, color: [0, 0, 255, 0.5] },
    { size: 2, color: [0, 0, 0, 1] },
    { size: 20, color: [255, 255, 0, 0.3] }
  ]},
  { name: 'circle', category: 'shape', settings: [
    { size: 4, color: [255, 0, 0, 1] },
    { size: 8, color: [0, 255, 0, 0.7] },
    { size: 12, color: [0, 0, 255, 0.5] },
    { size: 2, color: [0, 0, 0, 1] },
    { size: 20, color: [255, 255, 0, 0.3] }
  ]},
  { name: 'line', category: 'shape', settings: [
    { size: 2, color: [0, 0, 0, 1] },
    { size: 6, color: [255, 0, 0, 0.8] },
    { size: 10, color: [0, 255, 0, 0.6] },
    { size: 4, color: [0, 0, 255, 1] },
    { size: 20, color: [200, 0, 200, 0.4] }
  ]},
  { name: 'confetti', category: 'brush', settings: [
    // 1. Defaults — circle particles, active color, random rotation
    {
      size: 30, color: [220, 60, 60, 1],
      confettiParticles: 4, confettiParticleSize: 10,
      confettiSizeVariation: 40, confettiOpacityRandomness: 20,
      confettiSpacing: 30, confettiShape: 'circle',
      confettiColorMode: 'active', confettiRotationMode: 'random'
    },
    // 2. High particle count, small particles, tight spacing
    {
      size: 40, color: [60, 180, 80, 1],
      confettiParticles: 12, confettiParticleSize: 6,
      confettiSizeVariation: 20, confettiOpacityRandomness: 10,
      confettiSpacing: 10, confettiShape: 'circle',
      confettiColorMode: 'active', confettiRotationMode: 'random'
    },
    // 3. Square shape, fixed rotation, no variation
    {
      size: 25, color: [40, 100, 220, 1],
      confettiParticles: 6, confettiParticleSize: 14,
      confettiSizeVariation: 0, confettiOpacityRandomness: 0,
      confettiSpacing: 25, confettiShape: 'square',
      confettiColorMode: 'active', confettiRotationMode: 'fixed'
    },
    // 4. Random color mode, follow rotation, wide spacing
    {
      size: 35, color: [255, 200, 0, 1],
      confettiParticles: 5, confettiParticleSize: 12,
      confettiSizeVariation: 30, confettiOpacityRandomness: 30,
      confettiSpacing: 45, confettiShape: 'square',
      confettiColorMode: 'random', confettiRotationMode: 'follow'
    },
    // 5. Max chaos — high variation + high opacity randomness
    {
      size: 45, color: [180, 0, 200, 1],
      confettiParticles: 8, confettiParticleSize: 16,
      confettiSizeVariation: 100, confettiOpacityRandomness: 100,
      confettiSpacing: 20, confettiShape: 'circle',
      confettiColorMode: 'active', confettiRotationMode: 'random'
    }
  ]}
];

const SPECIAL_CASES = [
  {
    name: 'fill_variations',
    action: async (page) => {
      resetRandom();
      await selectTool(page, 'circle');
      await setToolSettings(page, { size: 2, color: [0, 0, 0, 1] });
      const centers = [];
      for (let i = 0; i < 5; i++) {
        const cx = 200 + random() * 1500;
        const cy = 200 + random() * 700;
        centers.push({x: cx, y: cy});
        // Circle is drawn from corner to corner in simple mode
        await drawPath(page, [{x: cx - 100, y: cy - 100}, {x: cx + 100, y: cy + 100}]);
      }
      await selectTool(page, 'fill');
      const fillSettings = [
        { color: [255, 0, 0, 1], expansion: 0, blurRadius: 0 },
        { color: [0, 255, 0, 1], expansion: 10, blurRadius: 0 },
        { color: [0, 0, 255, 1], expansion: 0, blurRadius: 5 },
        { color: [255, 255, 0, 1], expansion: 5, blurRadius: 2 },
        { color: [255, 0, 255, 0.5], expansion: 2, blurRadius: 1 }
      ];
      for (let i = 0; i < 5; i++) {
        await setToolSettings(page, fillSettings[i]);
        await clickPoint(page, centers[i].x, centers[i].y); 
      }
    }
  },
  {
    name: 'blur_tools_test',
    action: async (page) => {
      resetRandom();
      // Draw background noise/shapes
      await selectTool(page, 'brush');
      await setToolSettings(page, { size: 10, color: [0, 0, 0, 1], hardness: 1 });
      for (let i = 0; i < 15; i++) {
        const x = 100 + random() * 1700;
        await drawPath(page, [{x: x, y: 100}, {x: x, y: 900}]);
      }
      
      // Apply Blur
      await selectTool(page, 'blur');
      await setToolSettings(page, { size: 100 });
      await drawPath(page, [{x: 200, y: 300}, {x: 600, y: 300}]);
      
      // Apply Circle Blur
      await selectTool(page, 'circleBlur');
      await setToolSettings(page, { size: 150 });
      await clickPoint(page, 960, 540);
      
      // Apply Glitch Blur
      await selectTool(page, 'glitchBlur');
      await setToolSettings(page, { size: 120 });
      await drawPath(page, [{x: 1300, y: 200}, {x: 1300, y: 800}]);
    }
  },
  {
    name: 'image_brush_set',
    action: async (page) => {
      resetRandom();
      await page.evaluate(async () => {
        const app = window.app;
        const loader = app.brushGallery;
        const gallery = loader.realGallery || loader.loadRealGallery();
        const pepper = gallery.brushes.find(b => b.fileName === 'pepper.gbr');
        if (pepper) app.handleBrushSelect(pepper);
      });
      await selectTool(page, 'imageBrush');
      for (let i = 0; i < 5; i++) {
        await setToolSettings(page, { size: 60 + random() * 100, color: [255, 255, 255, 1] });
        await clickPoint(page, 200 + random() * 1500, 200 + random() * 700);
      }
    }
  },
  {
    name: 'text_tool_set',
    action: async (page) => {
      resetRandom();
      await selectTool(page, 'text');
      const texts = ["Hello World", "Top Draw", "Automated", "Testing", "Deterministic"];
      for (let i = 0; i < 5; i++) {
        await setToolSettings(page, { size: 40 + i * 20, color: [i * 50, 0, 255 - i * 50, 1] });
        const x = 300 + random() * 1000;
        const y = 200 + random() * 600;
        await clickPoint(page, x, y);
        await page.keyboard.type(texts[i]);
        await page.keyboard.press('Enter');
        await sleep(300);
      }
    }
  },
  {
    name: 'confetti_image_brush',
    action: async (page) => {
      resetRandom();
      // Pick a real GIMP brush so confettiShape='image' has source pixels
      await page.evaluate(async () => {
        const app = window.app;
        const loader = app.brushGallery;
        const gallery = loader.realGallery || loader.loadRealGallery();
        const brush = gallery.brushes.find(b => b.fileName === 'pepper.gbr') || gallery.brushes[0];
        if (brush) app.handleBrushSelect(brush);
      });
      await selectTool(page, 'confetti');
      await setToolSettings(page, {
        size: 40, color: [255, 100, 200, 1],
        confettiParticles: 5, confettiParticleSize: 22,
        confettiSizeVariation: 40, confettiOpacityRandomness: 15,
        confettiSpacing: 25, confettiShape: 'image',
        confettiColorMode: 'image', confettiRotationMode: 'random'
      });
      for (let i = 0; i < 3; i++) {
        const cy = 250 + i * 250;
        await drawPath(page, [
          { x: 250, y: cy },
          { x: 600, y: cy + 60 },
          { x: 950, y: cy - 40 },
          { x: 1300, y: cy + 80 },
          { x: 1650, y: cy }
        ]);
      }
    }
  },
  {
    name: 'confetti_options_mix',
    action: async (page) => {
      resetRandom();
      await selectTool(page, 'confetti');
      // Stroke A — circles, active color, random rotation
      await setToolSettings(page, {
        size: 30, color: [220, 50, 50, 1],
        confettiParticles: 6, confettiParticleSize: 12,
        confettiSizeVariation: 30, confettiOpacityRandomness: 10,
        confettiSpacing: 18, confettiShape: 'circle',
        confettiColorMode: 'active', confettiRotationMode: 'random'
      });
      await drawPath(page, [
        { x: 200, y: 250 }, { x: 500, y: 280 }, { x: 800, y: 220 },
        { x: 1100, y: 280 }, { x: 1400, y: 240 }, { x: 1700, y: 270 }
      ]);
      // Stroke B — squares, fixed rotation, no variation
      await setToolSettings(page, {
        size: 28, color: [50, 130, 220, 1],
        confettiParticles: 4, confettiParticleSize: 16,
        confettiSizeVariation: 0, confettiOpacityRandomness: 0,
        confettiSpacing: 30, confettiShape: 'square',
        confettiColorMode: 'active', confettiRotationMode: 'fixed'
      });
      await drawPath(page, [
        { x: 200, y: 520 }, { x: 500, y: 500 }, { x: 800, y: 540 },
        { x: 1100, y: 500 }, { x: 1400, y: 540 }, { x: 1700, y: 510 }
      ]);
      // Stroke C — random color, follow rotation, large spacing
      await setToolSettings(page, {
        size: 36, color: [0, 0, 0, 1],
        confettiParticles: 5, confettiParticleSize: 14,
        confettiSizeVariation: 50, confettiOpacityRandomness: 40,
        confettiSpacing: 42, confettiShape: 'square',
        confettiColorMode: 'random', confettiRotationMode: 'follow'
      });
      await drawPath(page, [
        { x: 200, y: 800 }, { x: 500, y: 760 }, { x: 800, y: 820 },
        { x: 1100, y: 770 }, { x: 1400, y: 810 }, { x: 1700, y: 780 }
      ]);
    }
  },
  {
    name: 'select_complex_transform',
    action: async (page) => {
      await selectTool(page, 'rectangle');
      await setToolSettings(page, { size: 8, color: [255, 0, 0, 1] });
      await drawPath(page, [{x: 800, y: 400}, {x: 1100, y: 700}]);
      await selectTool(page, 'select');
      await drawPath(page, [{x: 780, y: 380}, {x: 1120, y: 720}]);
      await drag(page, 950, 550, 1300, 550); 
      await drag(page, 1300, 370, 1500, 370); 
    }
  }
];

// ─── Helpers ───────────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function selectTool(page, tool) {
  await page.evaluate((t) => window.app.selectTool(t), tool);
}

async function setToolSettings(page, settings) {
  await page.evaluate((s) => {
    const app = window.app;
    if (s.size !== undefined) app.handleSizeChange({ target: { value: s.size } });
    if (s.color !== undefined) app.handleColorInputChange(s.color);
    if (s.blendMode !== undefined) app.handleBlendModeChange(s.blendMode);
    if (s.smoothing !== undefined) app.handleSmoothingChange({ target: { value: s.smoothing } });
    if (s.hardness !== undefined) app.handleHardnessChange({ target: { value: s.hardness } });
    if (s.expansion !== undefined || s.blurRadius !== undefined) {
      const tool = app.toolManager.getTool('fill');
      if (tool) {
        if (s.expansion !== undefined) tool._expansion = s.expansion;
        if (s.blurRadius !== undefined) tool._blurRadius = s.blurRadius;
        tool._updateSliders();
      }
    }
    // Confetti tool options live directly on app.self
    if (s.confettiParticles !== undefined) app.self.confettiParticles = s.confettiParticles;
    if (s.confettiParticleSize !== undefined) app.self.confettiParticleSize = s.confettiParticleSize;
    if (s.confettiSizeVariation !== undefined) app.self.confettiSizeVariation = s.confettiSizeVariation;
    if (s.confettiOpacityRandomness !== undefined) app.self.confettiOpacityRandomness = s.confettiOpacityRandomness;
    if (s.confettiSpacing !== undefined) app.self.confettiSpacing = s.confettiSpacing;
    if (s.confettiShape !== undefined) app.self.confettiShape = s.confettiShape;
    if (s.confettiColorMode !== undefined) app.self.confettiColorMode = s.confettiColorMode;
    if (s.confettiRotationMode !== undefined) app.self.confettiRotationMode = s.confettiRotationMode;
    // Pin the confetti per-stroke seed for determinism
    if (s.confettiStrokeSeed !== undefined) app.self._confettiStrokeSeed = s.confettiStrokeSeed;
  }, settings);
}

async function getClientCoords(page, boardX, boardY) {
  return await page.evaluate((bx, by) => {
    const board = window.app.board;
    const containerRect = board.container.getBoundingClientRect();
    const rad = board.rotation * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    let rx = bx * board.zoom;
    let ry = by * board.zoom;
    if (board.canvasFlipped) rx = (board.getWidth() - bx) * board.zoom;
    const bx_rotated = rx * cos + ry * sin;
    const by_rotated = -rx * sin + ry * cos;
    const clientX = bx_rotated + board.panX + containerRect.left;
    const clientY = by_rotated + board.panY + containerRect.top;
    return { clientX, clientY };
  }, boardX, boardY);
}

async function drawPath(page, points) {
  const clientPoints = [];
  for (const p of points) {
    clientPoints.push(await getClientCoords(page, p.x, p.y));
  }

  await page.evaluate(async (pts) => {
    const app = window.app;
    const ev = (c) => ({ 
      button: 0, 
      pointerType: 'mouse', 
      clientX: c.clientX, 
      clientY: c.clientY, 
      preventDefault: () => {} 
    });

    app.handlePointerDown(ev(pts[0]));
    
    for (let i = 1; i < pts.length; i++) {
      const start = pts[i-1];
      const end = pts[i];
      const steps = 4; 
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        const cur = {
          clientX: start.clientX + (end.clientX - start.clientX) * t,
          clientY: start.clientY + (end.clientY - start.clientY) * t
        };
        app.handlePointerMove(ev(cur));
        app.inputBufferManager?.tick();
        await new Promise(r => setTimeout(r, 5));
      }
    }

    app.handlePointerUp(ev(pts[pts.length - 1]));
    app.inputBufferManager?.tick();
  }, clientPoints);
  await sleep(350); 
}

async function clickPoint(page, x, y) {
  const coords = await getClientCoords(page, x, y);
  await page.evaluate(async (c) => {
    const app = window.app;
    const ev = (c) => ({ 
      button: 0, 
      pointerType: 'mouse', 
      clientX: c.clientX, 
      clientY: c.clientY, 
      preventDefault: () => {} 
    });
    app.handlePointerDown(ev(c));
    app.inputBufferManager?.tick();
    app.handlePointerUp(ev(c));
    app.inputBufferManager?.tick();
  }, coords);
  await sleep(350);
}

async function drag(page, sx, sy, ex, ey) {
  await drawPath(page, [{x: sx, y: sy}, {x: ex, y: ey}]);
}

// Bypass App.handleClear() — it gates on moderator role and silently rejects
// test-bot requests. We call board.clear() directly so the canvas actually empties.
async function clearCanvas(page) {
  await page.evaluate(() => {
    const app = window.app;
    app.board?.clear?.();
    app.board?.tileTracker?.clear?.();
    app.debugOverlay?.clearAll?.();
  });
}

// Re-seed Math.random in the browser so each test starts from a known PRNG state.
// Without this, tools that consume Math.random (e.g. ConfettiTool.createSeed)
// are sensitive to how much randomness preceding initialization/tests have used.
async function reseedRandom(page, seedValue = 12345) {
  await page.evaluate((s) => {
    let seed = s;
    Math.random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
  }, seedValue);
}

async function captureCanvas(page) {
  // Grab pixels directly from the main canvas so DOM overlays (tutorial popups,
  // color panels, layer pills, cursors, etc.) don't pollute the regression.
  const dataUrl = await page.evaluate(() => {
    const canvas = window.app.board.viewCanvas;
    return canvas.toDataURL('image/png');
  });
  const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
  return Buffer.from(base64, 'base64');
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🎨 Top Draw — Visual Regression Suite`);
  console.log(`Mode: ${IS_GENERATE ? 'GENERATING BASELINES' : 'TESTING'}`);
  console.log(`URL:  ${TARGET_URL}\n`);

  if (!fs.existsSync(BASELINES_DIR)) fs.mkdirSync(BASELINES_DIR, { recursive: true });
  if (!fs.existsSync(OUTPUTS_DIR)) fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  if (!fs.existsSync(DIFFS_DIR)) fs.mkdirSync(DIFFS_DIR, { recursive: true });

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1920, height: 1080 },
  });

  try {
    const page = await browser.newPage();
    page.on('console', msg => {
      const text = msg.text();
      if (!text.includes('[WAIT]')) console.log(`  [BROWSER] ${text}`);
    });
    page.on('pageerror', err => console.log(`  [BROWSER ERROR] ${err.message}`));

    await page.evaluateOnNewDocument(() => {
      let seed = 12345;
      Math.random = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };
      const fixedDate = new Date('2026-05-05T12:00:00Z').getTime();
      Date.now = () => fixedDate;
    });

    console.log('  Navigating to URL...');
    await page.goto(TARGET_URL, { waitUntil: 'networkidle2' });
    console.log('  Joining room "test"...');
    await page.evaluate((r) => {
      window.app.self.username = 'reg_bot';
      window.app.handleRoomSelected(r);
    }, 'test');
    
    console.log('  Waiting for app to be ready...');
    await page.waitForFunction(() => {
      const app = window.app;
      if (app?.brushGallery && !app.brushGallery.realGallery) app.brushGallery.loadRealGallery();
      const brushes = app?.brushGallery?.realGallery?.brushes;
      const syncDone = app?.syncClient?.hasCompletedSync === true || (app?.wsClient?.connected && app?.users?.size <= 1);
      return app?.wsClient?.connected && syncDone && brushes && brushes.length > 0;
    }, { timeout: 30000 });

    // Stop the real-time tick loop. Our manual inputBufferManager.tick() calls
    // become the only source of stamp processing — required for deterministic
    // confetti tests where stamp count depends on cursor delivery order.
    await page.evaluate(() => {
      window.app.inputBufferManager?.stopTickLoop?.();
    });
    
    const results = [];
    let patternIdx = 0;

    // 1. Run standard tool loops
    for (const toolTest of TOOLS_TO_TEST) {
      for (let i = 0; i < toolTest.settings.length; i++) {
        const testName = `${toolTest.name}_step_${i+1}`;
        process.stdout.write(`  [${testName}] ... `);
        await clearCanvas(page);
        await reseedRandom(page);
        await sleep(50);
        await selectTool(page, toolTest.name);
        await setToolSettings(page, toolTest.settings[i]);
        
        let pathPoints;
        const p = STROKE_PATTERNS[patternIdx % STROKE_PATTERNS.length];
        if (toolTest.category === 'shape') {
          // Simplified 2-point path for shapes (start to end)
          pathPoints = [p[0], p[p.length-1]];
        } else {
          pathPoints = p;
        }
        patternIdx++;
        
        await drawPath(page, pathPoints);
        await runComparison(page, testName, results);
      }
    }

    // 2. Run special cases
    for (const special of SPECIAL_CASES) {
      process.stdout.write(`  [${special.name}] ... `);
      await clearCanvas(page);
      await reseedRandom(page);
      await sleep(100);
      await special.action(page);
      await runComparison(page, special.name, results);
    }

    // ─── Generate Report ───────────────────────────────────────────────────
    
    let report = `# Visual Regression Report\n\nGenerated: ${new Date().toISOString()}\n\n`;
    report += `| Test Case | Status | Diff % | Actual | Baseline | Diff |\n| :--- | :--- | :--- | :--- | :--- | :--- |\n`;
    for (const res of results) {
      const icon = res.status === 'pass' ? '✅' : (res.status === 'fail' ? '❌' : '⚠️');
      const diffStr = res.diff > 0 ? `${res.diff.toFixed(4)}%` : '0%';
      const diffLink = res.diff > 0 ? `[View](../diffs/${res.name}_diff.png)` : '-';
      report += `| ${res.name} | ${icon} ${res.status.toUpperCase()} | ${diffStr} | [View](../outputs/${res.name}.png) | [View](../baselines/${res.name}.png) | ${diffLink} |\n`;
    }
    fs.writeFileSync(REPORT_FILE, report);
    console.log(`\nReport saved to: ${REPORT_FILE}`);
    process.exitCode = results.filter(r => r.status === 'fail').length > 0 ? 1 : 0;
  } catch (err) {
    console.error('\nFatal error:', err);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

async function runComparison(page, testName, results) {
  const screenshot = await captureCanvas(page);
  const outputPath = path.join(OUTPUTS_DIR, `${testName}.png`);
  const baselinePath = path.join(BASELINES_DIR, `${testName}.png`);
  const diffPath = path.join(DIFFS_DIR, `${testName}_diff.png`);
  fs.writeFileSync(outputPath, screenshot);
  if (IS_GENERATE) {
    fs.writeFileSync(baselinePath, screenshot);
    console.log('SAVED BASELINE');
    results.push({ name: testName, status: 'generated', diff: 0 });
  } else if (GEN_MISSING && !fs.existsSync(baselinePath)) {
    fs.writeFileSync(baselinePath, screenshot);
    console.log('SAVED MISSING BASELINE');
    results.push({ name: testName, status: 'generated', diff: 0 });
  } else {
    if (!fs.existsSync(baselinePath)) {
      console.log('MISSING BASELINE');
      results.push({ name: testName, status: 'missing', diff: 0 });
    } else {
      try {
        const output = execSync(`python "${PY_COMPARE}" "${baselinePath}" "${outputPath}" "${diffPath}"`).toString().trim();
        const diffPercent = parseFloat(output);
        if (diffPercent === 0) {
          console.log('✅ PASS (0%)');
          results.push({ name: testName, status: 'pass', diff: 0 });
        } else {
          const status = diffPercent < 0.005 ? 'pass' : 'fail';
          console.log(`${status === 'pass' ? '✅' : '❌'} ${status.toUpperCase()} (${diffPercent.toFixed(4)}%)`);
          results.push({ name: testName, status, diff: diffPercent });
        }
      } catch (err) {
        console.log('⚠️ COMPARE ERROR');
        results.push({ name: testName, status: 'error', diff: 0 });
      }
    }
  }
}

main();
