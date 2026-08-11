#!/usr/bin/env node
/**
 * @fileoverview Wipe and re-seed the isolated local dev backend.
 *
 * Parity measurements are only attributable against a room whose history the
 * test itself created. Every headline number in `docs/afk_parity_session_2026-08-08.md`
 * was taken against a `lobby` that still held content from earlier runs in the
 * same session, which is why they are all marked provisional.
 *
 * This drops the Mongo + MinIO volumes, brings the stack back up and waits until
 * both buckets exist, so "clean room" is one command instead of four remembered
 * ones. It touches ONLY the `tdraw-dev-*` containers and the compose volumes —
 * production Atlas / R2 are never contacted.
 *
 *   npm run dev:reset
 *   npm run dev:reset -- --keep-data    (restart without dropping volumes)
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COMPOSE = ['compose', '-f', path.join(ROOT, 'docker-compose.dev.yml')];
const KEEP = process.argv.includes('--keep-data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function docker(args, { quiet = false } = {}) {
  const r = spawnSync('docker', args, { encoding: 'utf8', shell: process.platform === 'win32' });
  if (!quiet && r.stdout?.trim()) process.stdout.write(r.stdout);
  if (!quiet && r.stderr?.trim()) process.stderr.write(r.stderr);
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

async function waitFor(name, fn, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  process.stdout.write(`  waiting for ${name} `);
  while (Date.now() < deadline) {
    if (fn()) { console.log('✓'); return true; }
    process.stdout.write('.');
    await sleep(1000);
  }
  console.log(' ✗');
  return false;
}

async function main() {
  if (docker(['version', '--format', '{{.Server.Version}}'], { quiet: true }).code !== 0) {
    console.error('Docker engine is not reachable. Start Docker Desktop and retry.');
    process.exit(2);
  }

  console.log(`\nLocal dev backend — ${KEEP ? 'restart (data kept)' : 'WIPE and re-seed'}`);
  console.log(`  compose: ${path.relative(process.cwd(), path.join(ROOT, 'docker-compose.dev.yml'))}\n`);

  console.log(KEEP ? '· stopping …' : '· dropping containers AND volumes …');
  docker([...COMPOSE, 'down', ...(KEEP ? [] : ['-v'])]);

  console.log('· starting …');
  if (docker([...COMPOSE, 'up', '-d']).code !== 0) {
    console.error('compose up failed');
    process.exit(1);
  }

  const mongoUp = await waitFor('mongo', () =>
    docker(['exec', 'tdraw-dev-mongo', 'mongosh', '--quiet', '--eval', 'db.adminCommand({ping:1}).ok'],
      { quiet: true }).out.trim().endsWith('1'));

  // `createbuckets` is a one-shot sidecar; poll for its result rather than its
  // exit, so a re-run against an existing volume is also verified.
  //
  // Every mc call is passed as separate argv with no shell metacharacters: with
  // `shell: true` on Windows the command line goes through cmd.exe, which reads
  // a `>/dev/null` meant for the container's sh as its OWN redirection and turns
  // a working probe into 40 lines of mc usage text.
  const mc = (...args) => docker(['exec', 'tdraw-dev-minio', 'mc', ...args], { quiet: true });
  const bucketsUp = await waitFor('buckets (gallery + snapshots)', () => {
    if (mc('alias', 'set', 'local', 'http://127.0.0.1:9000', 'minioadmin', 'minioadmin').code !== 0) return false;
    const out = mc('ls', 'local').out;
    return /gallery/.test(out) && /snapshots/.test(out);
  });

  if (!bucketsUp) {
    console.log('· buckets missing — creating directly');
    mc('alias', 'set', 'local', 'http://127.0.0.1:9000', 'minioadmin', 'minioadmin');
    for (const b of ['gallery', 'snapshots']) {
      // `mc mb -p`, not `--ignore-existing`: current mc dropped that flag and
      // answers with a usage dump instead of an error.
      mc('mb', '-p', `local/${b}`);
      mc('anonymous', 'set', 'download', `local/${b}`);
    }
  }

  const ok = mongoUp;
  console.log(`\n${ok ? '✅' : '❌'} local backend ${KEEP ? 'restarted' : 'reset'}`
    + `  (mongo ${mongoUp ? 'up' : 'DOWN'}, buckets ${bucketsUp ? 'ready' : 'created just now'})`);

  console.log(`
RESTART THE SERVER before measuring anything. Rooms live in server memory —
strokeLog, checkpoints and all — so a process that outlived this wipe still
holds the old room and the next run is not a clean-room run.

  npm run dev:local          (server on the local stack + vite)
  npm run server:local       (server only, if vite is already up)
  AFK_DEBUG=1 npm run server:local     (per-user idle age + last activity type)

Those scripts carry the full env, including the R2_SNAPSHOTS_* vars that
server/r2.js resolves as R2_SNAPSHOTS_* || R2_* — so overriding only the generic
ones leaves the PROD values winning for the snapshot path. Symptom:
InvalidAccessKeyId, no checkpoint ever persists, SyncCoordinator serves baseSeq 0
and every join/resync silently degenerates into a full-tail replay.

Verify at boot: no "[R2] Snapshot storage is not fully configured", and zero
"Failed to save snapshot" lines once clients draw.`);
  process.exitCode = ok ? 0 : 1;
}

main().catch((e) => { console.error(e); process.exit(2); });
