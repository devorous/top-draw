<script>
  import { getStroke } from 'perfect-freehand';

  let canvasEl = $state(null);
  let mounted = $state(false);

  // Virtual canvas space — coordinates defined here, scaled to display
  const VW = 480, VH = 300;

  // Sample a cubic bezier into [x, y, pressure] points.
  // Pressure follows a sine bell so strokes taper naturally at ends.
  function sampleBezier([p0, p1, p2, p3], n = 60) {
    return Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1);
      const mt = 1 - t;
      const x = mt**3*p0[0] + 3*mt**2*t*p1[0] + 3*mt*t**2*p2[0] + t**3*p3[0];
      const y = mt**3*p0[1] + 3*mt**2*t*p1[1] + 3*mt*t**2*p2[1] + t**3*p3[1];
      const pressure = 0.06 + 0.9 * Math.sin(Math.PI * t);
      return [x, y, pressure];
    });
  }

  // sampleBezier variant with offset pressure peak — strokes that linger thick then taper fast
  function sampleBezierSkewed([p0, p1, p2, p3], n = 60, peakT = 0.5) {
    return Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1);
      const mt = 1 - t;
      const x = mt**3*p0[0] + 3*mt**2*t*p1[0] + 3*mt*t**2*p2[0] + t**3*p3[0];
      const y = mt**3*p0[1] + 3*mt**2*t*p1[1] + 3*mt*t**2*p2[1] + t**3*p3[1];
      // Asymmetric bell — peakT shifts where the stroke is thickest
      const norm = t / peakT < 1 ? t / peakT : (1 - t) / (1 - peakT);
      const pressure = 0.05 + 0.92 * Math.pow(norm, 0.6);
      return [x, y, Math.max(0.05, Math.min(1, pressure))];
    });
  }

  // Stroke definitions — bezier control points, color, brush params
  const STROKES = [
    // Main sweep — big gestural arc, cyan, peaks early
    {
      points: sampleBezierSkewed([[22, 238], [110, 135], [305, 82], [458, 62]], 72, 0.35),
      color: '#00d4aa', size: 18, thinning: 0.74,
    },
    // Counter-arc going the other way, white, thin
    {
      points: sampleBezier([[48, 98], [165, 148], [308, 162], [452, 205]], 55),
      color: 'rgba(255,255,255,0.2)', size: 9, thinning: 0.58,
    },
    // Tight loop / comma shape, cyan, semi-opaque
    {
      points: sampleBezier([[118, 262], [178, 192], [244, 188], [288, 258]], 44),
      color: '#00d4aa', size: 13, thinning: 0.85, opacity: 0.5,
    },
    // Short flick bottom-right, white ghost
    {
      points: sampleBezierSkewed([[332, 252], [368, 210], [418, 218], [452, 248]], 30, 0.25),
      color: 'rgba(255,255,255,0.16)', size: 7, thinning: 0.7,
    },
  ];

  // Timeline: each stroke has a [start, end] window in ms.
  const TL = [
    { start: 400,  end: 1900, idx: 0 },
    { start: 2150, end: 3200, idx: 1 },
    { start: 3420, end: 4250, idx: 2 },
    { start: 4420, end: 4980, idx: 3 },
  ];

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  $effect(() => {
    mounted = true;
    const canvas = canvasEl;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    function setup() {
      const dpr = window.devicePixelRatio || 1;
      const { width, height } = canvas.getBoundingClientRect();
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(width / VW * dpr, 0, 0, height / VH * dpr, 0, 0);
    }
    setup();

    function drawStroke(pts, color, size, thinning, opacity = 1) {
      const outline = getStroke(pts, {
        size, thinning,
        smoothing: 0.5,
        streamline: 0.45,
        simulatePressure: false,
        last: true,
      });
      if (outline.length < 2) return;
      ctx.save();
      ctx.globalAlpha = opacity;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(outline[0][0], outline[0][1]);
      for (let i = 1; i < outline.length; i++) ctx.lineTo(outline[i][0], outline[i][1]);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    let t0 = null;
    let alive = true;
    const DONE_MS = TL[TL.length - 1].end + 200;

    function frame(ts) {
      if (!alive) return;
      if (t0 === null) t0 = ts;
      const elapsed = ts - t0;
      if (elapsed > DONE_MS) return;

      ctx.clearRect(0, 0, VW, VH);

      for (const phase of TL) {
        const s = STROKES[phase.idx];
        if (elapsed < phase.start) continue;

        if (elapsed >= phase.end) {
          drawStroke(s.points, s.color, s.size, s.thinning, s.opacity ?? 1);
        } else {
          const t = easeInOut((elapsed - phase.start) / (phase.end - phase.start));
          const count = Math.max(2, Math.ceil(t * s.points.length));
          drawStroke(s.points.slice(0, count), s.color, s.size, s.thinning, s.opacity ?? 1);
        }
      }

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
    return () => { alive = false; };
  });

  const features = [
    { label: '01', title: 'Real-time collaboration', desc: 'Every stroke is broadcast instantly. Multiple cursors, shared rooms, no refresh needed.' },
    { label: '02', title: 'Layers & blend modes',    desc: 'Three layers with ten blend modes — Multiply, Screen, Overlay, and more.' },
    { label: '03', title: 'Pressure-sensitive tools', desc: 'Brush, Pen, Ink, Eraser, Fill, Blur. Full tilt and pressure support via Pointer Events API.' },
  ];
</script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">

<div class="page" class:mounted>
  <nav>
    <span class="wordmark">ddraw</span>
    <div class="nav-links">
      <a href="/gallery/">gallery</a>
      <a href="/go/" class="nav-enter">open app →</a>
    </div>
  </nav>

  <section class="hero">
    <div class="hero-text">
      <p class="label">Free · Open · Real-time</p>
      <h1>Draw with<br><span class="accent">anyone.</span></h1>
      <p class="sub">
        A multiplayer canvas. Pick a room, grab a brush,
        and make something with strangers.
      </p>
      <div class="actions">
        <a href="/go/" class="btn-primary">Start Drawing</a>
        <a href="/gallery/" class="btn-secondary">Browse Gallery</a>
      </div>
    </div>

    <div class="hero-preview">
      <div class="preview-chrome">
        <div class="chrome-bar">
          <span class="chrome-title">ddraw — lobby</span>
          <div class="chrome-dots"><span></span><span></span><span></span></div>
        </div>
        <div class="canvas-wrap">
          <canvas bind:this={canvasEl}></canvas>
        </div>
        <div class="chrome-foot">
          <span class="dot active"></span><span class="dot"></span><span class="dot"></span><span class="dot"></span>
        </div>
      </div>
    </div>
  </section>

  <section class="features">
    {#each features as f}
      <div class="feature">
        <span class="feat-num">{f.label}</span>
        <div class="feat-body">
          <h3>{f.title}</h3>
          <p>{f.desc}</p>
        </div>
      </div>
    {/each}
  </section>

  <section class="cta-row">
    <p>No account required. Just join a room.</p>
    <a href="/go/" class="btn-primary">Open the canvas</a>
  </section>

  <footer>
    <span class="wordmark dim">ddraw</span>
    <div class="foot-links">
      <a href="/gallery/">Gallery</a>
      <a href="https://github.com" target="_blank" rel="noopener">GitHub</a>
    </div>
  </footer>
</div>

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(body) {
    background: #121212;
    color: #fff;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 14px;
    overflow-x: hidden;
  }
  :global(a) { color: inherit; text-decoration: none; }
  :global(body)::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image: radial-gradient(circle, rgba(255,255,255,0.065) 1px, transparent 1px);
    background-size: 28px 28px;
    pointer-events: none;
    z-index: 0;
  }

  .page { position: relative; z-index: 1; opacity: 0; transition: opacity 0.4s ease; }
  .page.mounted { opacity: 1; }

  /* ── Nav ── */
  nav {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 2rem; height: 44px;
    background: rgba(18,18,18,0.9);
    border-bottom: 1px solid rgba(255,255,255,0.07);
    backdrop-filter: blur(8px);
  }
  .wordmark { font-size: 13px; font-weight: 600; letter-spacing: 0.08em; }
  .wordmark.dim { color: rgba(255,255,255,0.25); }
  .nav-links { display: flex; align-items: center; gap: 1.5rem; font-size: 12px; font-weight: 500; }
  .nav-links a { color: rgba(255,255,255,0.4); transition: color 0.15s; }
  .nav-links a:hover { color: #fff; }
  .nav-enter { color: #00d4aa !important; }

  /* ── Hero ── */
  .hero {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 1fr 1.15fr;
    align-items: center;
    gap: 5rem;
    padding: 6rem 3rem 4rem;
    max-width: 1200px;
    margin: 0 auto;
  }
  .label { font-size: 11px; font-weight: 500; letter-spacing: 0.14em; text-transform: uppercase; color: #00d4aa; margin-bottom: 1.25rem; }
  h1 { font-size: clamp(2.8rem, 5vw, 4.5rem); font-weight: 600; line-height: 1.08; letter-spacing: -0.03em; margin-bottom: 1.5rem; }
  .accent { color: #00d4aa; }
  .sub { font-size: 14px; line-height: 1.75; color: rgba(255,255,255,0.45); margin-bottom: 2.5rem; max-width: 38ch; }
  .actions { display: flex; gap: 0.75rem; flex-wrap: wrap; }

  .btn-primary {
    display: inline-block; padding: 0.6rem 1.5rem;
    background: #00d4aa; color: #121212;
    font-family: inherit; font-size: 13px; font-weight: 600; letter-spacing: 0.02em;
    transition: background 0.15s;
  }
  .btn-primary:hover { background: #00f0c3; }
  .btn-secondary {
    display: inline-block; padding: 0.6rem 1.5rem;
    border: 1px solid rgba(255,255,255,0.15); color: rgba(255,255,255,0.5);
    font-size: 13px; font-weight: 500;
    transition: border-color 0.15s, color 0.15s;
  }
  .btn-secondary:hover { border-color: rgba(255,255,255,0.4); color: #fff; }

  /* ── Preview ── */
  .preview-chrome {
    border: 1px solid rgba(255,255,255,0.1);
    background: #0d0d0d;
    overflow: hidden;
  }
  .chrome-bar {
    height: 34px; background: #1a1a1a;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 12px;
  }
  .chrome-title { font-size: 11px; color: rgba(255,255,255,0.3); font-weight: 500; letter-spacing: 0.03em; }
  .chrome-dots { display: flex; gap: 5px; }
  .chrome-dots span { width: 8px; height: 8px; border-radius: 50%; background: rgba(255,255,255,0.12); }

  .canvas-wrap {
    position: relative;
    aspect-ratio: 8 / 5;
    background: #111;
    overflow: hidden;
  }
  canvas {
    display: block;
    width: 100%;
    height: 100%;
  }


  .chrome-foot {
    height: 28px; background: #1a1a1a;
    border-top: 1px solid rgba(255,255,255,0.07);
    display: flex; align-items: center; padding: 0 12px; gap: 6px;
  }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: rgba(255,255,255,0.14); flex-shrink: 0; }
  .dot.active { background: #00d4aa; }

  /* ── Features ── */
  .features { border-top: 1px solid rgba(255,255,255,0.07); max-width: 1200px; margin: 0 auto; }
  .feature {
    display: grid; grid-template-columns: 80px 1fr;
    align-items: start; gap: 1.5rem;
    padding: 2rem 3rem;
    border-bottom: 1px solid rgba(255,255,255,0.07);
    transition: background 0.15s;
  }
  .feature:hover { background: rgba(255,255,255,0.02); }
  .feat-num { font-size: 11px; font-weight: 600; letter-spacing: 0.1em; color: rgba(255,255,255,0.18); padding-top: 3px; }
  .feat-body h3 { font-size: 14px; font-weight: 600; margin-bottom: 0.4rem; letter-spacing: -0.01em; }
  .feat-body p { font-size: 13px; line-height: 1.65; color: rgba(255,255,255,0.38); }

  /* ── CTA Row ── */
  .cta-row {
    display: flex; align-items: center; justify-content: space-between;
    padding: 2.5rem 3rem;
    border-top: 1px solid rgba(255,255,255,0.07);
    max-width: 1200px; margin: 0 auto;
  }
  .cta-row p { font-size: 13px; color: rgba(255,255,255,0.38); }

  /* ── Footer ── */
  footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 1rem 3rem;
    border-top: 1px solid rgba(255,255,255,0.06);
    max-width: 1200px; margin: 0 auto;
  }
  .foot-links { display: flex; gap: 1.25rem; font-size: 12px; color: rgba(255,255,255,0.22); }
  .foot-links a:hover { color: rgba(255,255,255,0.6); }

  /* ── Responsive ── */
  @media (max-width: 860px) {
    .hero { grid-template-columns: 1fr; padding: 5rem 1.5rem 3rem; gap: 3rem; }
    .feature { padding: 1.5rem; grid-template-columns: 48px 1fr; gap: 1rem; }
    .cta-row { flex-direction: column; gap: 1.25rem; align-items: flex-start; padding: 2rem 1.5rem; }
    footer { padding: 1rem 1.5rem; }
  }
</style>
