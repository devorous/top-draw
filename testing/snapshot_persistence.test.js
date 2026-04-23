import test from 'node:test';
import assert from 'node:assert/strict';

import { handleSnapshotSave } from '../server/snapshots.js';
import { Role } from '../server/SessionManager.js';

test('lobby snapshots are accepted even though lobby is not a registered room', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAllowDevSnapshots = process.env.ALLOW_DEV_SNAPSHOTS;
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_DEV_SNAPSHOTS = 'false';

  const savedSnapshots = [];
  const room = {
    id: 'lobby',
    createdAt: Date.now(),
    settings: { backgroundColor: '#ffffff' },
    _pendingSnapshotRequests: new Set([42]),
    canPersistSnapshots() { return true; },
    addSnapshot(snapshot) { savedSnapshots.push(snapshot); },
    saveToDB: async () => {}
  };

  const ws = {
    sessionIndex: 42,
    userRole: Role.USER,
    username: 'D'
  };

  try {
    await handleSnapshotSave(ws, {
      snapshotLayers: [Uint8Array.of(1, 2, 3)],
      snapshotThumb: Uint8Array.of(4, 5, 6),
      a: true
    }, room);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.ALLOW_DEV_SNAPSHOTS = originalAllowDevSnapshots;
  }

  assert.equal(savedSnapshots.length, 1);
  assert.equal(savedSnapshots[0].issuer, 'D');
  assert.equal(savedSnapshots[0].auto, true);
  assert.deepEqual(Array.from(savedSnapshots[0].layers[0]), [1, 2, 3]);
});

test('unregistered non-lobby rooms still reject snapshot saves', async () => {
  const savedSnapshots = [];
  const room = {
    id: 'side-room',
    _pendingSnapshotRequests: new Set([7]),
    canPersistSnapshots() { return false; },
    addSnapshot(snapshot) { savedSnapshots.push(snapshot); }
  };

  const ws = {
    sessionIndex: 7,
    userRole: Role.USER,
    username: 'D'
  };

  await handleSnapshotSave(ws, {
    snapshotLayers: [Uint8Array.of(1, 2, 3)],
    a: true
  }, room);

  assert.equal(savedSnapshots.length, 0);
});
