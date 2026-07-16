<script>
  import FeedbackWidget from '../ui/svelte/FeedbackWidget.svelte';

  let mounted = $state(false);
  let appVersion = $state(typeof window !== 'undefined' ? window.APP_VERSION || '1.10.3' : '1.10.3');

  $effect(() => {
    mounted = true;
  });

  // Placeholder: swap for a real curated art timelapse (Phase 1 content capture).
  const HERO_TIMELAPSE_URL = 'https://assets.ddraw.ca/drawing.mp4';

  // Only play marquee videos while they're on screen (8 <video> els after duplication).
  function playInView(video) {
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting) e.target.play().catch(() => {});
        else e.target.pause();
      }
    }, { rootMargin: '100px' });
    io.observe(video);
    return { destroy: () => io.disconnect() };
  }

  // Top-liked gallery pieces (see public/images/landing-art/manifest.json to refresh)
  const galleryArt = [
    { file: 'art-1.png', id: '69def5f3f8a0b70b603f16b2', author: 'maim', tilt: -3 },
    { file: 'art-2.png', id: '69e94aaadee71eca2830b59e', author: 'Towa', tilt: 2 },
    { file: 'art-3.png', id: '69dac8946a423563454fb374', author: 'sassysince1969', tilt: -1.5 },
    { file: 'art-4.png', id: '69ed7628262018b8d40ec4d4', author: 'pemi', tilt: 2.5 },
    { file: 'art-5.png', id: '69ed76b4262018b8d40ec4d5', author: 'Towa', tilt: -2 },
    { file: 'art-6.png', id: '69ed35a4262018b8d40ec488', author: 'maim', tilt: 1.5 },
    { file: 'art-7.png', id: '69e9678dbba6d2220801c3cf', author: 'Thoth', tilt: -2.5 },
    { file: 'art-8.png', id: '69e58e914caf3734139e5ec4', author: 'pemi', tilt: 2 },
  ];

  const features = [
    { video: 'https://assets.ddraw.ca/drawing.mp4', title: 'Smooth Drawing', desc: 'Designed to make every stroke feel smooth and responsive, runs at a crisp 60 FPS, and keeps everyone in sync and drawing without a hitch.' },
    { video: 'https://assets.ddraw.ca/mirror.mp4', title: 'Mirrored Regions', desc: 'Can\'t draw a face? Just draw half! Our mirror modes applies region based reflections on the canvas perfect for symmetrical pieces with zero effort.' },
    { video: 'https://assets.ddraw.ca/pattern.mp4', title: 'Customizable Patterns', desc: 'Why use a normal brush when you can paint with patterns? Stamp your art with custom textures or use the image brush to paint with whatever!' },
    { video: 'https://assets.ddraw.ca/homography.mp4', title: 'The Selector', desc: 'Grab a chunk of the canvas, wiggle it around, resize it, or stamp it a thousand times. The selection tool is fast, accurate, and lets you rearrange reality however you like.' },
  ];

  const whyDdraw = [
    { title: 'Privacy First', desc: 'Your secrets are safe with us. Our messenger uses end-to-end encryption, and rooms are ephemeral.' },
    { title: 'No Nonsense', desc: 'No paywalls, no "premium brushes," and no annoying ads. It\'s a pure creative space built for the love of digital art.' },
  ];

  // One marquee "half" must be wider than any viewport for a seamless -50% loop,
  // so each half carries the feature list twice.
  const marqueeItems = [...features, ...features];

  const WINDOWS_DOWNLOAD_URL = 'https://www.ddraw.ca/download';
  const DISCORD_INVITE_URL = 'https://discord.gg/aKp4Ew7V7a';
</script>

<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="">
<link rel="preload" href={HERO_TIMELAPSE_URL} as="video" type="video/mp4">
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;600;700&family=Inter:wght@400;600&display=swap" rel="stylesheet">

<div class="page" class:mounted>
  <nav>
    <div class="nav-left">
      <a href="/" class="wordmark">DDraw!</a>
    </div>
    <div class="nav-links">
      <a href="#features">cool stuff</a>
      <a href="#download">get app</a>
      <a href="/gallery/" target="_blank">gallery</a>
      <a href="/messenger/" target="_blank">messenger</a>
      <a href="/go/" class="nav-enter">Draw Now! →</a>
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
                <video
                  class="hero-timelapse"
                  src={HERO_TIMELAPSE_URL}
                  poster="/images/preview-fallback.png"
                  autoplay
                  muted
                  loop
                  playsinline
                  aria-label="Timelapse of art being drawn in DDraw"
                ></video>
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

  <section id="features" class="marquee-section" aria-label="Feature previews">
    <div class="section-header center">
      <p class="label-goofy">Wait, what is this?</p>
      <h2>Kind of neat features</h2>
    </div>
    <div class="marquee">
      <div class="marquee-track">
        {#each [...marqueeItems, ...marqueeItems] as f, i}
          <div class="marquee-card" class:marquee-dupe={i >= marqueeItems.length} aria-hidden={i >= marqueeItems.length}>
            <video
              src={f.video}
              muted
              loop
              playsinline
              preload="metadata"
              use:playInView
            ></video>
            <div class="marquee-caption">
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          </div>
        {/each}
      </div>
    </div>
  </section>

  <section class="art-strip-section">
    <div class="section-header center">
      <p class="label-goofy">Made in DDraw</p>
      <h2>Arts</h2>
    </div>
    <div class="art-strip">
      {#each galleryArt as a}
        <a class="art-card" href="/gallery/{a.id}" style="--tilt: {a.tilt}deg;">
          <img src="/images/landing-art/{a.file}" alt="Artwork by {a.author}" loading="lazy" />
          <span class="art-author">by {a.author}</span>
        </a>
      {/each}
    </div>
    <div class="art-strip-cta">
      <a href="/gallery/" class="btn-primary gallery-btn">Visit the Gallery →</a>
    </div>
  </section>

  <section class="discord-card-section">
    <div class="discord-card">
      <div>
        <h2>DDraw Discord</h2>
        <p>Share gallery posts, catch active rooms, and hang out with other people drawing.</p>
      </div>
      <a href={DISCORD_INVITE_URL} target="_blank" rel="noopener noreferrer" class="discord-btn">Join the Discord</a>
    </div>
  </section>

  <section class="messenger-card-section">
    <div class="messenger-card">
      <div>
        <h2>DDraw Messenger</h2>
        <p>End-to-end encrypted chat for the friends you draw with. Sign in once, then message privately — no servers reading your mail, no ads.</p>
      </div>
      <a href="/messenger/" class="messenger-btn">Open Messenger →</a>
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
        <a href="/messenger/">Messenger</a>
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
  .wordmark { display: inline-block; font-size: 22px; font-weight: 700; color: #00d4aa; transform: rotate(-2deg); }
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
  .hero-timelapse {
    position: relative;
    width: 100%;
    height: 100%;
    object-fit: cover;
    z-index: 1;
    display: block;
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

  .messenger-card-section { padding: 2rem 2rem 0; max-width: 1200px; margin: 0 auto; }
  .messenger-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    padding: 2rem;
    background: #00d4aa;
    border: 3px solid #fff;
    border-radius: 20px;
    box-shadow: 0 16px 34px rgba(0,212,170,0.28);
    color: #0f0f13;
  }
  .messenger-card h2 { font-size: 2.2rem; margin-bottom: 0.4rem; }
  .messenger-card p { max-width: 48ch; color: rgba(15,15,19,0.78); }
  .messenger-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 48px;
    padding: 0.9rem 1.4rem;
    background: #0f0f13;
    color: #00d4aa;
    border-radius: 12px;
    font-family: 'Fredoka', sans-serif;
    font-weight: 700;
    white-space: nowrap;
    transition: all 0.2s;
  }
  .messenger-btn:hover { transform: translateY(-2px); box-shadow: 0 10px 24px rgba(0,0,0,0.18); }

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

  /* ── Feature marquee ── */
  .label-goofy { color: #ffdd00; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; margin-bottom: 1rem; }
  .marquee-section { padding: 5rem 0 2rem; overflow: hidden; }
  .marquee-section .section-header { padding: 0 2rem; margin-bottom: 2.5rem; }
  /* Vertical padding so the ±1.2deg card tilt isn't clipped by overflow: hidden */
  .marquee { overflow: hidden; padding: 12px 0; }
  .marquee-track {
    display: flex;
    width: max-content;
    animation: marquee-scroll 60s linear infinite;
  }
  .marquee:hover .marquee-track { animation-play-state: paused; }
  @keyframes marquee-scroll {
    to { transform: translateX(-50%); }
  }
  .marquee-card {
    position: relative;
    width: clamp(220px, 24vw, 300px);
    aspect-ratio: 3 / 4;
    margin-right: 1.5rem;
    flex-shrink: 0;
    border-radius: 16px;
    border: 2px solid rgba(255,255,255,0.1);
    overflow: hidden;
    background: #fff;
    transform: rotate(-1.2deg);
    transition: border-color 0.3s;
  }
  .marquee-card:nth-child(even) { transform: rotate(1.2deg); }
  .marquee-card:hover { border-color: #00d4aa; }
  .marquee-card video {
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
    background: #fff;
  }
  .marquee-caption {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    padding: 2.5rem 1rem 0.9rem;
    background: linear-gradient(transparent, rgba(15,15,19,0.92) 65%);
  }
  .marquee-caption h3 { color: #00d4aa; font-size: 1.15rem; margin-bottom: 0.25rem; }
  .marquee-caption p {
    color: rgba(255,255,255,0.75);
    font-size: 12px;
    line-height: 1.45;
    max-height: 0;
    opacity: 0;
    overflow: hidden;
    transition: max-height 0.3s ease, opacity 0.3s ease;
  }
  .marquee-card:hover .marquee-caption p { max-height: 8em; opacity: 1; }
  @media (prefers-reduced-motion: reduce) {
    .marquee-track { animation: none; width: auto; }
    .marquee { overflow-x: auto; scroll-snap-type: x mandatory; padding: 12px 2rem 1rem; }
    .marquee-card { scroll-snap-align: center; }
    .marquee-card.marquee-dupe { display: none; }
  }

  /* ── Art strip (Made in DDraw) ── */
  .art-strip-section { padding: 4rem 2rem; max-width: 1200px; margin: 0 auto; }
  .art-strip {
    display: flex;
    justify-content: center;
    flex-wrap: wrap;
    gap: 1.25rem;
    margin-top: 2.5rem;
    /* Fits 4 cards per row → balanced 4+4 with 8 pieces */
    max-width: 800px;
    margin-left: auto;
    margin-right: auto;
  }
  .art-card {
    position: relative;
    width: 170px;
    aspect-ratio: 4 / 5;
    background: #fdfdfa;
    border: 3px solid rgba(255,255,255,0.85);
    border-radius: 10px;
    overflow: hidden;
    transform: rotate(var(--tilt));
    display: block;
    box-shadow: 0 10px 24px rgba(0,0,0,0.4);
    transition: transform 0.25s ease;
  }
  .art-card:hover { transform: rotate(0deg) scale(1.06); z-index: 2; }
  .art-card img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .art-author {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    padding: 1.4rem 0.6rem 0.45rem;
    background: linear-gradient(transparent, rgba(15,15,19,0.85));
    font-family: 'Fredoka', sans-serif;
    font-weight: 600;
    font-size: 12px;
    color: #fff;
    opacity: 0;
    transition: opacity 0.25s ease;
  }
  .art-card:hover .art-author { opacity: 1; }
  .art-strip-cta { text-align: center; margin-top: 2.5rem; }
  .gallery-btn { border-radius: 12px; }

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
    .messenger-card { flex-direction: column; align-items: flex-start; }
    .messenger-btn { width: 100%; }
    .foot-content { flex-direction: column; gap: 2rem; align-items: center; text-align: center; }
  }
</style>
