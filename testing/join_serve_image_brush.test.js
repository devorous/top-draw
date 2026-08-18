/**
 * Drives SyncCoordinator's checkpoint join serve with the real StrokeTape and
 * StrokeFingerprintLog behind it, for the bug where every image-brush stroke in
 * a joiner's rebuild came out drawn with the drawer's CURRENT brush.
 *
 * What matters here is the ORDER and COUNT of what leaves the server: each
 * brush switch must reach the joiner before the strokes that used it, exactly
 * once per run, and SYNC_METADATA's syncTotal must match what actually follows.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SyncCoordinator } from '../server/SyncCoordinator.js';
import { StrokeTape } from '../server/StrokeTape.js';
import { StrokeFingerprintLog } from '../shared/StrokeFingerprint.js';
import { T } from '../shared/MessageTypes.js';

const OPEN = 1;
const USER = 7;

/** Encodes a recognisable stand-in frame; the tape never inspects contents. */
function frameFor(label) {
  return new Uint8Array(Buffer.from(label, 'utf8'));
}

/**
 * A room whose history is: brush A, two strokes, brush B, one stroke.
 * Every message goes through the same observe/record pair the broadcast
 * chokepoint uses, so the tape and log see exactly what they see in production.
 */
function makeRoom() {
  const tape = new StrokeTape(T);
  const log = new StrokeFingerprintLog({ storeBytes: true });
  let seq = 0;

  const emit = (t, label, { isCommit = false, payload = null } = {}) => {
    seq++;
    const bytes = frameFor(label);
    tape.observe(t, USER, bytes, seq, isCommit, payload);
    if (isCommit) log.record({ seq, t, userId: USER, bytes });
  };

  emit(T.CT, 'ct:imageBrush');
  emit(T.GMP, 'brushA');
  emit(T.MD, 'md1');
  emit(T.MM, 'mm1');
  emit(T.MU, 'mu1', { isCommit: true });
  emit(T.MD, 'md2');
  emit(T.MM, 'mm2');
  emit(T.MU, 'mu2', { isCommit: true });
  emit(T.GMP, 'brushB');
  emit(T.MD, 'md3');
  emit(T.MM, 'mm3');
  emit(T.MU, 'mu3', { isCommit: true });

  return {
    strokeTape: tape,
    strokeLog: log,
    settings: { boardSize: undefined, loadSnapshotOnFirstJoin: false },
    getClientCount: () => 2,
    canPersistSnapshots: () => false,
    beginSessionBase: async () => {},
  };
}

/** Runs a join serve and returns everything sent, decoded back to labels. */
async function serve() {
  const room = makeRoom();
  const sent = [];
  const sessionManager = { users: new Map() };
  const coordinator = new SyncCoordinator(sessionManager, null, (_ws, payload) => {
    sent.push(payload instanceof Uint8Array
      ? { frame: Buffer.from(payload).toString('utf8') }
      : payload);
    return true;
  }, room);

  const ws = { readyState: OPEN, sessionIndex: 99 };
  await coordinator._serveCheckpointJoin(ws, 99);
  return sent;
}

test('the join tail carries each brush before the strokes drawn with it', async () => {
  const sent = await serve();
  const labels = sent.map(m => m.frame ?? `T${m.t}`);

  const at = (label) => labels.indexOf(label);
  assert.ok(at('brushA') >= 0, 'brush A must be replayed, not assumed');
  assert.ok(at('brushB') >= 0, 'brush B must be replayed');
  assert.ok(at('brushA') < at('md1'), 'brush A precedes the strokes it drew');
  assert.ok(at('mu2') < at('brushB'), 'brush B arrives only after the brush-A strokes');
  assert.ok(at('brushB') < at('md3'), 'brush B precedes its own stroke');
});

test('a repeated brush is not re-sent per stroke', async () => {
  const sent = await serve();
  const labels = sent.map(m => m.frame ?? `T${m.t}`);
  const count = (label) => labels.filter(l => l === label).length;

  // Two strokes share brush A, and brush B is both the last stroke's brush and
  // the user's latest tool state (re-sent at the end of the serve) — one copy
  // of each is all the joiner needs.
  assert.equal(count('brushA'), 1);
  assert.equal(count('brushB'), 1);
});

test('syncTotal matches the frames that actually follow it', async () => {
  const sent = await serve();
  const metaIndex = sent.findIndex(m => m.t === T.SYNC_METADATA);
  const completeIndex = sent.findIndex(m => m.t === T.SYNC_COMPLETE);

  assert.ok(metaIndex >= 0 && completeIndex > metaIndex);
  const between = completeIndex - metaIndex - 1;
  assert.equal(sent[metaIndex].syncTotal, between,
    'a progress bar sized off syncTotal has to be able to reach the end');
});
