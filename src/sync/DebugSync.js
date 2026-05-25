/**
 * @fileoverview Dev-time inspection helpers for the stroke fingerprint log.
 *
 * Phase 1 of the server-authoritative sync plan ships only the client + server
 * fingerprint logs (no parity round-trip yet). This module exposes them on the
 * App so a developer can manually inspect log state and verify it lines up
 * across two browser tabs.
 *
 * Use via `window.app.debugSync.dumpParity()` in the browser console.
 */

/**
 * Build the debugSync object that gets hung off `window.app.debugSync`.
 * @param {Object} app - The App instance (we read `app.wsClient`).
 * @returns {Object}
 */
export function createDebugSync(app) {
  return {
    /**
     * Print the current client-side fingerprint log summary plus the last few
     * entries. For diff'ing across tabs: open two clients, draw a stroke,
     * call this in each console — the count, latestSeq, and rollingHash
     * should match exactly.
     * @param {Object} [opts]
     * @param {number} [opts.tail=10] - Number of recent entries to log
     * @returns {Object} the summary object (also logged)
     */
    dumpParity({ tail = 10 } = {}) {
      const log = app.wsClient?.strokeLog;
      if (!log) {
        console.warn('[debugSync] No wsClient.strokeLog — client not connected yet?');
        return null;
      }
      const summary = log.getSummary();
      const lastN = log.entries.slice(-tail);
      console.group('[debugSync] Client stroke fingerprint log');
      console.log('Summary:', summary);
      console.log(`Rolling hash (hex): 0x${summary.rollingHash.toString(16).padStart(8, '0')}`);
      console.log(`Last ${lastN.length} entries:`);
      console.table(lastN.map(e => ({
        seq: e.seq,
        kind: e.kind,
        userId: e.userId,
        fp: `0x${e.fingerprint.toString(16).padStart(8, '0')}`,
        ts: new Date(e.timestamp).toISOString().slice(11, 23),
      })));
      console.groupEnd();
      return { summary, lastN };
    },

    /**
     * Trigger a parity check now (don't wait for the 30s heartbeat). Returns
     * a promise that resolves with the diff result, or `'ok'` if the server
     * confirmed the log matches. Useful for "did my fix work?" verification.
     * @returns {Promise<Object|'ok'>}
     */
    async checkNow() {
      const pc = app.parityClient;
      if (!pc) {
        console.warn('[debugSync] No parityClient attached');
        return null;
      }
      return new Promise((resolve) => {
        // One-shot listener; restored after fire. Chain the original
        // callbacks so App._handleParityMismatch still runs (which stamps
        // app.debugSync.lastMismatch for fixNow()).
        const prevOk = pc.onOk;
        const prevMM = pc.onMismatch;
        pc.onOk = () => {
          pc.onOk = prevOk; pc.onMismatch = prevMM;
          try { prevOk?.(); } catch (e) { console.error(e); }
          resolve('ok');
        };
        pc.onMismatch = (diff) => {
          pc.onOk = prevOk; pc.onMismatch = prevMM;
          try { prevMM?.(diff); } catch (e) { console.error(e); }
          resolve(diff);
        };
        pc.checkNow();
      });
    },

    /**
     * Print the last parity mismatch diff. Set by App._handleParityMismatch.
     */
    dumpMismatch() {
      const d = this.lastMismatch;
      if (!d) {
        console.log('[debugSync] No mismatch recorded yet — call checkNow() first.');
        return null;
      }
      console.group(`[debugSync] Last parity mismatch (${d.percent.toFixed(2)}%)`);
      console.log(`server=${d.serverCount}  client=${d.clientCount}`);
      if (d.missing?.length) {
        console.log(`Missing (${d.missing.length}):`);
        console.table(d.missing.map(e => ({ seq: e.seq, kind: e.kind, userId: e.userId, fp: e.fingerprint.toString(16) })));
      }
      if (d.extra?.length) {
        console.log(`Extra (${d.extra.length}):`);
        console.table(d.extra.map(e => ({ seq: e.seq, kind: e.kind, userId: e.userId, fp: e.fingerprint.toString(16) })));
      }
      if (d.mismatched?.length) {
        console.log(`Mismatched (${d.mismatched.length}):`);
        console.table(d.mismatched.map(m => ({ seq: m.seq, server_fp: m.server.fingerprint.toString(16), client_fp: m.client.fingerprint.toString(16) })));
      }
      if (d.truncatedChunks) console.warn('Some diverging chunks were truncated (request cap reached).');
      console.groupEnd();
      return d;
    },

    /** Show the per-row dev panel for the last mismatch. */
    showPanel() { app.parityPanel?.show(); },
    /** Hide the dev panel. */
    hidePanel() { app.parityPanel?.hide(); },

    /**
     * Request a targeted resync for the most recent mismatch.
     * Same path as the toast's "Fix" button — handy from devtools console.
     */
    fixNow() {
      const d = this.lastMismatch;
      if (!d) {
        console.warn('[debugSync] No mismatch to fix — call checkNow() first.');
        return;
      }
      app._fixParityMismatch?.(d);
    },

    /**
     * Return raw access to the strokeLog for advanced inspection (e.g. for
     * a future automated parity script).
     */
    getLog() {
      return app.wsClient?.strokeLog ?? null;
    },

    /** Populated by App._handleParityMismatch */
    lastMismatch: null,
  };
}
