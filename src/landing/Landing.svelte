<script>
  import { getStroke } from 'perfect-freehand';
  import FeedbackWidget from '../ui/svelte/FeedbackWidget.svelte';

  let canvasEl = $state(null);
  let canvasReady = $state(false);
  let mounted = $state(false);
  let appVersion = $state(typeof window !== 'undefined' ? window.APP_VERSION || '1.3.0' : '1.3.0');

  // Virtual canvas space
  const VW = 480, VH = 300;

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

  function sampleBezierSkewed([p0, p1, p2, p3], n = 60, peakT = 0.5) {
    return Array.from({ length: n }, (_, i) => {
      const t = i / (n - 1);
      const mt = 1 - t;
      const x = mt**3*p0[0] + 3*mt**2*t*p1[0] + 3*mt*t**2*p2[0] + t**3*p3[0];
      const y = mt**3*p0[1] + 3*mt**2*t*p1[1] + 3*mt*t**2*p2[1] + t**3*p3[1];
      const norm = t / peakT < 1 ? t / peakT : (1 - t) / (1 - peakT);
      const pressure = 0.05 + 0.92 * Math.pow(norm, 0.6);
      return [x, y, Math.max(0.05, Math.min(1, pressure))];
    });
  }

  const STROKES = [
    { bz: [[22, 238], [110, 135], [305, 82], [458, 62]], n: 72, peakT: 0.35, color: '#ffdd00', size: 18, thinning: 0.74 },
    { bz: [[48, 98], [165, 148], [308, 162], [452, 205]], n: 55, color: '#c800c8', size: 9, thinning: 0.58 },
    { bz: [[118, 262], [178, 192], [244, 188], [288, 258]], n: 44, color: '#00d4aa', size: 13, thinning: 0.85, opacity: 0.5 },
    { bz: [[332, 252], [368, 210], [418, 218], [452, 248]], n: 30, peakT: 0.25, color: '#287ac1', size: 7, thinning: 0.7 },
  ];
  for (const s of STROKES) {
    s.points = s.peakT !== undefined ? sampleBezierSkewed(s.bz, s.n, s.peakT) : sampleBezier(s.bz, s.n);
  }

  const TL = [
    { start: 400,  end: 1900, idx: 0 },
    { start: 2150, end: 3200, idx: 1 },
    { start: 3420, end: 4250, idx: 2 },
    { start: 4420, end: 4980, idx: 3 },
  ];

  const CURSORS = [
    { strokeIdxs: [0, 2] },
    { strokeIdxs: [1, 3] },
  ];

  let cursor1El = $state(null);
  let cursor2El = $state(null);

  function easeInOut(t) {
    return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
  }

  function bezierAt([p0, p1, p2, p3], t) {
    const mt = 1 - t;
    return [
      mt**3*p0[0] + 3*mt**2*t*p1[0] + 3*mt*t**2*p2[0] + t**3*p3[0],
      mt**3*p0[1] + 3*mt**2*t*p1[1] + 3*mt*t**2*p2[1] + t**3*p3[1],
    ];
  }

  function bezierTangent([p0, p1, p2, p3], t) {
    const mt = 1 - t;
    const dx = 3*mt**2*(p1[0]-p0[0]) + 6*mt*t*(p2[0]-p1[0]) + 3*t**2*(p3[0]-p2[0]);
    const dy = 3*mt**2*(p1[1]-p0[1]) + 6*mt*t*(p2[1]-p1[1]) + 3*t**2*(p3[1]-p2[1]);
    const len = Math.hypot(dx, dy) || 1;
    return [dx/len, dy/len];
  }

  function updateCursor(el, strokeIdxs, elapsed) {
    if (!el) return;
    const FADE_MS = 140;
    let best = null;
    for (const idx of strokeIdxs) {
      const phase = TL[idx];
      if (elapsed < phase.start - FADE_MS || elapsed > phase.end + FADE_MS) continue;
      let progress, alpha;
      if (elapsed < phase.start) {
        progress = 0;
        alpha = (elapsed - (phase.start - FADE_MS)) / FADE_MS;
      } else if (elapsed > phase.end) {
        progress = 1;
        alpha = 1 - (elapsed - phase.end) / FADE_MS;
      } else {
        progress = (elapsed - phase.start) / (phase.end - phase.start);
        alpha = 1;
      }
      if (!best || alpha > best.alpha) best = { phase, progress, alpha };
    }
    if (!best) { el.style.opacity = '0'; return; }
    const s = STROKES[best.phase.idx];
    const t = easeInOut(best.progress);
    const [bx, by] = bezierAt(s.bz, t);
    // Lead the centerline by half-stroke along the tangent so the circle sits
    // at the visible tip (perfect-freehand renders a round cap at the endpoint).
    const [tx, ty] = bezierTangent(s.bz, t);
    const lead = s.size * 0.5;
    const x = bx + tx * lead;
    const y = by + ty * lead;
    el.style.left = `${(x / VW) * 100}%`;
    el.style.top = `${(y / VH) * 100}%`;
    el.style.opacity = String(best.alpha);
    el.style.setProperty('--rc-size-vp', String(s.size));
  }

  $effect(() => {
    mounted = true;

    let t0 = null;
    let alive = true;
    const DONE_MS = TL[TL.length - 1].end + 200;


    const canvas = canvasEl;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    function setup() {
      if (!alive) return;

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

    function frame(ts) {
      if (!alive) return;

       if (t0 === null) {
        t0 = ts;
        canvasReady = true; 
      }

      if (t0 === null) t0 = ts;
      const elapsed = ts - t0;
      if (elapsed > DONE_MS) {
        t0 = ts; // Loop it!
      }

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

      updateCursor(cursor1El, CURSORS[0].strokeIdxs, elapsed);
      updateCursor(cursor2El, CURSORS[1].strokeIdxs, elapsed);

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
    return () => { alive = false; };
  });

  const features = [
    { video: 'https://assets.ddraw.ca/drawing.mp4', title: 'Smooth Drawing', desc: 'Designed to make every stroke feel smooth and responsive, runs at a crisp 60 FPS, and keeps everyone in sync and drawing without a hitch.' },
    { video: 'https://assets.ddraw.ca/mirror.mp4', title: 'Mirrored Regions', desc: 'Can\'t draw a face? Just draw half! Our mirror modes applies region based reflections on the canvas perfect for symmetrical pieces with zero effort.' },
    { video: 'https://assets.ddraw.ca/pattern.mp4', title: 'Customizable Patterns', desc: 'Why use a normal brush when you can paint with patterns? Stamp your art with custom textures or use the image brush to paint with whatever!' },
    { video: 'https://assets.ddraw.ca/homography.mp4', title: 'The Selector', desc: 'Grab a chunk of the canvas, wiggle it around, resize it, or stamp it a thousand times. The selection tool is fast, accurate, and lets you rearrange reality however you like.' },
  ];

  const whyDdraw = [
    { title: 'Privacy First', desc: 'Your secrets are safe with us. Our messenger uses end-to-end encryption, and rooms are ephemeral. We don\'t peek, and we definitely don\'t track your every move.' },
    { title: 'No Nonsense', desc: 'No paywalls, no "premium brushes," and no annoying ads. It\'s a pure creative space built for the love of digital art.' },
  ];

  const WINDOWS_DOWNLOAD_URL = 'https://www.ddraw.ca/download';
  const DISCORD_INVITE_URL = 'https://discord.gg/aKp4Ew7V7a';
</script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
<link rel="preload" href="https://assets.ddraw.ca/homography.mp4" as="video" type="video/mp4">
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&family=Inter:wght@400;600&display=swap" rel="stylesheet">

<div class="page" class:mounted>
  <nav>
    <div class="nav-left">
      <span class="wordmark">DDraw!</span>
    </div>
    <div class="nav-links">
      <a href="#features">cool stuff</a>
      <a href="#download">get app</a>
      <a href="/gallery/" target="_blank">gallery</a>
      <a href="/go/" class="nav-enter">ENTER IT →</a>
    </div>
  </nav>

  <main>
    <section class="hero">
      <div class="hero-text">
        <div class="badge-float">Wowza!</div>
        <h1>DDraw with<br><span class="accent">anyboDy!</span></h1>
        <p class="sub">
          A cool, real-time multi user drawing canvas. No need to sign up. Just, like, a fun thing to draw on, you know?
        </p>
        <div class="actions">
          <a href="/go/" class="btn-primary main-cta">Start Scribbling!</a>
          <div class="download-mini">
            <span>Windows user?</span>
            <a href={WINDOWS_DOWNLOAD_URL}>Grab the app ↓</a>
          </div>
        </div>
      </div>

      <div class="hero-preview">
        <div class="preview-container">
          <div class="blob-bg"></div>
          <div class="preview-chrome">
            <div class="app-topbar">
              <div class="topbar-cluster">
                <button class="iconBtn" aria-label="Undo" tabindex="-1">
                  <img src="/images/undo-icon.svg" alt="" />
                </button>
                <button class="iconBtn" aria-label="Redo" tabindex="-1">
                  <img src="/images/redo-icon.svg" alt="" />
                </button>
                <span class="topbar-divider"></span>
                <button class="iconBtn" aria-label="Mirror" tabindex="-1">
                  <img src="/images/mirror.svg" alt="" />
                </button>
                <span class="topbar-divider"></span>
                <span class="zoom-pct">100%</span>
                <button class="iconBtn small" aria-label="Zoom out" tabindex="-1">
                  <img src="/images/magnifying-glass-minus.svg" alt="" />
                </button>
                <button class="iconBtn small" aria-label="Zoom in" tabindex="-1">
                  <img src="/images/magnifying-glass-plus.svg" alt="" />
                </button>
              </div>
              <div class="topbar-cluster right ddraw-letters" aria-hidden="true">
                <span class="ltr l-d1">D</span>
                <span class="ltr l-d2">D</span>
                <span class="ltr l-r">R</span>
                <span class="ltr l-a">A</span>
                <span class="ltr l-w">W</span>
              </div>
            </div>
            <div class="app-body">
              <div class="canvas-wrap">
                <div class="canvas-grid"></div>
                {#if !canvasReady}
                  <img
                    src="/images/preview-fallback.png"
                    alt="DDraw collaborative drawing app preview - real-time canvas with smooth drawing tools"
                    fetchpriority="high"
                    width="480"
                    height="300"
                    class="canvas-fallback"
                  />
                {/if}
                <canvas bind:this={canvasEl}></canvas>
                <div class="remote-cursors" aria-hidden="true">
                  <div class="rc" bind:this={cursor1El}>
                    <div class="rc-circle"></div>
                    <span class="rc-name">ravi</span>
                  </div>
                  <div class="rc" bind:this={cursor2El}>
                    <div class="rc-circle"></div>
                    <span class="rc-name">moss</span>
                  </div>
                </div>
              </div>
              <aside class="app-tools" aria-hidden="true">
                <button class="tool-btn selected" tabindex="-1" title="Brush">
                  <img src="/images/brush-icon.svg" alt="" />
                </button>
                <button class="tool-btn" tabindex="-1" title="Eraser">
                  <img src="/images/eraser-icon.svg" alt="" />
                </button>
                <button class="tool-btn" tabindex="-1" title="Line">
                  <img src="/images/line-icon.svg" alt="" />
                </button>
                <button class="tool-btn" tabindex="-1" title="Rectangle">
                  <img src="/images/rectangle-icon.svg" alt="" />
                </button>
                <button class="tool-btn" tabindex="-1" title="Circle">
                  <img src="/images/circle-icon.svg" alt="" />
                </button>
                <button class="tool-btn" tabindex="-1" title="Text">
                  <img src="/images/text-icon.svg" alt="" />
                </button>
                <button class="tool-btn" tabindex="-1" title="Select">
                  <img src="/images/select-icon.svg" alt="" />
                </button>
                <button class="tool-btn pepper-btn" tabindex="-1" title="DDraw">
                  <img src="/images/pepper.png" alt="" />
                </button>
                <span class="tools-divider"></span>
                <div class="swatch-stack" title="Colors">
                  <span class="swatch swatch-secondary" style="background:#c800c8"></span>
                  <span class="swatch swatch-primary" style="background:#ffdd00"></span>
                </div>
              </aside>
            </div>
          </div>
        </div>
      </div>
    </section>
  </main>
  <section class="discord-card-section">
    <div class="discord-card">
      <div>
        <h2>DDraw Discord</h2>
        <p>Share gallery posts, catch active rooms, and hang out with other people drawing.</p>
      </div>
      <a href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer" class="discord-btn">Join the Discord</a>
    </div>
  </section>

  <section id="download" class="download-card-section">
    <div class="funky-card">
      <div class="card-content">
        <h2>Desktop App!</h2>
        <p>Want it to go even faster? Grab the Windows app. It's lightweight (&lt; 20MB), has a cleaner UI and looks great on your taskbar.</p>
        <a href={WINDOWS_DOWNLOAD_URL} class="btn-primary download-btn">
          Download for Windows
        </a>
        <p class="tiny-print">v{appVersion} • Built with Tauri 2</p>
      </div>
      <div class="card-decorations">
        <div class="star s1">★</div>
        <div class="star s2">★</div>
        <div class="star s3">★</div>
      </div>
    </div>
  </section>

  <section id="features" class="features-section">
    <div class="section-header center">
      <p class="label-goofy">Wait, what is this?</p>
      <h2>Kind of neat features</h2>
    </div>
    <div class="features-grid-goofy">
      {#each features as f}
        <div class="feature-card">
          <div class="feat-preview">
            <video 
              src={f.video} 
              autoplay 
              muted 
              loop 
              playsinline
              class="rounded-lg shadow-sm"
            >
              <track kind="captions" />
              Your browser does not support the video tag.
            </video>
          </div>
          <h3>{f.title}</h3>
          <p>{f.desc}</p>
        </div>
      {/each}
    </div>
  </section>

  <section class="why-section-goofy">
    <div class="why-grid">
      {#each whyDdraw as item}
        <div class="why-item-goofy">
          <h3>{item.title}</h3>
          <p>{item.desc}</p>
        </div>
      {/each}
    </div>
  </section>

  <section class="cta-row-goofy">
    <div class="cta-inner">
      <h2>Stop reading, start drawing.</h2>
      <p>The canvas is waiting. Don't keep it hanging!</p>
      <a href="/go/" class="btn-primary giant-btn">GO GO GO!</a>
    </div>
  </section>

  <footer>
    <div class="foot-content">
      <div class="foot-left">
        <span class="wordmark">DDraw</span>
        <p>Made for the fun of it.</p>
      </div>
      <div class="foot-links">
        <a href="/gallery/">Gallery</a>
        <a href="#features">Features</a>
        <a href="#download">Download</a>
      </div>
    </div>
  </footer>

  <FeedbackWidget page="landing" />
</div>

<style>
  :global(*, *::before, *::after) { box-sizing: border-box; margin: 0; padding: 0; }
  :global(html) { scroll-behavior: smooth; }
  :global(body) {
    background: #0f0f13;
    color: #fff;
    font-family: 'Inter', sans-serif;
    font-size: 15px;
    overflow-x: hidden;
    line-height: 1.5;
  }
  
  h1, h2, h3, .wordmark, .btn-primary {
    font-family: 'Fredoka', sans-serif;
  }

  :global(a) { color: inherit; text-decoration: none; }
  
  :global(body)::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image: 
      radial-gradient(circle, rgba(255,0,255,0.05) 1px, transparent 1px),
      radial-gradient(circle, rgba(0,212,170,0.05) 1px, transparent 1px);
    background-size: 40px 40px;
    background-position: 0 0, 20px 20px;
    pointer-events: none;
    z-index: 0;
  }

  .page { position: relative; z-index: 1; opacity: 0; transition: opacity 0.4s ease; }
  .page.mounted { opacity: 1; }

  /* ── Nav ── */
  nav {
    position: fixed; top: 0; left: 0; right: 0; z-index: 100;
    display: flex; align-items: center; justify-content: space-between;
    padding: 0 2rem; height: 64px;
    background: rgba(15,15,19,0.8);
    border-bottom: 2px solid #00d4aa;
    backdrop-filter: blur(12px);
  }
  .wordmark { font-size: 22px; font-weight: 700; color: #00d4aa; transform: rotate(-2deg); }
  .nav-links { display: flex; align-items: center; gap: 2rem; font-size: 14px; font-weight: 600; }
  .nav-links a { color: rgba(255,255,255,0.7); transition: all 0.2s; }
  .nav-links a:hover { color: #c800c8; transform: scale(1.1) rotate(2deg); }
  .nav-enter { background: #00d4aa; color: #000 !important; padding: 0.5rem 1rem; border-radius: 50px; }

  /* ── Hero ── */
  .hero {
    min-height: 100vh;
    display: grid;
    grid-template-columns: 1fr 1fr;
    align-items: center;
    gap: 2rem;
    padding: 8rem 2rem 4rem;
    max-width: 1200px;
    margin: 0 auto;
  }
  .badge-float {
    display: inline-block;
    padding: 4px 12px;
    background: #ffdd00;
    color: #000;
    font-weight: 700;
    border-radius: 4px;
    transform: rotate(-5deg);
    margin-bottom: 1rem;
    font-size: 14px;
  }
  h1 { font-size: clamp(3.5rem, 8vw, 6rem); line-height: 0.9; margin-bottom: 2rem; }
  .accent { color: #00d4aa; text-shadow: 4px 4px 0px #c800c8; }
  .sub { font-size: 18px; color: rgba(255,255,255,0.6); margin-bottom: 3rem; max-width: 35ch; }
  
  .actions { display: flex; flex-direction: column; gap: 1.5rem; }
  .main-cta { font-size: 20px !important; padding: 1.2rem 2.5rem !important; border-radius: 12px !important; box-shadow: 6px 6px 0px #c800c8; }
  .main-cta:hover { transform: translate(-2px, -2px); box-shadow: 8px 8px 0px #c800c8; }
  
  .download-mini { display: flex; align-items: center; gap: 0.75rem; font-size: 14px; color: rgba(255,255,255,0.4); }
  .download-mini a { color: #00d4aa; font-weight: 600; text-decoration: underline; }

  /* ── Preview ── */
  .preview-container { position: relative; }
  .blob-bg {
    position: absolute; inset: -10%;
    background: radial-gradient(circle, #00d4aa 0%, transparent 70%);
    opacity: 0.2; filter: blur(40px);
    z-index: -1;
    animation: blobby 10s infinite alternate;
  }
  @keyframes blobby {
    0% { transform: scale(1) translate(0, 0); }
    100% { transform: scale(1.2) translate(5%, 5%); }
  }
  .preview-chrome {
    --bg-primary: #1a1d23;
    --bg-secondary: #242830;
    --bg-tertiary: #2d323c;
    --bg-elevated: #363c4a;
    --surface-glass: rgba(45, 50, 60, 0.85);
    --accent: #00d4aa;
    --accent-hover: #00e6b8;
    --text-primary: #f0f2f5;
    --text-secondary: #a0a8b8;
    --text-muted: #6b7280;
    --border-subtle: rgba(255, 255, 255, 0.08);

    background: var(--bg-primary);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 14px;
    overflow: hidden;
    transform: rotate(2deg);
    box-shadow:
      20px 20px 0px rgba(0, 212, 170, 0.25),
      0 30px 60px rgba(0, 0, 0, 0.55),
      0 0 0 1px rgba(255, 255, 255, 0.04) inset;
    font-family: 'Inter', sans-serif;
  }

  /* ── Faux app top bar (mirrors .boardBtns) ── */
  .app-topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    height: 36px;
    padding: 0 10px;
    background: var(--surface-glass);
    backdrop-filter: blur(12px);
    border-bottom: 1px solid var(--border-subtle);
  }
  .topbar-cluster {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .topbar-cluster.right { gap: 4px; }
  .topbar-divider {
    width: 1px;
    height: 16px;
    background: var(--border-subtle);
    margin: 0 2px;
  }
  .iconBtn {
    width: 24px;
    height: 24px;
    padding: 4px;
    border-radius: 6px;
    background: transparent;
    border: 1px solid transparent;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: default;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .iconBtn.small { width: 22px; height: 22px; padding: 3px; }
  .iconBtn img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    filter: brightness(0) invert(0.65);
  }
  .iconBtn:hover {
    background: rgba(255, 255, 255, 0.06);
    border-color: var(--border-subtle);
  }
  .iconBtn:hover img { filter: brightness(0) invert(0.95); }
  .zoom-pct {
    font-size: 11px;
    font-variant-numeric: tabular-nums;
    color: var(--text-secondary);
    padding: 0 4px;
    font-weight: 500;
  }
  .ddraw-letters {
    display: flex;
    align-items: baseline;
    gap: 2px;
    font-family: 'Fredoka', sans-serif;
    font-weight: 700;
    font-size: 15px;
    letter-spacing: -0.02em;
    user-select: none;
    padding-right: 2px;
  }
  .ltr {
    display: inline-block;
    line-height: 1;
    transform-origin: center;
  }
  .ltr.l-d1 { color: #00d4aa; transform: rotate(-6deg) translateY(-1px); }
  .ltr.l-d2 { color: #ffdd00; transform: rotate(4deg); }
  .ltr.l-r  { color: #ff7ad6; transform: rotate(-3deg) translateY(1px); }
  .ltr.l-a  { color: #00d4aa; transform: rotate(5deg); }
  .ltr.l-w  { color: #c800c8; transform: rotate(-4deg) translateY(-1px); }

  /* ── App body: canvas + tools rail ── */
  .app-body {
    display: flex;
    flex-direction: row;
    background: var(--bg-primary);
    aspect-ratio: 1.55;
  }
  .canvas-wrap {
    position: relative;
    flex: 1 1 auto;
    background: #fdfdfa;
    overflow: hidden;
    container-type: inline-size;
  }
  .canvas-grid {
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(rgba(0, 0, 0, 0.04) 1px, transparent 1px),
      linear-gradient(90deg, rgba(0, 0, 0, 0.04) 1px, transparent 1px);
    background-size: 24px 24px;
    pointer-events: none;
    z-index: 0;
  }
  .canvas-fallback {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    z-index: 1;
  }
  canvas {
    position: relative;
    width: 100%;
    height: 100%;
    z-index: 2;
  }

  /* ── Remote cursors (mirrors real app .cursor / .name styling) ──
     Position is JS-driven (set via .style.left/top) for perfect sync with
     the stroke animation. Circle size matches the stroke width via cqw. */
  .remote-cursors {
    position: absolute;
    inset: 0;
    z-index: 3;
    pointer-events: none;
  }
  .rc {
    position: absolute;
    left: 0;
    top: 0;
    opacity: 0;
    --rc-size-vp: 10;
  }
  .rc-circle {
    position: absolute;
    /* Center the circle on .rc's anchor (which is the cursor tip). */
    transform: translate(-50%, -50%);
    /* Diameter in screen px = (stroke virtual size) * canvas-wrap width / 480 */
    width: calc(var(--rc-size-vp) * 100cqw / 480);
    height: calc(var(--rc-size-vp) * 100cqw / 480);
    border-radius: 50%;
    border: 1.2px solid #3a4150;
    box-sizing: border-box;
  }
  .rc-name {
    position: absolute;
    top: calc(var(--rc-size-vp) * 50cqw / 480 + 2px);
    left: calc(var(--rc-size-vp) * 55cqw / 480 + 2px);
    font-family: 'Inter', sans-serif;
    font-size: 11px;
    font-weight: 500;
    color: rgba(47, 55, 69, 0.55);
    text-shadow: 0 0 1px rgba(255, 255, 255, 0.55);
    white-space: nowrap;
  }
  /* ── Tools rail (mirrors real .tools panel) ── */
  .app-tools {
    width: 44px;
    flex-shrink: 0;
    background: var(--bg-secondary);
    border-left: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 6px 0;
  }
  .tool-btn {
    width: 32px;
    height: 32px;
    padding: 5px;
    border-radius: 8px;
    background: transparent;
    border: 1px solid transparent;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    cursor: default;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .tool-btn img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    filter: brightness(0) invert(0.65);
    transition: filter 0.15s ease;
  }
  .tool-btn:hover {
    background: rgba(255, 255, 255, 0.06);
  }
  .tool-btn:hover img { filter: brightness(0) invert(0.95); }
  .tool-btn.selected {
    background: var(--bg-elevated);
    border-color: rgba(0, 212, 170, 0.35);
    box-shadow: 0 0 0 1px rgba(0, 212, 170, 0.15) inset;
  }
  .tool-btn.selected img {
    filter: brightness(0) saturate(100%) invert(0) sepia(52%) saturate(1000%) hue-rotate(115deg) brightness(95%) contrast(101%);
  }
  .tool-btn.pepper-btn img {
    filter: none;
  }
  .tool-btn.pepper-btn:hover img {
    filter: drop-shadow(0 0 6px rgba(255, 100, 100, 0.5));
  }
  .tools-divider {
    width: 24px;
    height: 1px;
    background: var(--border-subtle);
    margin: 4px 0;
  }
  .swatch-stack {
    position: relative;
    width: 32px;
    height: 32px;
    margin-top: 2px;
  }
  .swatch {
    position: absolute;
    width: 18px;
    height: 18px;
    border-radius: 4px;
    border: 1.5px solid var(--bg-secondary);
    box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.1);
  }
  .swatch-secondary {
    bottom: 2px;
    right: 2px;
  }
  .swatch-primary {
    top: 2px;
    left: 2px;
    z-index: 2;
  }

  /* ── Funky Download Card ── */
  .discord-card-section { padding: 2rem 2rem 0; max-width: 1200px; margin: 0 auto; }
  .discord-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 2rem;
    background: #5865f2;
    border: 3px solid #fff;
    border-radius: 20px;
    box-shadow: 0 16px 34px rgba(88,101,242,0.28);
  }
  .discord-card h2 { font-size: 2.2rem; margin-bottom: 0.4rem; }
  .discord-card p { max-width: 48ch; color: rgba(255,255,255,0.82); }
  .discord-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 0.9rem 1.4rem;
    background: #fff;
    color: #5865f2;
    border-radius: 12px;
    font-family: 'Fredoka', sans-serif;
    font-weight: 700;
    white-space: nowrap;
    transition: all 0.2s;
  }
  .discord-btn:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(0,0,0,0.18); }
  .download-card-section { padding: 2rem 2rem 4rem; max-width: 1200px; margin: 0 auto; }
  .funky-card {
    background: #c800c8;
    border-radius: 24px;
    padding: 4rem 2rem;
    position: relative;
    overflow: hidden;
    color: #fff;
    text-align: center;
    border: 4px solid #fff;
    box-shadow: 0 20px 40px rgba(255,0,255,0.3);
  }
  .card-content { position: relative; z-index: 2; max-width: 500px; margin: 0 auto; }
  .funky-card h2 { font-size: 3rem; margin-bottom: 1rem; }
  .funky-card p { font-size: 18px; margin-bottom: 2.5rem; opacity: 0.9; }
  .download-btn { background: #fff !important; color: #c800c8 !important; font-size: 18px !important; padding: 1rem 2rem !important; }
  .tiny-print { font-size: 12px !important; margin-top: 2rem; opacity: 0.7; }
  
  .card-decorations .star { position: absolute; color: #ffdd00; font-size: 2rem; }
  .s1 { top: 10%; left: 10%; transform: rotate(-15deg); }
  .s2 { bottom: 15%; right: 12%; transform: rotate(20deg); }
  .s3 { top: 20%; right: 15%; font-size: 1rem !important; }

  /* ── Features ── */
  .features-section { padding: 8rem 2rem; max-width: 1200px; margin: 0 auto; }
  .label-goofy { color: #ffdd00; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 1rem; }
  .features-grid-goofy {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 1.5rem;
    margin-top: 3rem;
    max-width: 800px;
    margin-left: auto;
    margin-right: auto;
  }
  .feature-card {
    background: rgba(255,255,255,0.03);
    padding: 1.25rem;
    border-radius: 16px;
    border: 2px solid rgba(255,255,255,0.1);
    transition: all 0.3s;
  }
  .feature-card:hover {
    border-color: #00d4aa;
    transform: translateY(-5px) rotate(1deg);
    background: rgba(0,212,170,0.05);
  }
.feat-preview {
  width: 100%;
  /* Set your desired aspect ratio (e.g., 16/9, 4/3, or 1/1) */
  aspect-ratio: 3 / 4; 
  
  background-color: white; /* This fills the "letterbox" gaps */
  margin-bottom: 1rem;
  border-radius: 8px;
  overflow: hidden;
  border: 2px solid rgba(255,255,255,0.1);
  
  /* Centers the video if it's smaller than the box */
  display: flex;
  align-items: center;
  justify-content: center;
}

.feat-preview video {
  width: 100%;
  height: 100%;
  /* 'contain' keeps the whole video visible without stretching */
  object-fit: contain; 
  display: block;
}
  .feature-card h3 { font-size: 1.25rem; margin-bottom: 0.75rem; color: #00d4aa; }
  .feature-card p { color: rgba(255,255,255,0.5); font-size: 13px; line-height: 1.5; }

  /* ── Why Section ── */
  .why-section-goofy { padding: 4rem 2rem; border-top: 2px dashed #333; }
  .why-grid {
    max-width: 1200px; margin: 0 auto;
    display: flex; flex-wrap: wrap; justify-content: center; gap: 4rem;
  }
  .why-item-goofy { text-align: center; max-width: 300px; }
  .why-item-goofy h3 { font-size: 1.8rem; margin-bottom: 1rem; color: #c800c8; }
  .why-item-goofy p { color: rgba(255,255,255,0.4); }

  /* ── CTA ── */
  .cta-row-goofy { padding: 8rem 2rem; text-align: center; }
  .cta-inner {
    background: #00d4aa;
    padding: 5rem 2rem;
    border-radius: 40px;
    color: #000;
    max-width: 900px;
    margin: 0 auto;
    transform: rotate(-1deg);
  }
  .giant-btn { background: #000 !important; color: #00d4aa !important; font-size: 24px !important; margin-top: 2rem; }

  /* ── Footer ── */
  footer { padding: 4rem 2rem; border-top: 2px solid #333; }
  .foot-content {
    max-width: 1200px; margin: 0 auto;
    display: flex; justify-content: space-between; align-items: flex-start;
  }
  .foot-left .wordmark { display: block; margin-bottom: 0.5rem; }
  .foot-left p { font-size: 13px; color: #555; }
  .foot-links { display: flex; gap: 2rem; font-weight: 600; font-size: 14px; }
  .foot-links a { color: #777; }
  .foot-links a:hover { color: #00d4aa; }

  .btn-primary {
    display: inline-block;
    padding: 0.8rem 1.8rem;
    background: #00d4aa;
    color: #000;
    font-weight: 700;
    text-transform: uppercase;
    border: none;
    cursor: pointer;
    transition: all 0.2s;
  }

  .center { text-align: center; }

  @media (max-width: 900px) {
    .hero { grid-template-columns: 1fr; text-align: center; padding-top: 6rem; }
    .hero-text { order: 1; display: flex; flex-direction: column; align-items: center; }
    .hero-preview { order: 2; max-width: 500px; margin: 0 auto; }
    .discord-card { flex-direction: column; align-items: flex-start; }
    .discord-btn { width: 100%; }
    .foot-content { flex-direction: column; gap: 2rem; align-items: center; text-align: center; }
  }
</style>
