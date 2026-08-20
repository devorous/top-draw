/**
 * @fileoverview Low-overhead timing probes for always-on loops.
 *
 * Design constraints, in order of importance:
 *
 * 1. Zero steady-state allocation. Probes run inside `compositeAllLayers` and
 *    `consumeDirtyRects` at up to 60Hz, so every buffer is preallocated at
 *    registration and reused. No closures, no object literals, no array growth
 *    in `begin`/`end`.
 * 2. Loop granularity, never element granularity. A probe costs two
 *    `performance.now()` calls; a handful per frame is invisible, but one per
 *    layer or per stroke point would mostly measure its own overhead. Register
 *    probes around whole loops only.
 * 3. Strictly nestable. `end()` folds elapsed time into whichever probe was
 *    open when it began, so `selfMs` excludes children and hierarchical probes
 *    actually add up.
 *
 * Windowed: counters accumulate until `flush()`, which snapshots and resets.
 * `snapshot()` is non-destructive, so the debug panel can poll at 500ms while a
 * future telemetry uploader owns the 60s flush without either disturbing the
 * other.
 */

/** Upper edges in ms. Last bucket is unbounded. */
const BUCKET_EDGES = [1, 2, 4, 8, 16, 33, 50, 100, 250, Infinity];

const MAX_DEPTH = 16;

class Probe {
  constructor(name) {
    this.name = name;
    this.count = 0;
    this.totalMs = 0;
    this.selfMs = 0;
    this.maxMs = 0;
    this.buckets = new Uint32Array(BUCKET_EDGES.length);
    /** Time attributed to nested probes since this one opened. @private */
    this._childMs = 0;
    /** @private */
    this._startedAt = 0;
    /** Named counters for branch / escape-hatch tallies. @type {Object|null} */
    this.tallies = null;
  }

  reset() {
    this.count = 0;
    this.totalMs = 0;
    this.selfMs = 0;
    this.maxMs = 0;
    this.buckets.fill(0);
    if (this.tallies) {
      for (const key in this.tallies) this.tallies[key] = 0;
    }
  }
}

class PerfProbeRegistry {
  constructor() {
    /** @type {Map<string, Probe>} */
    this.probes = new Map();
    this.enabled = false;

    /** Open-probe stack for parent attribution. Preallocated. @private */
    this._stack = new Array(MAX_DEPTH).fill(null);
    /** @private */
    this._depth = 0;
    /** Dropped begins from stack overflow — a bug signal, not a metric. */
    this.overflows = 0;
    /** Unmatched or mismatched `end()` calls — also a bug signal. */
    this.underflows = 0;

    this.windowStartMs = now();

    /** @type {Array<{startTime:number,duration:number}>} */
    this.longTasks = [];
    this.longTaskTotalMs = 0;
    this._longTaskObserver = null;
    this._maxLongTasks = 64;
  }

  /**
   * Registers a probe up front so the hot path never allocates.
   * @param {string} name
   * @param {string[]} [tallyKeys] - Named counters bumped via `tally()`.
   * @returns {Probe}
   */
  register(name, tallyKeys) {
    let probe = this.probes.get(name);
    if (!probe) {
      probe = new Probe(name);
      this.probes.set(name, probe);
    }
    if (tallyKeys && tallyKeys.length) {
      if (!probe.tallies) probe.tallies = Object.create(null);
      for (const key of tallyKeys) {
        if (probe.tallies[key] === undefined) probe.tallies[key] = 0;
      }
    }
    return probe;
  }

  /**
   * Opens a probe. Must be paired with `end(name)`. Cheap enough to leave in
   * place permanently when disabled — one boolean check.
   * @param {string} name
   */
  begin(name) {
    if (!this.enabled) return;
    const probe = this.probes.get(name);
    if (!probe) return;
    if (this._depth >= MAX_DEPTH) {
      this.overflows++;
      return;
    }
    probe._childMs = 0;
    probe._startedAt = now();
    this._stack[this._depth++] = probe;
  }

  /**
   * Closes the probe opened by `begin(name)` and folds its elapsed time into
   * the parent's child total so `selfMs` stays exclusive.
   * @param {string} name
   */
  end(name) {
    if (!this.enabled) return;
    const depth = this._depth - 1;
    if (depth < 0) {
      this.underflows++;
      return;
    }
    const probe = this._stack[depth];
    // A name mismatch means an unbalanced begin/end somewhere. Bail rather than
    // guess which side is wrong and corrupt the stack for every later probe.
    if (!probe || probe.name !== name) {
      this.underflows++;
      return;
    }
    this._depth = depth;
    this._stack[depth] = null;

    const elapsed = now() - probe._startedAt;
    probe.count++;
    probe.totalMs += elapsed;
    probe.selfMs += elapsed - probe._childMs;
    if (elapsed > probe.maxMs) probe.maxMs = elapsed;

    let bucket = 0;
    while (bucket < BUCKET_EDGES.length - 1 && elapsed > BUCKET_EDGES[bucket]) bucket++;
    probe.buckets[bucket]++;

    if (depth > 0) {
      const parent = this._stack[depth - 1];
      if (parent) parent._childMs += elapsed;
    }
  }

  /**
   * Bumps a named counter on a probe, for branch and escape-hatch tallies where
   * the interesting number is a rate rather than a duration.
   * @param {string} name
   * @param {string} key
   * @param {number} [by=1]
   */
  tally(name, key, by = 1) {
    if (!this.enabled) return;
    const probe = this.probes.get(name);
    if (!probe || !probe.tallies) return;
    if (probe.tallies[key] === undefined) return;
    probe.tallies[key] += by;
  }

  /**
   * Starts a PerformanceObserver for long tasks — main-thread blocks over 50ms.
   * Free attribution for work no probe covers. Chromium-only; degrades quietly
   * everywhere else.
   */
  startLongTaskObserver() {
    if (this._longTaskObserver || typeof PerformanceObserver === 'undefined') return;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this.longTaskTotalMs += entry.duration;
          this.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
          if (this.longTasks.length > this._maxLongTasks) this.longTasks.shift();
        }
      });
      observer.observe({ entryTypes: ['longtask'] });
      this._longTaskObserver = observer;
    } catch (_) {
      // entryType unsupported — nothing was registered, nothing to clean up.
    }
  }

  stopLongTaskObserver() {
    this._longTaskObserver?.disconnect?.();
    this._longTaskObserver = null;
  }

  enable() {
    if (this.enabled) return;
    this.enabled = true;
    this.startLongTaskObserver();
    this.reset();
  }

  disable() {
    this.enabled = false;
    this._depth = 0;
    this._stack.fill(null);
    this.stopLongTaskObserver();
  }

  reset() {
    for (const probe of this.probes.values()) probe.reset();
    this.longTasks.length = 0;
    this.longTaskTotalMs = 0;
    this.overflows = 0;
    this.underflows = 0;
    this.windowStartMs = now();
  }

  /**
   * Non-destructive read of the current window. Safe to call from several
   * consumers at different cadences.
   * @returns {Object}
   */
  snapshot() {
    const elapsedMs = now() - this.windowStartMs;
    const entries = [];
    for (const probe of this.probes.values()) {
      if (probe.count === 0 && !probe.tallies) continue;
      entries.push({
        name: probe.name,
        count: probe.count,
        perSec: elapsedMs > 0 ? (probe.count * 1000) / elapsedMs : 0,
        avgMs: probe.count > 0 ? probe.totalMs / probe.count : 0,
        selfAvgMs: probe.count > 0 ? probe.selfMs / probe.count : 0,
        totalMs: probe.totalMs,
        selfMs: probe.selfMs,
        maxMs: probe.maxMs,
        // Share of wall-clock time this probe's own work occupied.
        loadPercent: elapsedMs > 0 ? (probe.selfMs / elapsedMs) * 100 : 0,
        buckets: Array.from(probe.buckets),
        tallies: probe.tallies ? { ...probe.tallies } : null
      });
    }
    return {
      elapsedMs,
      entries,
      longTaskCount: this.longTasks.length,
      longTaskTotalMs: this.longTaskTotalMs,
      longTaskMaxMs: this.longTasks.reduce((m, t) => (t.duration > m ? t.duration : m), 0),
      overflows: this.overflows,
      underflows: this.underflows
    };
  }

  /** Snapshot then reset — for a telemetry uploader that owns the window. */
  flush() {
    const snap = this.snapshot();
    this.reset();
    return snap;
  }

  static get BUCKET_EDGES() {
    return BUCKET_EDGES;
  }
}

function now() {
  return (typeof performance !== 'undefined' && performance.now)
    ? performance.now()
    : Date.now();
}

/** Shared registry. Probes are registered by the modules that own them. */
export const perfProbe = new PerfProbeRegistry();

export { PerfProbeRegistry, BUCKET_EDGES };
