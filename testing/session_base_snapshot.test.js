/**
 * Covers Room.beginSessionBase — the `loadSnapshotOnFirstJoin` room setting that
 * decides whether the first user into an empty room walks into the board as it
 * was left, or onto a blank canvas.
 *
 * Room's constructor pulls in a protobuf encoder and a SessionManager, so these
 * build the object off the prototype with only the fields the method touches.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Room } from '../server/RoomManager.js';

/** Minimal Room stand-in carrying the real prototype methods under test. */
function makeRoom({ loadSnapshotOnFirstJoin = true, persisted = null, canPersist = true } = {}) {
  const room = Object.create(Room.prototype);
  room.id = 'test-room';
  room.settings = { loadSnapshotOnFirstJoin };
  room.snapshots = [];
  room.joinCheckpointInvalidated = true; // as if the room had just emptied
  room._sessionBasePromise = null;
  room.strokeLog = { clear() { this.cleared = true; } };
  room.strokeTape = { clear() { this.cleared = true; } };
  room.clearAllTiles = () => { room.tilesCleared = true; };
  room.canPersistSnapshots = () => canPersist;
  room.getLatestSnapshotData = async () => persisted;
  return room;
}

const PERSISTED = {
  id: 'snap_old',
  ts: 1000,
  issuer: 'D',
  layers: [Uint8Array.of(1, 2, 3)],
  seq: 4820, // watermark from the previous session's sequence space
};

test('setting on: the first joiner adopts the persisted snapshot as the session base', async () => {
  const room = makeRoom({ persisted: PERSISTED });

  const base = await room.beginSessionBase();

  assert.ok(base, 'expected a base snapshot to be adopted');
  assert.equal(base.id, 'snap_old');
  assert.equal(room.joinCheckpointInvalidated, false, 'adoption must un-invalidate the join checkpoint');
  assert.equal(room.snapshots.length, 1, 'base should be registered in the in-memory buffer');
  assert.equal(room.snapshots[0].auto, true, 'must register as an auto snapshot to be servable as a join checkpoint');
});

test('the adopted base is re-stamped at seq 0, not the dead session watermark', async () => {
  const room = makeRoom({ persisted: PERSISTED });

  const base = await room.beginSessionBase();

  // messageSequence restarts at 0 for a new session. Serving the base at its
  // stored seq (4820) would sort it above every stroke of the new session, and
  // later joiners would get the image with an empty tail.
  assert.equal(base.seq, 0);
  assert.equal(room.getJoinCheckpointMeta().seq, 0);
});

test('setting off: the session starts blank and keeps the checkpoint invalidated', async () => {
  const room = makeRoom({ loadSnapshotOnFirstJoin: false, persisted: PERSISTED });

  const base = await room.beginSessionBase();

  assert.equal(base, null);
  assert.equal(room.joinCheckpointInvalidated, true);
  assert.equal(room.snapshots.length, 0, 'nothing should be servable as a join checkpoint');
});

test('setting off drops a live command tail the new session must not inherit', async () => {
  // A room that did NOT go through resetJoinSyncState (it never fully emptied),
  // so the previous tail is still loaded and beginBlankJoinSession has work to do.
  const room = makeRoom({ loadSnapshotOnFirstJoin: false, persisted: PERSISTED });
  room.joinCheckpointInvalidated = false;

  await room.beginSessionBase();

  assert.equal(room.joinCheckpointInvalidated, true);
  assert.equal(room.strokeLog.cleared, true, 'a blank start must drop the previous command tail');
  assert.equal(room.strokeTape.cleared, true);
  assert.equal(room.tilesCleared, true);
});

test('no persisted snapshot falls back to a blank start', async () => {
  const room = makeRoom({ persisted: null });

  const base = await room.beginSessionBase();

  assert.equal(base, null);
  assert.equal(room.joinCheckpointInvalidated, true);
});

test('an unpersistable room never adopts a base', async () => {
  const room = makeRoom({ persisted: PERSISTED, canPersist: false });

  assert.equal(await room.beginSessionBase(), null);
  assert.equal(room.snapshots.length, 0);
});

test('the decision is pinned once, so racing joiners resolve the same base', async () => {
  let fetches = 0;
  const room = makeRoom({ persisted: PERSISTED });
  room.getLatestSnapshotData = async () => {
    fetches++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return PERSISTED;
  };

  // Two clients connecting inside the async R2/DB fetch window.
  const [first, second] = await Promise.all([room.beginSessionBase(), room.beginSessionBase()]);

  assert.equal(fetches, 1, 'the base must be fetched once per session, not per joiner');
  assert.equal(first, second, 'both joiners must resolve the identical base');
  assert.equal(room.snapshots.length, 1);
});

test('emptying the room releases the pin so the next session re-decides', async () => {
  const room = makeRoom({ persisted: PERSISTED });
  await room.beginSessionBase();

  room.resetJoinSyncState();

  assert.equal(room._sessionBasePromise, null);
  assert.equal(room.snapshots.length, 0, 'auto snapshots must not leak into the next session');
  assert.equal(room.joinCheckpointInvalidated, true);
});
