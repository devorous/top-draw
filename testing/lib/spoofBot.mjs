/**
 * @fileoverview A headless Top Draw client that can present an arbitrary
 * source IP — the harness the IP-moderation suites are built on.
 *
 * ── How the spoofing works, and why it is sound ────────────────────────────
 *
 * `server/security.js#getClientIp` honours the `X-Forwarded-For` header when
 * the *immediate peer* looks like a local/private proxy (or `TRUST_PROXY=true`
 * is set). A bot connecting from 127.0.0.1 to a locally-running server is
 * exactly that case, so the header it sends becomes `ws.clientIp` verbatim —
 * the same string every downstream check consumes: `checkBan`, `checkMute`,
 * `checkShadowBan`, `issueModAction`, the per-IP rate limiters, `getIpSubnet`,
 * ASN/geo lookup and the moderator-facing IP display.
 *
 * That is the whole trick, and it matters that it is the *only* trick: nothing
 * here patches the server, stubs a module, or injects state. The spoofed
 * address enters through the same door a real client's address enters through,
 * so a suite built on this exercises the production code path rather than a
 * test-only shim. If the header stops being honoured, the bots stop spoofing
 * and the suites fail loudly instead of quietly testing 127.0.0.1 nine times
 * over — which is why `assertSpoofingWorks()` exists and why every suite must
 * call it before trusting a single result.
 *
 * A browser cannot set `X-Forwarded-For` on a WebSocket handshake, so these
 * bots deliberately are NOT Puppeteer pages: they speak the binary protocol
 * directly over `ws`. That also makes them fast enough to stand up a dozen
 * distinct "users" per test.
 *
 * ── Scope ──────────────────────────────────────────────────────────────────
 *
 * Local/dev servers only. Against a real deployment the header is only trusted
 * if the deployment already trusts its proxy, in which case the address a bot
 * sends is no more privileged than any other client's.
 */

import { WebSocket } from 'ws';
import protobuf from 'protobufjs';
import path from 'path';
import { fileURLToPath } from 'url';
import { randomUUID } from 'crypto';
import { T } from '../../shared/MessageTypes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROTO_PATH = path.join(__dirname, '..', '..', 'public', 'messages.proto');

/** Default backend origin — `npm run server` binds 127.0.0.1:8030. */
export const DEFAULT_HTTP_ORIGIN = process.env.SERVER_ORIGIN || 'http://127.0.0.1:8030';
export const DEFAULT_WS_ORIGIN = DEFAULT_HTTP_ORIGIN.replace(/^http/, 'ws');

let cachedMsgType = null;

/**
 * Loads (once) the protobuf `Msg` type both directions of the wire use.
 * @returns {Promise<protobuf.Type>}
 */
export async function loadMsgType() {
  if (!cachedMsgType) {
    const root = await protobuf.load(PROTO_PATH);
    cachedMsgType = root.lookupType('Msg');
  }
  return cachedMsgType;
}

/** Reverse lookup so failures name the message type instead of a number. */
const TYPE_NAMES = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));
export const typeName = (t) => TYPE_NAMES[t] ?? `T:${t}`;

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── HTTP with a spoofed source address ────────────────────────────────────

/**
 * Issues a JSON request carrying a spoofed client address, so account
 * registration / login are attributed to the same IP the bot will connect
 * from. Without this, an account's `ipHistory` and the per-IP HTTP rate
 * limiters would all see 127.0.0.1 and the two halves of a test would
 * disagree about who the user is.
 *
 * @param {string} pathname - e.g. '/api/auth/register'
 * @param {Object} [opts]
 * @param {string} [opts.ip] - Spoofed source address.
 * @param {Object} [opts.body] - JSON body; omit for GET.
 * @param {string} [opts.method]
 * @param {string} [opts.token] - Bearer token.
 * @param {string} [opts.origin]
 * @returns {Promise<{status: number, body: any}>}
 */
export async function spoofedFetch(pathname, {
  ip = null, body = null, method = null, token = null, origin = DEFAULT_HTTP_ORIGIN,
} = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (ip) headers['X-Forwarded-For'] = ip;
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${origin}${pathname}`, {
    method: method || (body ? 'POST' : 'GET'),
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

/**
 * Registers an account from a given source IP.
 * @returns {Promise<{token: string, userId: string}>}
 */
export async function registerAccount(username, password, { ip = null, origin } = {}) {
  const { status, body } = await spoofedFetch('/api/auth/register', {
    ip, origin, body: { username, password },
  });
  // Registration answers 201; treat any 2xx that carries a token as success.
  if (status < 200 || status >= 300 || !body?.success || !body?.token) {
    throw new Error(`register "${username}" failed (${status}): ${JSON.stringify(body)}`);
  }
  return { token: body.token, userId: body.userId };
}

// ─── The bot ───────────────────────────────────────────────────────────────

/**
 * Outcome of a join attempt. Deliberately a value rather than a thrown error:
 * "the server refused me" is the expected result in most of these tests, and a
 * rejection is not an exceptional condition to be caught, it is the assertion.
 *
 * @typedef {Object} JoinOutcome
 * @property {boolean} joined
 * @property {number|null} sessionIndex
 * @property {number|null} closeCode - WS close code (4001 banned, 4002 kicked,
 *   4003 room full, 4408 rate limited, 1008 too many connections).
 * @property {string} closeReason
 * @property {string} error - Server-supplied message, when there was one.
 */

export class SpoofBot {
  /**
   * @param {Object} opts
   * @param {string} opts.ip - The address to present as. Required: a bot with
   *   no spoofed address would silently share 127.0.0.1 with every other bot,
   *   and every IP-scoped assertion in the suite would be meaningless.
   * @param {string} opts.room - Room id to join.
   * @param {string} [opts.name] - Display name.
   * @param {string} [opts.label] - Name used in log/failure output.
   * @param {string} [opts.deviceId] - Defaults to a fresh uuid per bot, so IP
   *   tests are not accidentally passed or failed by device-id matching.
   * @param {string} [opts.fingerprintId]
   * @param {string} [opts.wsOrigin]
   * @param {string} [opts.httpOrigin]
   * @param {boolean} [opts.trace] - Log every message received.
   * @param {boolean} [opts.allowMalformed] - Send `ip` as the header even if it
   *   is not a valid address. Only for the tests that deliberately probe what
   *   the server does with a junk `X-Forwarded-For`; everywhere else the guard
   *   catches a typo'd fixture before it becomes a mystery result.
   */
  constructor({
    ip, room, name = null, label = null,
    deviceId = null, fingerprintId = null,
    wsOrigin = DEFAULT_WS_ORIGIN, httpOrigin = DEFAULT_HTTP_ORIGIN,
    trace = false, allowMalformed = false,
  }) {
    if (!ip && !allowMalformed) throw new Error('SpoofBot requires an explicit `ip`');
    if (!room) throw new Error('SpoofBot requires a `room`');

    this.ip = ip;
    this.room = room;
    this.name = name || `bot_${Math.random().toString(36).slice(2, 8)}`;
    this.label = label || this.name;
    this.deviceId = deviceId ?? randomUUID();
    this.fingerprintId = fingerprintId ?? randomUUID().replace(/-/g, '').slice(0, 20);
    this.wsOrigin = wsOrigin;
    this.httpOrigin = httpOrigin;
    this.trace = trace;

    /** @type {WebSocket|null} */
    this.socket = null;
    this.Msg = null;
    this.sessionIndex = null;
    this.authRole = 0;
    this.authGlobalRole = 0;
    this.username = null;

    /** Every decoded inbound message, in arrival order. */
    this.messages = [];
    /** Latest USERS roster payload seen. */
    this.lastUsers = null;
    /** @type {{code: number, reason: string}|null} */
    this.closeInfo = null;

    this._waiters = [];
    this._openPromise = null;
  }

  /** True while the socket is open. */
  get connected() {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  /**
   * Opens the WebSocket carrying the spoofed address. Does not join the room —
   * see {@link join}, which is what you normally want.
   * @returns {Promise<void>}
   */
  async open() {
    this.Msg = await loadMsgType();

    const url = new URL(this.wsOrigin);
    url.searchParams.set('room', this.room);
    url.searchParams.set('deviceId', this.deviceId);
    url.searchParams.set('fingerprintId', this.fingerprintId);
    url.searchParams.set('v', 'spoof-harness');

    this.socket = new WebSocket(url.toString(), {
      headers: {
        // The spoof. See the file header for why this is honoured.
        'X-Forwarded-For': this.ip,
        'User-Agent': `TopDrawSpoofBot/${this.label}`,
      },
    });
    this.socket.binaryType = 'arraybuffer';

    this.socket.on('message', (raw) => this._onFrame(new Uint8Array(raw)));
    this.socket.on('close', (code, reasonBuf) => {
      this.closeInfo = { code, reason: reasonBuf?.toString() || '' };
      // Wake anything blocked on a message that is never going to arrive.
      this._settleWaiters();
    });
    this.socket.on('error', () => { /* surfaced via close */ });

    this._openPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${this.label}] websocket open timed out`)), 15_000);
      this.socket.once('open', () => { clearTimeout(timer); resolve(); });
      this.socket.once('close', () => {
        clearTimeout(timer);
        // A close before open is a handshake-level refusal (rate limit, etc.).
        reject(new Error(`[${this.label}] socket closed before open: ${this.closeInfo?.code} ${this.closeInfo?.reason}`));
      });
    });

    await this._openPromise;
  }

  /**
   * Opens the socket and performs the room join handshake.
   *
   * Resolves with a {@link JoinOutcome} whether the server accepted or refused
   * the join — a refusal is data, not an exception.
   *
   * @param {Object} [opts]
   * @param {number} [opts.timeoutMs=8000]
   * @returns {Promise<JoinOutcome>}
   */
  async join({ timeoutMs = 8000 } = {}) {
    try {
      await this.open();
    } catch (err) {
      return {
        joined: false,
        sessionIndex: null,
        closeCode: this.closeInfo?.code ?? null,
        closeReason: this.closeInfo?.reason ?? '',
        error: err.message,
      };
    }

    this.send({
      t: T.CONNECT,
      n: this.name,
      clientDeviceId: this.deviceId,
      clientFingerprintId: this.fingerprintId,
    });

    const hit = await this.waitFor(
      (m) => m.t === T.CONNECT || (m.t === T.MOD_RESULT && m.a === false),
      { timeoutMs, settleOnClose: true },
    );

    if (hit && hit.t === T.CONNECT) {
      this.sessionIndex = hit.u ?? 0;
      this.username = hit.authUsername || this.name;
      this.authRole = hit.authRole || 0;
      this.authGlobalRole = hit.authGlobalRole || 0;
      return {
        joined: true,
        sessionIndex: this.sessionIndex,
        closeCode: null,
        closeReason: '',
        error: '',
      };
    }

    // Refused: the server sends the reason, then closes. Give the close a beat
    // to land so the caller can assert on the code (4001 banned vs 4003 full).
    await this.waitForClose(2000);
    return {
      joined: false,
      sessionIndex: null,
      closeCode: this.closeInfo?.code ?? null,
      closeReason: this.closeInfo?.reason ?? '',
      error: hit?.authError || (this.closeInfo ? `closed ${this.closeInfo.code}` : 'no response'),
    };
  }

  /**
   * Authenticates an already-joined bot with a JWT.
   * @param {string} token
   * @returns {Promise<{ok: boolean, role: number, error: string, closeCode: number|null}>}
   */
  async login(token, { timeoutMs = 8000 } = {}) {
    this.send({
      t: T.AUTH_LOGIN,
      authToken: token,
      clientDeviceId: this.deviceId,
      clientFingerprintId: this.fingerprintId,
    });

    const hit = await this.waitFor((m) => m.t === T.AUTH_RESULT, { timeoutMs, settleOnClose: true });
    if (!hit) {
      await this.waitForClose(1500);
      return { ok: false, role: 0, error: this.closeInfo ? `closed ${this.closeInfo.code}` : 'no AUTH_RESULT', closeCode: this.closeInfo?.code ?? null };
    }
    if (hit.a) {
      this.authRole = hit.authRole || 0;
      this.username = hit.authUsername || this.username;
      // The server may reassign role-derived state; re-read the roster below.
      return { ok: true, role: this.authRole, error: '', closeCode: null };
    }
    await this.waitForClose(1500);
    return { ok: false, role: 0, error: hit.authError || 'auth failed', closeCode: this.closeInfo?.code ?? null };
  }

  /**
   * Performs the join-sync handshake a real client performs after joining.
   *
   * REQUIRED before a bot can observe other people's draw traffic. On joining a
   * room that already has occupants, the server sets `ws.joinSyncPendingSince`
   * and suppresses room CONTENT broadcasts to this socket — MD/MM, tool state,
   * SEL_*, and every commit type — until `SyncCoordinator` serves the join tail
   * (`shouldSkipJoinSyncPending` in server/index.js). Real clients clear it by
   * sending SYNC_REQUEST; a bot that never does stays deaf for the 20s safety
   * valve, and every "the peer never received it" assertion silently passes for
   * the wrong reason.
   *
   * @returns {Promise<boolean>} true if SYNC_COMPLETE arrived.
   */
  async completeJoinSync({ timeoutMs = 20_000 } = {}) {
    if (!this.connected) return false;
    const from = this.mark();
    this.send({ t: T.SYNC_REQUEST });
    const done = await this.waitFor(m => m.t === T.SYNC_COMPLETE, { timeoutMs, from, settleOnClose: true });
    return !!done;
  }

  /** Convenience: open, join, and authenticate in one step. */
  async joinAndLogin(token, opts = {}) {
    const joinOutcome = await this.join(opts);
    if (!joinOutcome.joined) return { ...joinOutcome, authed: false, authError: joinOutcome.error };
    const auth = await this.login(token, opts);
    return { ...joinOutcome, authed: auth.ok, authError: auth.error, closeCode: auth.closeCode ?? joinOutcome.closeCode };
  }

  // ── Sending ──────────────────────────────────────────────────────────────

  /**
   * Encodes and sends one protobuf message.
   * @param {Object} payload
   */
  send(payload) {
    if (!this.connected) return false;
    this.socket.send(this.Msg.encode(payload).finish());
    return true;
  }

  /** Sends a chat message. Mirrors `WebSocketClient#broadcastChat`. */
  chat(text) {
    return this.send({
      t: T.MSG,
      g: text,
      chatMessageId: `m_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    });
  }

  /**
   * Issues a moderation action.
   * @param {Object} opts
   * @param {number} opts.type - 0 kick, 1 mute, 2 ban, 3 unmute, 4 unban,
   *   5 update-reason, 6 shadowban, 7 unshadowban.
   * @param {number} opts.target - Target session index.
   * @param {string} [opts.reason]
   * @param {number} [opts.duration] - Minutes; 0 = permanent.
   * @param {'exact'|'subnet'|'wide'} [opts.ipScope]
   * @param {string} [opts.targetName]
   */
  modAction({ type, target, reason = '', duration = 0, ipScope = null, targetName = null }) {
    const payload = {
      t: T.MOD_ACTION,
      modActionType: type,
      modTarget: target,
      modReason: reason,
      modDuration: duration,
    };
    if (ipScope) payload.modIpScope = ipScope;
    if (targetName) payload.modTargetName = targetName;
    return this.send(payload);
  }

  /** Requests the moderation entry list (MOD_LIST). */
  requestModList({ showHistory = false, search = '' } = {}) {
    return this.send({ t: T.MOD_LIST, modShowHistory: showHistory, modSearch: search });
  }

  // ── Receiving ────────────────────────────────────────────────────────────

  /**
   * Splits an inbound frame the same way the real client does. The server
   * concatenates batchable messages behind 4-byte big-endian lengths; a lone
   * message is sent bare and always starts with the `t` field tag (0x08).
   * Matching the client's heuristic exactly matters — a bot that parsed the
   * stream differently could see messages the real client never sees.
   * @private
   */
  _onFrame(raw) {
    if (raw.length > 4 && raw[0] !== 0x08) {
      const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      let offset = 0;
      while (offset + 4 <= raw.length) {
        const len = view.getUint32(offset);
        offset += 4;
        if (offset + len > raw.length) break;
        this._decodeOne(raw.slice(offset, offset + len));
        offset += len;
      }
      return;
    }
    this._decodeOne(raw);
  }

  /** @private */
  _decodeOne(bytes) {
    let msg;
    try {
      msg = this.Msg.decode(bytes);
    } catch {
      return; // Undecodable frames are not this harness's concern.
    }
    msg.__at = Date.now();
    this.messages.push(msg);
    if (msg.t === T.USERS) this.lastUsers = msg;
    if (this.trace) {
      console.log(`  [${this.label}] ← ${typeName(msg.t)}${msg.authError ? ` "${msg.authError}"` : ''}`);
    }
    this._settleWaiters();
  }

  /** @private Re-evaluates pending waiters against the message log. */
  _settleWaiters() {
    if (this._waiters.length === 0) return;
    const remaining = [];
    for (const waiter of this._waiters) {
      const hit = this.messages.slice(waiter.from).find(waiter.predicate);
      if (hit) {
        clearTimeout(waiter.timer);
        waiter.resolve(hit);
      } else if (waiter.settleOnClose && this.closeInfo) {
        clearTimeout(waiter.timer);
        waiter.resolve(null);
      } else {
        remaining.push(waiter);
      }
    }
    this._waiters = remaining;
  }

  /**
   * Waits for the first message matching `predicate`, searching messages that
   * arrived from `from` onward (default: the whole log, so a message that
   * landed before the call is still seen — races here are otherwise a constant
   * source of flaky moderation tests).
   *
   * @param {(msg: Object) => boolean} predicate
   * @param {Object} [opts]
   * @param {number} [opts.timeoutMs=5000]
   * @param {number} [opts.from=0] - Index into `messages` to start searching.
   * @param {boolean} [opts.settleOnClose=false] - Resolve null if the socket
   *   closes rather than waiting out the full timeout.
   * @returns {Promise<Object|null>} The message, or null on timeout/close.
   */
  waitFor(predicate, { timeoutMs = 5000, from = 0, settleOnClose = false } = {}) {
    const existing = this.messages.slice(from).find(predicate);
    if (existing) return Promise.resolve(existing);
    if (settleOnClose && this.closeInfo) return Promise.resolve(null);

    return new Promise((resolve) => {
      const waiter = { predicate, from, settleOnClose, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this._waiters = this._waiters.filter(w => w !== waiter);
        resolve(null);
      }, timeoutMs);
      this._waiters.push(waiter);
    });
  }

  /** Waits for a message of a given type. */
  waitForType(type, opts = {}) {
    return this.waitFor((m) => m.t === type, opts);
  }

  /**
   * Waits for the socket to close.
   * @param {number} [timeoutMs=5000]
   * @returns {Promise<{code: number, reason: string}|null>}
   */
  waitForClose(timeoutMs = 5000) {
    if (this.closeInfo) return Promise.resolve(this.closeInfo);
    if (!this.socket) return Promise.resolve(null);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.closeInfo), timeoutMs);
      this.socket.once('close', () => { clearTimeout(timer); resolve(this.closeInfo); });
    });
  }

  /** Index into `messages` to pass as `from`, to ignore everything so far. */
  mark() {
    return this.messages.length;
  }

  /** Drops the message log (keeps the connection). */
  clearLog() {
    this.messages.length = 0;
    this._waiters = [];
  }

  /**
   * Finds this bot's own entry, or another session's entry, in the most recent
   * roster. `vip` on that entry is the server's role-gated view of the user's
   * IP — the oracle used to verify spoofing actually took effect.
   * @param {number} [sessionIndex] - Defaults to this bot's own session.
   * @returns {Object|null}
   */
  rosterEntry(sessionIndex = this.sessionIndex) {
    const users = this.lastUsers?.us || [];
    return users.find(u => u.u === sessionIndex) || null;
  }

  /**
   * Asks the server to re-broadcast the roster and returns the fresh payload.
   *
   * A rename (`T.CN`) is the cheapest trigger that does not touch the canvas:
   * the server rebuilds USERS per viewer and broadcasts it to the whole room.
   * Re-sending the bot's *current* name is a no-op rename — `getUniqueVisibleName`
   * excludes the caller's own session, so no dedup suffix accumulates.
   *
   * @returns {Promise<Object|null>}
   */
  async refreshRoster({ timeoutMs = 4000 } = {}) {
    if (!this.connected) return this.lastUsers;
    const from = this.mark();
    this.send({ t: T.CN, n: this.username || this.name });
    const users = await this.waitFor(m => m.t === T.USERS, { timeoutMs, from, settleOnClose: true });
    return users || this.lastUsers;
  }

  /** Closes the socket. */
  close() {
    this._waiters.forEach(w => clearTimeout(w.timer));
    this._waiters = [];
    try { this.socket?.close(); } catch { /* already gone */ }
  }
}

// ─── Spoofing self-check ───────────────────────────────────────────────────

/**
 * Proves the spoof reaches `ws.clientIp` before any suite trusts a result.
 *
 * The lesson from `ws_latency_probe.mjs` applies directly: a knob that is
 * accepted, reports success, and changes nothing is the worst possible
 * failure, because everything downstream keeps producing plausible numbers.
 * If `X-Forwarded-For` were ignored, every bot would share 127.0.0.1 — and a
 * subnet-ban suite would then pass every "inside the range" case and fail
 * every "outside the range" case for reasons that have nothing to do with the
 * range maths.
 *
 * The oracle is the server's own view: a DEITY viewer receives each user's
 * full canonical IP in the `vip` field of the USERS roster
 * (`getVisibleIpForViewer` → `obfuscateIp(ip, DEITY)`), so we ask a DEITY bot
 * what address it sees for a target bot and compare.
 *
 * @param {Object} opts
 * @param {SpoofBot} opts.viewer - A joined+authenticated DEITY bot.
 * @param {SpoofBot} opts.target - A joined bot in the same room.
 * @param {string} opts.expectedIp - Canonical form of the target's spoofed IP.
 * @returns {Promise<{ok: boolean, observed: string, detail: string}>}
 */
export async function verifySpoofVisible({ viewer, target, expectedIp }) {
  await viewer.refreshRoster();
  const entry = viewer.rosterEntry(target.sessionIndex);

  if (!entry) {
    return {
      ok: false,
      observed: '',
      detail: `viewer sees no roster entry for session ${target.sessionIndex} (roster has ${(viewer.lastUsers?.us || []).map(u => u.u).join(', ') || 'nobody'})`,
    };
  }
  const observed = entry.vip || '';
  if (!observed) {
    return {
      ok: false,
      observed: '',
      detail: 'roster entry carries no `vip` — the viewer is not being treated as DEITY, so this check cannot see the IP at all',
    };
  }
  if (observed !== expectedIp) {
    const looksUnspoofed = /^(::1|::ffff:)?127\.0\.0\.1$|^::1$/.test(observed);
    return {
      ok: false,
      observed,
      detail: looksUnspoofed
        ? `server saw ${observed} — X-Forwarded-For is NOT being honoured, so every bot shares one address and no IP-scoped result below would mean anything`
        : `server saw ${observed}, expected ${expectedIp}`,
    };
  }
  return { ok: true, observed, detail: `server sees the spoofed address (${observed})` };
}
