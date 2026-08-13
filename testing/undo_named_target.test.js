/**
 * @fileoverview Regression tests for the named-target remote undo.
 *
 * A remote UNDO carries `undo_target_seq` — the seq of the stroke the sender
 * actually undid — because "the sender's latest live stroke" resolves against
 * each client's own bake state. When the named stroke is not in our live stack
 * the receiver must NOT substitute one of its own sequenced strokes: doing so
 * undoes something the sender still has.
 *
 * Reproduced from docs/ddraw_replay_2026-08-12_22-00-46.ddraw at 22:47.750,
 * where a peer's undo named seq 144598 (a seq the observer had never bound to a
 * stroke) and the observer undid the SEL_DELETE at seq 144356 instead — the
 * cleared selection reappeared for the observer only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { LayerManager } from '../src/canvas/LayerManager.js';

const USER = 7;

/** Bare LayerManager with only the fields undoLastStrokeGlobal touches. */
function makeManager(strokes) {
  const lm = Object.create(LayerManager.prototype);
  lm.layerGroups = [{
    strokeStack: strokes.map((s) => ({ userId: USER, ...s })),
    userStrokeCounts: new Map([[USER, strokes.length]])
  }];
  lm.needsComposite = false;
  lm._notifyHistoryPanel = () => {};
  return lm;
}

const seqsOf = (lm) => lm.layerGroups[0].strokeStack.map((s) => s.seq);

test('named target undoes exactly that stroke', () => {
  const lm = makeManager([
    { seq: 100, timestamp: 1 },
    { seq: 200, timestamp: 2 },
    { seq: 300, timestamp: 3 }
  ]);

  const undone = lm.undoLastStrokeGlobal(USER, 200);

  assert.equal(undone.length, 1);
  assert.equal(undone[0].record.seq, 200);
  assert.deepEqual(seqsOf(lm), [100, 300]);
});

test('unknown named target does not fall back onto a sequenced stroke', () => {
  // The tape's shape: a selection clear, then strokes, all sequenced here.
  const lm = makeManager([
    { seq: 144356, timestamp: 1, selDelete: true },
    { seq: 145166, timestamp: 2 },
    { seq: 146533, timestamp: 3 }
  ]);

  // 144598 was an MU broadcast that carried no stroke on this client.
  const undone = lm.undoLastStrokeGlobal(USER, 144598);

  assert.equal(undone, null, 'must decline rather than undo someone else’s stroke');
  assert.deepEqual(seqsOf(lm), [144356, 145166, 146533]);
});

test('unknown named target still falls back onto unsequenced strokes', () => {
  // A joiner rebuilds the command tail into strokes that carry seq 0; the
  // fallback exists for exactly these and must survive.
  const lm = makeManager([
    { seq: 100, timestamp: 1 },
    { seq: 0, timestamp: 2 },
    { seq: 0, timestamp: 3 }
  ]);

  const undone = lm.undoLastStrokeGlobal(USER, 999);

  assert.equal(undone.length, 1);
  assert.equal(undone[0].record.timestamp, 3, 'newest unsequenced stroke');
  assert.deepEqual(seqsOf(lm), [100, 0]);
});

test('unnamed undo keeps the legacy latest-live-stroke resolution', () => {
  const lm = makeManager([
    { seq: 100, timestamp: 1 },
    { seq: 300, timestamp: 3 },
    { seq: 200, timestamp: 2 }
  ]);

  const undone = lm.undoLastStrokeGlobal(USER, 0);

  assert.equal(undone.length, 1);
  assert.equal(undone[0].record.seq, 300);
  assert.deepEqual(seqsOf(lm), [100, 200]);
});

test('unnamed undo prefers an optimistic stroke over sequenced ones', () => {
  const lm = makeManager([
    { seq: 100, timestamp: 1 },
    { seq: 0, timestamp: 2 }
  ]);

  const undone = lm.undoLastStrokeGlobal(USER, 0);

  assert.equal(undone[0].record.seq, 0);
  assert.deepEqual(seqsOf(lm), [100]);
});

test('a named target removes every live stroke sharing that seq', () => {
  // One wire commit can produce several records (per-layer erase, mirrored
  // counterpart) that share a seq.
  const lm = makeManager([
    { seq: 100, timestamp: 1 },
    { seq: 200, timestamp: 2 },
    { seq: 200, timestamp: 2 }
  ]);

  const undone = lm.undoLastStrokeGlobal(USER, 200);

  assert.equal(undone.length, 2);
  assert.deepEqual(seqsOf(lm), [100]);
});

test('another user’s stroke is never undone by a named target', () => {
  const lm = makeManager([{ seq: 100, timestamp: 1 }]);
  lm.layerGroups[0].strokeStack.push({ userId: USER + 1, seq: 200, timestamp: 2 });

  assert.equal(lm.undoLastStrokeGlobal(USER, 200), null);
  assert.deepEqual(seqsOf(lm), [100, 200]);
});
