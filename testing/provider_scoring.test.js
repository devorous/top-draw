import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { scoreProvider } from '../server/providerScoring.js';
import { SyncCoordinator } from '../server/SyncCoordinator.js';

function makeClient(sessionIndex, props = {}) {
  return {
    sessionIndex,
    readyState: WebSocket.OPEN,
    pingRtt: 40,
    lowPowerMode: false,
    tabHidden: false,
    ...props
  };
}

function makeUser(name, props = {}) {
  return {
    name,
    afk: false,
    mousedown: false,
    lastActivity: 0,
    ...props
  };
}

test('active sync providers are ranked before inactive high-throughput clients', () => {
  const now = Date.now();
  const requester = makeClient(99);
  const clients = new Set([
    requester,
    makeClient(1, { uploadBps: 50_000_000 }),
    makeClient(2, { uploadBps: 40_000_000 }),
    makeClient(3, { uploadBps: 30_000_000 }),
    makeClient(4, { uploadBps: 70_000 })
  ]);
  const users = new Map([
    [1, makeUser('inactive fast 1')],
    [2, makeUser('inactive fast 2')],
    [3, makeUser('inactive fast 3')],
    [4, makeUser('active slower', { lastActivity: now })]
  ]);
  const coordinator = new SyncCoordinator({ users }, { clients }, () => {});

  assert.deepEqual(coordinator._getRankedCandidates(requester), [4, 1, 2]);
});

test('actively drawing providers outrank recently active providers', () => {
  const now = Date.now();
  const requester = makeClient(99);
  const clients = new Set([
    requester,
    makeClient(1, { uploadBps: 50_000_000 }),
    makeClient(2, { uploadBps: 70_000 })
  ]);
  const users = new Map([
    [1, makeUser('recent fast', { lastActivity: now })],
    [2, makeUser('drawing slow', { lastActivity: now, mousedown: true })]
  ]);
  const coordinator = new SyncCoordinator({ users }, { clients }, () => {});

  assert.deepEqual(coordinator._getRankedCandidates(requester), [2, 1]);
});

test('stale mousedown does not count as an active stroke provider', () => {
  const staleActivity = Date.now() - 120_000;
  const staleDrawing = makeUser('stale drawing', { lastActivity: staleActivity, mousedown: true });

  const score = scoreProvider(
    makeClient(1, { uploadBps: 100_000, pingRtt: 20 }),
    staleDrawing
  );

  assert.equal(score, scoreProvider(makeClient(2, { uploadBps: 100_000, pingRtt: 20 }), makeUser('inactive')));
});

test('AFK clients are disqualified as providers no matter how fast their upload', () => {
  // An AFK client's canvas is frozen (server filters their draws), so even a
  // 50 MB/s AFK uploader must never beat a slow active client — otherwise it
  // would win the snapshot-uploader election and persist a stale snapshot.
  const fastAfk = scoreProvider(
    makeClient(1, { uploadBps: 50_000_000, pingRtt: 5 }),
    makeUser('fast afk', { afk: true })
  );
  assert.equal(fastAfk, -Infinity);

  const slowActive = scoreProvider(
    makeClient(2, { uploadBps: 70_000, pingRtt: 80 }),
    makeUser('slow active', { lastActivity: Date.now() })
  );
  assert.ok(slowActive > fastAfk);
});

test('ranked sync candidates always exclude AFK clients', () => {
  const now = Date.now();
  const requester = makeClient(99);
  const clients = new Set([
    requester,
    makeClient(1, { uploadBps: 50_000_000 }),
    makeClient(2, { uploadBps: 100_000 })
  ]);
  const users = new Map([
    [1, makeUser('fast afk', { afk: true, lastActivity: now })],
    [2, makeUser('slow active', { lastActivity: now })]
  ]);
  const coordinator = new SyncCoordinator({ users }, { clients }, () => {});

  assert.deepEqual(coordinator._getRankedCandidates(requester), [2]);
});

test('hidden sync providers get a longer response timeout before snapshot fallback', () => {
  const coordinator = new SyncCoordinator({ users: new Map() }, { clients: new Set() }, () => {});

  assert.equal(coordinator._getProviderResponseTimeoutMs(makeClient(1)), 3500);
  assert.equal(coordinator._getProviderResponseTimeoutMs(makeClient(2, { tabHidden: true })), 15000);
});

test('activity carries meaningful score weight for shared provider scoring', () => {
  const now = Date.now();
  const inactiveFast = scoreProvider(
    makeClient(1, { uploadBps: 500_000, pingRtt: 20 }),
    makeUser('inactive')
  );
  const activeSlower = scoreProvider(
    makeClient(2, { uploadBps: 100_000, pingRtt: 20 }),
    makeUser('active', { lastActivity: now })
  );

  assert.ok(activeSlower > inactiveFast);
});
