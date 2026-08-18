/**
 * Covers the image-tool half of StrokeTape: a stroke drawn with a custom brush
 * has to replay with THAT brush, not with whatever the drawer is holding now.
 *
 * The tape only ever handles opaque wire bytes, so these tests use plain
 * Uint8Arrays as stand-in frames — the protobuf content is irrelevant to the
 * bookkeeping under test.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { StrokeTape, TapeFrameFilter } from '../server/StrokeTape.js';
import { T } from '../shared/MessageTypes.js';

let nextByte = 1;
/** A distinguishable frame of `size` bytes. */
function frame(size = 4) {
  const bytes = new Uint8Array(size);
  bytes.fill(nextByte);
  nextByte = (nextByte % 250) + 1;
  return bytes;
}

const has = (frames, bytes) => frames.some(f => Buffer.compare(Buffer.from(f), Buffer.from(bytes)) === 0);

/** Drives one commit-terminated stroke, returning its bundle. */
function drawStroke(tape, { user = 1, seq }) {
  tape.observe(T.MD, user, frame(), seq - 2, false);
  tape.observe(T.MM, user, frame(), seq - 1, false);
  tape.observe(T.MU, user, frame(), seq, true);
  return tape.getBundle(seq);
}

test('a stroke replays with the brush that was active when it was drawn', () => {
  const tape = new StrokeTape(T);
  const brushA = frame(64);
  const brushB = frame(64);

  tape.observe(T.GMP, 1, brushA, 1, false);
  const first = drawStroke(tape, { seq: 10 });

  tape.observe(T.GMP, 1, brushB, 11, false);
  const second = drawStroke(tape, { seq: 20 });

  assert.ok(has(first, brushA), 'first stroke carries brush A');
  assert.ok(!has(first, brushB));
  assert.ok(has(second, brushB), 'second stroke carries brush B');
  assert.ok(!has(second, brushA), 'second stroke must not fall back to brush A');
});

test('a brush switched mid-stroke lands inside that stroke preamble', () => {
  const tape = new StrokeTape(T);
  const brushA = frame(64);
  const brushB = frame(64);

  tape.observe(T.GMP, 1, brushA, 1, false);
  tape.observe(T.MD, 1, frame(), 2, false);
  tape.observe(T.GMP, 1, brushB, 3, false);
  tape.observe(T.MM, 1, frame(), 4, false);
  tape.observe(T.MU, 1, frame(), 5, true);

  const bundle = tape.getBundle(5);
  assert.ok(has(bundle, brushA));
  assert.ok(has(bundle, brushB));
});

test('IMAGE_TOOL slots do not evict each other', () => {
  const tape = new StrokeTape(T);
  const brush = frame(64);
  const confetti = frame(64);

  tape.observe(T.IMAGE_TOOL, 1, brush, 1, false, { imageToolType: 'imageBrush' });
  tape.observe(T.IMAGE_TOOL, 1, confetti, 2, false, { imageToolType: 'confetti' });
  const bundle = drawStroke(tape, { seq: 10 });

  assert.ok(has(bundle, brush), 'imageBrush payload survives a confetti payload');
  assert.ok(has(bundle, confetti));
});

test('image payloads are per-user', () => {
  const tape = new StrokeTape(T);
  const mine = frame(64);
  tape.observe(T.GMP, 1, mine, 1, false);

  const theirs = drawStroke(tape, { user: 2, seq: 10 });
  assert.ok(!has(theirs, mine), "another user's stroke must not adopt my brush");
});

test('the frame filter sends each image once per run, and again after a switch', () => {
  const tape = new StrokeTape(T);
  const brushA = frame(64);
  const brushB = frame(64);

  tape.observe(T.GMP, 1, brushA, 1, false);
  const s1 = drawStroke(tape, { seq: 10 });
  const s2 = drawStroke(tape, { seq: 20 });
  tape.observe(T.GMP, 1, brushB, 21, false);
  const s3 = drawStroke(tape, { seq: 30 });
  tape.observe(T.GMP, 1, brushA, 31, false); // switched BACK: a fresh broadcast
  const s4 = drawStroke(tape, { seq: 40 });

  const filter = new TapeFrameFilter(tape);
  const sent = [s1, s2, s3, s4].map(b => filter.filter(1, b));

  assert.ok(has(sent[0], brushA), 'first stroke of a run carries the image');
  assert.ok(!has(sent[1], brushA), 'a repeat of the same image is skipped');
  assert.ok(has(sent[2], brushB), 'a switch is sent');
  assert.ok(has(sent[3], brushA), 'switching back re-sends, it is a different frame');
  assert.equal(filter.skipped, 1);
  // Geometry is never deduped.
  for (const bundle of sent) assert.ok(bundle.length >= 2);
});

test('the frame filter tracks users independently', () => {
  const tape = new StrokeTape(T);
  const brush1 = frame(64);
  const brush2 = frame(64);
  tape.observe(T.GMP, 1, brush1, 1, false);
  tape.observe(T.GMP, 2, brush2, 2, false);

  const filter = new TapeFrameFilter(tape);
  const a = filter.filter(1, drawStroke(tape, { user: 1, seq: 10 }));
  const b = filter.filter(2, drawStroke(tape, { user: 2, seq: 20 }));
  const c = filter.filter(1, drawStroke(tape, { user: 1, seq: 30 }));

  assert.ok(has(a, brush1));
  assert.ok(has(b, brush2), "user 2's brush is not suppressed by user 1's");
  assert.ok(!has(c, brush1), "user 1's second stroke still dedupes");
});

test('the image store stays inside its byte budget and keeps current brushes', () => {
  const tape = new StrokeTape(T, { imageBudgetBytes: 4096 });
  const old = frame(2048);
  tape.observe(T.GMP, 1, old, 1, false);
  const oldBundle = drawStroke(tape, { seq: 10 });
  assert.ok(has(oldBundle, old));

  // Three more distinct brushes push the budget past its limit.
  let current = null;
  for (let i = 0; i < 3; i++) {
    current = frame(2048);
    tape.observe(T.GMP, 1, current, 20 + i, false);
  }

  const summary = tape.getSummary();
  assert.ok(summary.imageBytes <= 4096, `image store over budget: ${summary.imageBytes}`);
  // The evicted frame drops out of the old stroke's preamble rather than
  // keeping the payload alive through the bundle reference.
  assert.ok(!has(tape.getBundle(10), old));
  // The brush the user is holding NOW is never evicted.
  assert.ok(has(drawStroke(tape, { seq: 40 }), current));
});

test('clear() releases retained image payloads', () => {
  const tape = new StrokeTape(T);
  tape.observe(T.GMP, 1, frame(1024), 1, false);
  drawStroke(tape, { seq: 10 });
  tape.clear();
  assert.equal(tape.getSummary().imageBytes, 0);
  assert.equal(tape.getSummary().imageFrames, 0);
});
