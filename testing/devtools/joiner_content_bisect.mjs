#!/usr/bin/env node
/**
 * @fileoverview Tier 1.2 — which CLASS of content does a joiner fail to rebuild?
 *
 * A late joiner on the real checkpoint+tail path lands at 93.967% (pixels), and
 * nothing has ever localised that residual to a *kind* of content. The tape's
 * `droppedByType` from the ad-hoc (no-checkpoint) case hints at selection and
 * fill — `SEL_LIFT`/`SEL_COMMIT` 289 each, `FILL` 267, `UNDO` 127 — but that is a
 * hint, not evidence: under a checkpoint those counts are meaningless, because
 * everything at or below the checkpoint seq arrives as a flat image and never
 * appears on the joiner's tape at all.
 *
 * So bisect it by feeding one class at a time and reading the pixel diff, which
 * IS valid under a checkpoint. This iterates on the fast joiner case rather than
 * on 12-minute AFK idles — same rebuild machinery, a fifth of the wall time.
 *
 * ── WHAT THE FIRST FULL RUN ACTUALLY SHOWED (2026-08-09) ───────────────────
 * Not a content-type effect. Every class landed in the same 86-89% band, and
 * the one step that came back clean (selection, 99.954%) is explained by TAIL
 * LENGTH, not by its content:
 *
 *     plain 141 commits → 87.562%      selection   3 commits → 99.954%
 *     blend 121 commits → 85.983%      undo      198 commits → 88.613%
 *     fill  132 commits → 88.167%
 *
 * Its joiner happened to arrive just after a checkpoint minted and replayed 3
 * commands instead of 121-198. So **the checkpoint image is faithful and the
 * replayed tail is where the joiner diverges** — and note it looks like a STEP,
 * not a curve: inside the 121-198 range the error does not order by tail length
 * at all. That points at something systematically wrong with tail replay (a
 * mishandled type, or the state preamble it starts from) rather than error
 * accumulating per command.
 *
 * Tail length is therefore reported per step, because it is not controlled here
 * — it depends on where the joiner lands relative to the last mint — and reading
 * the content axis without it invites a causal conclusion the data does not
 * support. The follow-up this wants is a run that fixes the content and varies
 * the tail deliberately.
 *
 * EACH STEP RUNS AGAINST A FRESHLY WIPED BACKEND, and — the part that is easy to
 * forget and fatal to forget — RESTARTS THE SERVER. Rooms live in server memory
 * (strokeLog, checkpoints, session indices), so a process that outlives
 * `docker compose down -v` still holds the previous step's lobby and the next
 * step is not a clean-room run. Every number here would then carry the last
 * config's content.
 *
 *   node testing/devtools/joiner_content_bisect.mjs
 *   node testing/devtools/joiner_content_bisect.mjs --waves=3
 *   node testing/devtools/joiner_content_bisect.mjs --only=plain,selection
 *   node testing/devtools/joiner_content_bisect.mjs --no-reset   (reuse backend)
 */

import { spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Each step is "plain strokes PLUS exactly one class", not a cumulative ladder —
// so a drop names its class directly instead of implicating everything added so
// far. `all` at the end reproduces the default feed as the reference point.
//
// This needs the feed's SPECIAL_ONLY knob. SPECIAL_CHANCE and NO_BLEND alone
// cannot express it: every special action, blendSwap included, fires through the
// one SPECIAL_CHANCE gate, so turning that off removes all of them at once and
// NO_BLEND on top is a no-op.
const STEPS = [
  { name: 'plain',     env: ['--special-chance=0'],                                    adds: 'strokes, shapes, text only' },
  { name: 'blend',     env: ['--special-chance=0.15', '--special-only=blendSwap'],      adds: 'per-stroke blend modes' },
  { name: 'fill',      env: ['--special-chance=0.15', '--special-only=floodFill'],      adds: 'flood fill' },
  { name: 'selection', env: ['--special-chance=0.15', '--special-only=selectionTransform'], adds: 'selection lift/move/commit' },
  { name: 'undo',      env: ['--special-chance=0.15', '--special-only=undo'],           adds: 'undo' },
  { name: 'all',       env: ['--special-chance=0.15'],                                  adds: 'the default mix (reference)' },
];

let WAVES = 3;
let ONLY = null;
let RESET = true;
let VUS = null;
for (const a of process.argv.slice(2)) {
  if (a === '--no-reset') RESET = false;
  else if (a.startsWith('--waves=')) WAVES = Math.max(1, Number(a.slice(8)));
  else if (a.startsWith('--vus=')) VUS = a.slice(6);
  else if (a.startsWith('--only=')) ONLY = a.slice(7).split(',').map((s) => s.trim()).filter(Boolean);
  else { console.error(`Unknown flag: ${a}`); process.exit(2); }
}
const plan = STEPS.filter((s) => !ONLY || ONLY.includes(s.name));
if (plan.length === 0) { console.error(`--only matched no steps. Known: ${STEPS.map((s) => s.name).join(', ')}`); process.exit(2); }

const LOG_DIR = path.join(ROOT, 'testing', 'sync_results',
  `bisect_${new Date().toISOString().replace(/[:.]/g, '-')}`);

function run(cmd, args, { cwd = ROOT, quiet = false } = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  if (!quiet) process.stdout.write(out);
  return { code: r.status, out };
}

/**
 * Run a step's suite, capturing output to a FILE rather than a pipe.
 *
 * `spawnSync` with piped stdio only returns once the pipe reaches EOF, and the
 * pipe is inherited by every descendant — so a lingering npm wrapper (routine on
 * Windows) keeps it open long after the suite itself has exited and the bisect
 * hangs forever mid-run. Observed: the `plain` step printed its full result and
 * then sat for 8+ minutes with no child left alive but an npm shim.
 *
 * Redirecting to a file removes the EOF dependency, and invoking node directly
 * instead of `npm run` removes the shim layers that cause it.
 */
function runSuiteToFile(scriptRelPath, args, logPath) {
  const fd = fs.openSync(logPath, 'w');
  try {
    const r = spawnSync(process.execPath, [scriptRelPath, ...args],
      { cwd: ROOT, stdio: ['ignore', fd, fd], shell: false, timeout: 20 * 60_000 });
    return { code: r.status, timedOut: r.error?.code === 'ETIMEDOUT' };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Kill whatever holds :8030 — the previous step's server, holding its rooms.
 *
 * Two mechanisms because either alone leaks: `taskkill /T` on the spawned root
 * takes down the npm + cross-env shims that `npm run server:local` layers on top
 * (six steps would otherwise strand a dozen of them), while the port lookup
 * catches a server this process did not start.
 */
function killServer(child = null) {
  if (child?.pid && process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
  } else if (child?.pid) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
  if (process.platform === 'win32') {
    const r = spawnSync('powershell', ['-NoProfile', '-Command',
      "(Get-NetTCPConnection -LocalPort 8030 -State Listen -ErrorAction SilentlyContinue).OwningProcess "
      + "| Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"],
      { encoding: 'utf8' });
    return r.status === 0;
  }
  spawnSync('sh', ['-c', "lsof -ti tcp:8030 | xargs -r kill -9"], { encoding: 'utf8' });
  return true;
}

/** Start `npm run server:local` and resolve once it is actually listening. */
async function startServer(logFile) {
  const fd = fs.openSync(logFile, 'a');
  const child = spawn('npm', ['run', 'server:local'], {
    cwd: ROOT, shell: true, stdio: ['ignore', fd, fd], detached: false,
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await sleep(1000);
    const txt = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (/WebSocket server running/.test(txt)) {
      if (/Snapshot storage is not fully configured/.test(txt)) {
        throw new Error('server booted WITHOUT snapshot storage — every checkpoint measurement would be invalid');
      }
      await sleep(1500);
      return child;
    }
    if (child.exitCode != null) throw new Error(`server exited ${child.exitCode} — see ${logFile}`);
  }
  throw new Error(`server did not report "WebSocket server running" within 60s — see ${logFile}`);
}

async function main() {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  console.log(`\nJoiner residual — bisect by content type`);
  console.log(`Steps:   ${plan.map((s) => s.name).join(' → ')}`);
  console.log(`Feed:    ${WAVES} wave(s) per step, room=lobby (real checkpoint+tail join path)`);
  console.log(`Backend: ${RESET ? 'wiped AND server restarted before every step' : 'reused (--no-reset)'}`);
  console.log(`Logs:    ${path.relative(process.cwd(), LOG_DIR)}\n`);

  const results = [];
  let server = null;
  try {
    for (const step of plan) {
      console.log('─'.repeat(70));
      console.log(`STEP ${step.name}   (+ ${step.adds})`);
      console.log('─'.repeat(70));

      const serverLogPath = path.join(LOG_DIR, `server_${step.name}.log`);
      if (RESET) {
        killServer(server);
        server = null;
        await sleep(1500);
        const reset = run('npm', ['run', 'dev:reset'], { quiet: true });
        if (reset.code !== 0) throw new Error(`dev:reset failed for step ${step.name}`);
        console.log(`  backend wiped`);
        server = await startServer(serverLogPath);
        console.log(`  server restarted on the clean backend`);
      }

      const logPath = path.join(LOG_DIR, `k6obs_${step.name}.log`);
      const args = ['--join', '--room=lobby', `--waves=${WAVES}`,
        ...(VUS ? [`--vus=${VUS}`] : []), ...step.env];
      const sr = runSuiteToFile(path.join('testing', 'devtools', 'k6_lowstress_observers.mjs'), args, logPath);
      if (sr.timedOut) console.log(`  ⚠ step timed out after 20 min — see ${path.basename(logPath)}`);
      const out = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
      const r = { out };

      // Prefer summary.json — the printed line is for humans, the file is data.
      const dir = r.out.match(/Results:\s*(.+?)\s*$/m)?.[1]?.trim();
      let pixel = null, checkpoint = null, controls = null;
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8'));
        pixel = s?.lateJoin?.pixel?.matchPct ?? null;
        controls = s?.pairs ?? s?.finalDiffs ?? null;
      } catch { /* fall through to the printed line */ }
      if (pixel == null) pixel = Number(r.out.match(/pixels A↔J:\s*([\d.]+)%/)?.[1] ?? NaN);
      checkpoint = /not applicable — a checkpoint was served/.test(r.out)
        || /checkpoint served: yes/.test(r.out);

      // How much TAIL did the joiner have to replay? This is not a control
      // variable — it depends on where the joiner happened to land relative to
      // the last checkpoint mint — but it turned out to explain the results far
      // better than the content class did (2026-08-09: 141/121/132 commits →
      // 86-88%, versus 3 commits → 99.954%). Report it, or the content axis gets
      // read as causal when the timing is doing the work.
      const tailLine = [...(fs.existsSync(serverLogPath) ? fs.readFileSync(serverLogPath, 'utf8') : '')
        .matchAll(/Replayed tail \(\d+, \d+\] to \d+: (\d+) commits/g)].pop();
      const tailCommits = tailLine ? Number(tailLine[1]) : null;

      results.push({ step: step.name, adds: step.adds, pixel, checkpoint, tailCommits, dir });
      console.log(`  → A↔J ${Number.isFinite(pixel) ? pixel.toFixed(3) + '%' : 'n/a'}`
        + `   tail replayed: ${tailCommits ?? '?'} commits`
        + `   checkpoint served: ${checkpoint ? 'yes' : 'NO — NOT ATTRIBUTABLE'}`);
      if (controls) console.log(`     controls: ${JSON.stringify(controls)}`);
    }
  } finally {
    if (server && server.exitCode == null) { /* leave it up: the next thing to run needs it */ }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  step          adds                                        A↔J pixels   tail`);
  for (const r of results) {
    console.log(`  ${r.step.padEnd(12)}  ${r.adds.padEnd(42)}  `
      + `${(Number.isFinite(r.pixel) ? r.pixel.toFixed(3) + '%' : 'n/a').padStart(9)}`
      + `${String(r.tailCommits ?? '?').padStart(7)}`
      + `${r.checkpoint ? '' : '   ⚠ no checkpoint'}`);
  }
  console.log('═'.repeat(70));

  const valid = results.filter((r) => Number.isFinite(r.pixel) && r.checkpoint);
  if (valid.length >= 2) {
    // Name the step with the largest drop from its predecessor — that is the
    // class of content the rebuild loses, which is the whole point of the run.
    let worst = null;
    for (let i = 1; i < valid.length; i++) {
      const drop = valid[i - 1].pixel - valid[i].pixel;
      if (!worst || drop > worst.drop) worst = { drop, from: valid[i - 1], to: valid[i] };
    }
    if (valid[0].pixel >= 99.5) {
      console.log(`\n  Baseline "${valid[0].step}" rebuilds correctly (${valid[0].pixel.toFixed(3)}%),`);
      console.log(`  so the joiner residual is NOT a general rebuild failure.`);
    } else {
      console.log(`\n  Baseline "${valid[0].step}" ALREADY fails (${valid[0].pixel.toFixed(3)}%) —`);
      console.log(`  plain strokes/shapes/text are enough to reproduce it, and the`);
      console.log(`  richer classes below are not the cause.`);
    }
    if (worst && worst.drop > 0.5) {
      console.log(`  Largest single drop: ${worst.from.step} → ${worst.to.step} `
        + `(${worst.from.pixel.toFixed(3)}% → ${worst.to.pixel.toFixed(3)}%, −${worst.drop.toFixed(3)})`);
      console.log(`  ⇒ suspect: ${worst.to.adds}`);
    }
  }
  console.log(`\nLogs + per-step results: ${LOG_DIR}`);
  process.exitCode = 0;
}

main().catch((e) => { console.error('\nBisect aborted:', e.message); process.exit(2); });
