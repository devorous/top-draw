/**
 * @fileoverview Bake-ledger oracle — an EXACT comparison of what each client
 * irreversibly flattened, and in what order.
 *
 * WHY THIS EXISTS. The overflow bake is the one step in the pipeline that cannot
 * be undone: `_bakeOverflowStrokes` resolves the bottom of the seq-ordered stack
 * against whatever is beneath it AT BAKE TIME and composites the result under the
 * entire live stack. LayerManager's own comment states the requirement — "every
 * client must flatten the SAME prefix in the SAME global order" — and the theory
 * under test is that clients trail the stream by different amounts, bake on LOCAL
 * counts, and so flatten different prefixes permanently.
 *
 * The suite already measures the downstream shadow of that (a pixel percentage)
 * and the precondition for it (a commit arriving at/below the baked watermark).
 * Neither can settle the question. The pixel oracle's resolution is coarser than
 * the effect: the bake deferral's A/B moved the mean by ~0.6 points against a
 * suite whose runs of an IDENTICAL command range 92.5–100.0. Asking it to resolve
 * one point is asking it for a digit it does not have.
 *
 * This oracle measures the mechanism itself. Every flattened stroke is recorded
 * by identity, in bake order, so two clients can be compared with a set
 * difference and an inversion count — integers, no tolerance, no threshold. If
 * the deferral works, clients bake the same strokes in the same order and both
 * numbers are 0. If it does not, they are not, and the oracle names the stroke.
 *
 * THREE NUMBERS, and they answer different questions:
 *
 *   prefixDelta   strokes one client baked and another did not (yet). On its own
 *                 this is NOT a bug — a client that has not overflowed yet simply
 *                 holds the stroke live, and a live stroke still sorts by seq. It
 *                 is the "different prefix" half of the theory, and it is the
 *                 quantity the deferral is designed to drive to zero.
 *   inversions    pairs of strokes both clients baked, in OPPOSITE relative
 *                 order. This one is unambiguous: baking is irreversible and
 *                 non-commutative blends do not survive a reorder, so a non-zero
 *                 count is permanent divergence that no resync can repair.
 *   zInversions   the same count over the EFFECTIVE z-order (baked run, then the
 *                 live stack) — which is what actually gets rendered, and so
 *                 catches the case where X baked a stroke that Y still holds live
 *                 beneath a stroke X baked later.
 *
 * BAKE CAUSE. Entries are tagged with which call flattened them, because two
 * completely different triggers reach the same code:
 *
 *   overflow   `_bakeOverflowStrokes` — MAX_STROKES_PER_USER exceeded. The only
 *              one `_shouldDeferBakeForInbound` guards.
 *   cleanup    `deepCleanupUserState` — a user disconnected and their strokes are
 *              consolidated. Fires on a DISCONNECT EVENT, which reaches each
 *              client at a different point in its own stream, and the deferral
 *              does not gate it at all. Cohort turnover is already implicated in
 *              this suite's divergence, so folding these two together would let a
 *              departure bake be scored as a deferral failure (or hide one).
 *
 * Identity is `L{group}:u{user}:s{seq}` — the same scheme the observer suite's
 * stroke-identity diff uses, and for the same reason: `timestamp` is assigned
 * locally, so including it makes every identity unique across clients and every
 * comparison vacuous. Strokes with seq 0 are counted but EXCLUDED from set and
 * order comparison: they carry no authoritative order, several can share one
 * identity, and each client sequences them by its own clock
 * ([[seqless_commits_ordered_by_local_clock]]).
 */

/* eslint-env browser */

// ---------------------------------------------------------------------------
// In-page half. These run inside the observer via page.evaluate, so they must be
// self-contained — no imports, no closure over module scope.
// ---------------------------------------------------------------------------

/**
 * Patch LayerManager.prototype to record every bake. Returns false if the
 * prototype could not be reached, which callers MUST treat as fatal: a detached
 * probe reports a confident zero for every metric here, and zero is exactly what
 * "it worked" looks like.
 *
 * Patches the PROTOTYPE, not the instance — `handleRoomSelected` rebuilds the
 * board and constructs a fresh LayerManager, so an instance hook installed before
 * the join is discarded before the first stroke arrives.
 *
 * @returns {boolean} whether the probe is attached
 */
export function installBakeLedgerInPage() {
  const lm = window.app?.board?.layerManager;
  const proto = lm && Object.getPrototypeOf(lm);
  if (!proto) return false;
  for (const fn of ['_bakeStrokeToBin', '_compressStrokesToGroup', '_bakeOverflowStrokes']) {
    if (typeof proto[fn] !== 'function') return false;
  }

  // Reset per run even when the prototype is already patched (a second observer
  // in the same browser, a re-join): the closures below read this object live.
  window.__bakeLedger = {
    entries: [],
    order: 0,
    bins: 0,
    compressed: 0,
    unsequenced: 0,
    byCause: {},
    cause: 'other',
  };

  if (proto.__bakeLedgerInstalled) return true;
  proto.__bakeLedgerInstalled = true;

  // Scope to the live board. ReplayEngine builds its own LayerManager off this
  // same prototype, so without this the replay-parity phase would append a
  // second, unrelated bake history to every ledger.
  const isLive = (self) => self === window.app?.board?.layerManager;

  const record = (self, group, stroke, kind) => {
    const L = window.__bakeLedger;
    if (!L || !isLive(self) || !stroke) return;
    const gi = self.layerGroups.indexOf(group);
    const seq = Number(stroke.seq) || 0;
    if (seq <= 0) L.unsequenced++;
    L.entries.push({
      gi,
      id: `L${gi}:u${stroke.userId}:s${seq}`,
      seq,
      userId: stroke.userId ?? null,
      n: L.order++,
      kind,
      cause: L.cause,
      blendMode: stroke.blendMode || 'source-over',
    });
    L.byCause[L.cause] = (L.byCause[L.cause] || 0) + 1;
    if (kind === 'bin') L.bins++; else L.compressed++;
  };

  // Cause markers. Re-entrant by design: _bakeOverflowStrokes calls both bake
  // paths, and deepCleanupUserState calls _bakeStrokeToBin directly, so the
  // marker has to be saved and restored rather than assigned.
  const withCause = (name, fn) => function (...args) {
    const L = window.__bakeLedger;
    const prev = L?.cause;
    if (L && isLive(this)) L.cause = name;
    try {
      return fn.apply(this, args);
    } finally {
      if (L) L.cause = prev;
    }
  };

  const origBin = proto._bakeStrokeToBin;
  proto._bakeStrokeToBin = function (group, stroke) {
    record(this, group, stroke, 'bin');
    return origBin.call(this, group, stroke);
  };

  const origCompress = proto._compressStrokesToGroup;
  proto._compressStrokesToGroup = function (group, startIdx, endIdx) {
    // Read the run BEFORE delegating — the original splices these strokes out of
    // strokeStack, so afterwards there is nothing left at those indices to name.
    if (isLive(this) && Array.isArray(group?.strokeStack)) {
      for (const s of group.strokeStack.slice(startIdx, endIdx + 1)) {
        record(this, group, s, 'compress');
      }
    }
    return origCompress.call(this, group, startIdx, endIdx);
  };

  proto._bakeOverflowStrokes = withCause('overflow', proto._bakeOverflowStrokes);
  if (typeof proto.deepCleanupUserState === 'function') {
    proto.deepCleanupUserState = withCause('cleanup', proto.deepCleanupUserState);
  }

  return true;
}

/**
 * Read the ledger plus the current live stacks out of an observer. The live
 * stacks are needed for the effective z-order: `_compositeGroupSequential`
 * renders flatCanvas/bakedSequences BEFORE strokeStack, so what a client
 * actually shows is "everything baked, then everything still live".
 *
 * @returns {{installed: boolean, entries: Array, bins: number, compressed: number,
 *            unsequenced: number, byCause: Object, live: Object<string, string[]>}}
 */
export function captureBakeLedgerInPage() {
  const L = window.__bakeLedger || null;
  const lm = window.app?.board?.layerManager;
  const live = {};
  (lm?.layerGroups || []).forEach((g, gi) => {
    // strokeStack is kept in authoritative seq order by _sortStrokeStack, so its
    // array order IS the render order. Do not re-sort it here: reading it as
    // stored is what makes a client that failed to sort visible.
    live[gi] = (g.strokeStack || [])
      .filter((s) => s && s.userId != null && (Number(s.seq) || 0) > 0)
      .map((s) => `L${gi}:u${s.userId}:s${Number(s.seq)}`);
  });
  return {
    installed: !!L,
    entries: L ? L.entries : [],
    bins: L ? L.bins : 0,
    compressed: L ? L.compressed : 0,
    unsequenced: L ? L.unsequenced : 0,
    byCause: L ? L.byCause : {},
    live,
  };
}

// ---------------------------------------------------------------------------
// Node half — pure comparison over captured ledgers.
// ---------------------------------------------------------------------------

/**
 * Count inversions between two orderings of the same id set: pairs that appear
 * in one relative order in `a` and the opposite in `b`. Merge-sort count, so a
 * few thousand strokes stay cheap.
 *
 * @param {string[]} a
 * @param {string[]} b - a permutation of `a`
 * @returns {{count: number, example: [string, string]|null}}
 */
function countInversions(a, b) {
  const rank = new Map();
  a.forEach((id, i) => rank.set(id, i));
  const seq = b.map((id) => rank.get(id));

  let count = 0;
  let example = null;
  const buf = new Array(seq.length);

  const sort = (lo, hi) => {
    if (hi - lo < 2) return;
    const mid = (lo + hi) >> 1;
    sort(lo, mid);
    sort(mid, hi);
    let i = lo, j = mid, k = lo;
    while (i < mid && j < hi) {
      if (seq[i] <= seq[j]) {
        buf[k++] = seq[i++];
      } else {
        // seq[i..mid) are all > seq[j]: that many inversions at once. `seq`
        // holds indices into `a`, and the recursion only reorders them, so
        // a[seq[…]] still names the stroke. The pair is (lower rank, higher
        // rank): a[seq[j]] precedes a[seq[i]] in `a` and follows it in `b`.
        if (!example) example = [a[seq[j]], a[seq[i]]];
        count += mid - i;
        buf[k++] = seq[j++];
      }
    }
    while (i < mid) buf[k++] = seq[i++];
    while (j < hi) buf[k++] = seq[j++];
    for (let x = lo; x < hi; x++) seq[x] = buf[x];
  };
  sort(0, seq.length);
  return { count, example };
}

/** Baked ids for one group, in bake order, deduped, sequenced only. */
function bakedOrder(capture, gi, { cause = null } = {}) {
  const seen = new Set();
  const out = [];
  for (const e of capture.entries || []) {
    if (e.gi !== gi || e.seq <= 0) continue;
    if (cause && e.cause !== cause) continue;
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e.id);
  }
  return out;
}

/** Effective render order for one group: everything baked, then everything live. */
function effectiveOrder(capture, gi) {
  const baked = bakedOrder(capture, gi);
  const seen = new Set(baked);
  const out = baked.slice();
  for (const id of capture.live?.[gi] || []) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Restrict two orderings to their common ids, preserving each one's order. */
function restrictToCommon(a, b) {
  const setB = new Set(b);
  const setA = new Set(a);
  return [a.filter((id) => setB.has(id)), b.filter((id) => setA.has(id))];
}

/**
 * Compare bake ledgers across observers.
 *
 * @param {Object<string, Object>} captures - label -> captureBakeLedgerInPage() result
 * @returns {Object} report
 */
export function compareBakeLedgers(captures) {
  const labels = Object.keys(captures);
  const groups = new Set();
  for (const c of Object.values(captures)) {
    for (const e of c.entries || []) groups.add(e.gi);
    for (const gi of Object.keys(c.live || {})) groups.add(Number(gi));
  }
  const groupList = [...groups].filter((g) => g >= 0).sort((x, y) => x - y);

  const pairs = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = i + 1; j < labels.length; j++) {
      const [la, lb] = [labels[i], labels[j]];
      const ca = captures[la], cb = captures[lb];
      let prefixDelta = 0, inversions = 0, zInversions = 0, common = 0;
      let overflowPrefixDelta = 0, overflowInversions = 0;
      let example = null, prefixExample = null;

      for (const gi of groupList) {
        const ba = bakedOrder(ca, gi);
        const bb = bakedOrder(cb, gi);
        const setA = new Set(ba), setB = new Set(bb);
        const onlyA = ba.filter((id) => !setB.has(id));
        const onlyB = bb.filter((id) => !setA.has(id));
        prefixDelta += onlyA.length + onlyB.length;
        if (!prefixExample && (onlyA.length || onlyB.length)) {
          prefixExample = onlyA.length
            ? `${la} baked ${onlyA[0]}, ${lb} did not`
            : `${lb} baked ${onlyB[0]}, ${la} did not`;
        }

        // Overflow-only view. `cleanup` bakes fire on a user-departure event,
        // which reaches each client at a different point in its own stream and
        // which `_shouldDeferBakeForInbound` does not gate at all — measured at
        // over HALF of all flattening in a lagged 8-bot run, because k6 cohorts
        // turn over mid-feed. Scoring the deferral against a total that is mostly
        // departure bakes would charge it for damage it never had a chance to
        // prevent, so the arm it can actually move is reported separately.
        const oa = bakedOrder(ca, gi, { cause: 'overflow' });
        const ob = bakedOrder(cb, gi, { cause: 'overflow' });
        const setOA = new Set(oa), setOB = new Set(ob);
        overflowPrefixDelta += oa.filter((id) => !setOB.has(id)).length
          + ob.filter((id) => !setOA.has(id)).length;
        const [roa, rob] = restrictToCommon(oa, ob);
        overflowInversions += countInversions(roa, rob).count;

        const [ra, rb] = restrictToCommon(ba, bb);
        common += ra.length;
        const inv = countInversions(ra, rb);
        inversions += inv.count;
        if (inv.example && !example) {
          example = `${la} baked ${inv.example[0]} before ${inv.example[1]}; ${lb} baked them the other way round`;
        }

        const [za, zb] = restrictToCommon(effectiveOrder(ca, gi), effectiveOrder(cb, gi));
        zInversions += countInversions(za, zb).count;
      }

      pairs.push({
        a: la, b: lb, prefixDelta, inversions, zInversions, common,
        overflowPrefixDelta, overflowInversions, example, prefixExample,
      });
    }
  }

  const totals = {
    prefixDelta: pairs.reduce((n, p) => n + p.prefixDelta, 0),
    inversions: pairs.reduce((n, p) => n + p.inversions, 0),
    zInversions: pairs.reduce((n, p) => n + p.zInversions, 0),
    worstPrefixDelta: pairs.reduce((n, p) => Math.max(n, p.prefixDelta), 0),
    // The deferral's own arm — see the overflow-only comment above.
    overflowPrefixDelta: pairs.reduce((n, p) => n + p.overflowPrefixDelta, 0),
    overflowInversions: pairs.reduce((n, p) => n + p.overflowInversions, 0),
  };

  const perObserver = {};
  for (const l of labels) {
    const c = captures[l];
    perObserver[l] = {
      installed: !!c?.installed,
      baked: (c?.entries || []).length,
      bins: c?.bins || 0,
      compressed: c?.compressed || 0,
      unsequenced: c?.unsequenced || 0,
      byCause: c?.byCause || {},
    };
  }

  // A ledger that recorded nothing is not agreement — it is an unattached probe,
  // or a run that never reached MAX_STROKES_PER_USER. Either way its zeros mean
  // "unknown", and saying so is the difference between this oracle and the
  // silent-no-op failures this suite has already shipped twice.
  const bakedTotal = Object.values(perObserver).reduce((n, o) => n + o.baked, 0);
  const attached = Object.values(perObserver).every((o) => o.installed);

  return {
    pairs,
    totals,
    perObserver,
    attached,
    meaningful: attached && bakedTotal > 0,
    verdict: bakedTotal === 0
      ? 'UNKNOWN'
      : (totals.inversions === 0 && totals.zInversions === 0
        ? (totals.prefixDelta === 0 ? 'IDENTICAL' : 'ORDER_AGREES')
        : 'DIVERGED'),
  };
}

/**
 * Human-readable lines for the suite's console report.
 * @param {Object} report - compareBakeLedgers() result
 * @returns {string[]}
 */
export function formatBakeLedgerReport(report) {
  const out = [];
  if (!report.attached) {
    out.push('  ⚠ bake ledger: probe not attached on every observer — treat its numbers as UNKNOWN');
    return out;
  }
  const counts = Object.entries(report.perObserver)
    .map(([l, o]) => {
      const causes = Object.entries(o.byCause).map(([c, n]) => `${c}:${n}`).join(',') || 'none';
      return `${l}=${o.baked}(${causes})`;
    })
    .join('  ');
  out.push(`  bake ledger: flattened strokes  ${counts}`);

  if (!report.meaningful) {
    out.push('  ⚠ bake ledger: nothing was ever baked — this run does not test the bake path at all');
    return out;
  }

  const t = report.totals;
  const sym = t.inversions === 0 && t.zInversions === 0 ? (t.prefixDelta === 0 ? '✅' : 'ℹ') : '❌';
  out.push(`  ${sym} bake order: ${t.inversions} inversions, ${t.zInversions} z-order inversions, `
    + `prefix delta ${t.prefixDelta} (worst pair ${t.worstPrefixDelta})`);
  // Split out the share the inbound-queue deferral could even in principle
  // affect. If the remainder dominates, no setting of BAKE_DEFER_ENABLED can
  // move the headline number, and tuning it would be chasing the wrong path.
  const cleanupInv = t.inversions - t.overflowInversions;
  out.push(`      of which overflow-path (what the deferral gates): `
    + `${t.overflowInversions} inversions, prefix delta ${t.overflowPrefixDelta}`
    + `   — departure/other bakes account for ${cleanupInv}`);

  for (const p of report.pairs) {
    if (!p.prefixDelta && !p.inversions && !p.zInversions) continue;
    out.push(`      ${p.a}↔${p.b}: prefixΔ ${p.prefixDelta}  inv ${p.inversions}  zInv ${p.zInversions}`
      + `  (common ${p.common})`);
    if (p.example) out.push(`         reordered: ${p.example}`);
    else if (p.prefixExample) out.push(`         ${p.prefixExample}`);
  }
  return out;
}
