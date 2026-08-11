/**
 * @fileoverview K6 stress test for low-volume WebSocket traffic. Each VU picks
 * tools at random across the FULL tool set (including the pattern + confetti
 * brushes) and exercises selection verbs, text with varied fonts, blend modes,
 * flood fill, layer switching, and undo/redo.
 *
 * ── WHAT CHANGED AND WHY IT MATTERS FOR EVERY PRIOR RESULT ──────────────────
 *
 * This feed used to be the sole source of "realistic" traffic for the observer,
 * joiner and AFK suites, so its blind spots were silently inherited by every
 * number those suites ever produced. `k6_wire_audit.mjs` (static, run it first)
 * now guards the wire-level half of this; the rest is coverage:
 *
 *   was                                    now
 *   ─────────────────────────────────────  ────────────────────────────────────
 *   every bot on layer 0, forever          rotates all 3 layers via CL
 *   UNDO only                              UNDO + REDO, with redo racing peers
 *   lift/move/commit only                  + delete/fill/stamp/cancel/flip/
 *                                            merge/mask, rect AND lasso
 *   no pressure, no stamp radii            CP mid-stroke + per-point rs
 *   one point per MM                       batched multi-point MM (tick-shaped)
 *   shape draw mode never applied (bug)    both modes, actually applied
 *   simulate-pressure never true (bug)     both states
 *   fill colour was a no-op (bug)          CC-then-FILL, + expansion/blur
 *   unseeded RNG                           per-VU seed, --seed reproduces a run
 *
 * The layer axis is the big one. Only layer 0 has `allowComplexBlendModes`
 * (LayerManager.initLayerGroups), and only layer 0 gets a `flatCanvas` at
 * construction — so bake behaviour, blend clamping and undo interact
 * differently per layer, and a single-layer feed could not see any of it.
 *
 * Env knobs (all optional; defaults keep the historical shape of the traffic):
 *   SPECIAL_CHANCE=0.15   probability an idle tick fires a non-stroke action
 *   UNDO_WEIGHT=1         extra 'undo' entries in the special pool
 *   REDO_CHANCE=0.35      chance an undo is followed by a redo a few ticks later
 *   NO_BLEND=1            drop 'blendSwap' so every stroke stays source-over
 *   SPECIAL_ONLY=a,b      restrict the special pool (blendSwap, floodFill,
 *                         selectionTransform, selectionVerb, undo, layerSwap)
 *   LAYERS=0,1,2          which layers bots may draw on (default all three)
 *   TOOLS=brush,line      restrict the tool pool by name
 *   SEED=12345            base RNG seed; a run with the same seed and VU count
 *                         replays the same decisions
 */

import ws from 'k6/ws';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';
import { buildMsg } from './_k6_proto.js';
import {
  T, Tool, TOOL_NAMES, ALL_TOOLS, TEXT_PHRASES, FONTS, BLEND_MODES,
  randColor, isFillTargetTool,
  configureTool, sendMove, sendMoveBatch, sendDown, sendUp, sendPressure,
  applyTextWithFont, applyFloodFill, setBlendMode, sendLayerChange,
  performSelectionTransform, sendUndo, sendRedo, parseInbound,
  sendSelLift, sendSelMove, sendSelCommit, sendSelCancel, sendSelDelete,
  sendSelFill, sendSelStamp, sendSelFlip, sendSelMerge, sendSelMask,
  makeLassoPath, makeConfettiPayload,
} from './_k6_actions.js';

const broadcastLatency = new Trend('broadcast_latency_low');

export const options = {
  vus: 8,
  duration: '1m',
};

// ─── Tunables ───────────────────────────────────────────────────────────────

const SPECIAL_ACTIONS = ['blendSwap', 'selectionTransform', 'selectionVerb', 'floodFill', 'undo', 'layerSwap'];
const SPECIAL_CHANCE = Number(__ENV.SPECIAL_CHANCE || 0.15);
const UNDO_WEIGHT = Math.max(1, Number(__ENV.UNDO_WEIGHT || 1));
const REDO_CHANCE = Number(__ENV.REDO_CHANCE ?? 0.35);
const NO_BLEND = __ENV.NO_BLEND === '1';
// NO_BLEND and SPECIAL_CHANCE cannot isolate ONE class: blendSwap only ever
// fires through the special path, so SPECIAL_CHANCE=0 already removes it and
// NO_BLEND on top is a no-op. Bisecting the joiner residual by content type
// needs "strokes plus exactly one special", which is what this allows.
const SPECIAL_ONLY = String(__ENV.SPECIAL_ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const SPECIAL_POOL = SPECIAL_ACTIONS
  .filter((a) => !(NO_BLEND && a === 'blendSwap'))
  .filter((a) => SPECIAL_ONLY.length === 0 || SPECIAL_ONLY.includes(a))
  // Weighting is applied AFTER the allowlist, so SPECIAL_ONLY=floodFill cannot
  // smuggle undos back in via UNDO_WEIGHT.
  .concat((SPECIAL_ONLY.length === 0 || SPECIAL_ONLY.includes('undo'))
    ? Array.from({ length: UNDO_WEIGHT - 1 }, () => 'undo')
    : []);

/** Layers bots may draw on. The board has three (LayerManager.initLayerGroups(3)). */
const LAYERS = String(__ENV.LAYERS || '0,1,2').split(',')
  .map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 2);

/** Optional tool allowlist by name, e.g. TOOLS=brush,line,circle. */
const TOOL_FILTER = String(__ENV.TOOLS || '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

// GLITCH_BLUR is deliberately excluded from the bot pool. Committing a glitch
// requires the drawer to send GLITCH_RESULT carrying a rendered image (the blur
// is produced by decoding a bitmap client-side), which a headless k6 VU cannot
// produce. A bot "drawing" with it emits MD/MM/MU that every receiver skips —
// `handleMouseDown` explicitly excludes glitchBlur from beginUserStroke — so it
// contributes nothing but noise while looking like coverage. Glitch is covered
// by the browser-driven suites instead.
//
// INKDROPPER is excluded for the same class of reason: it samples a colour and
// commits no pixels, so as a "stroke" it is a no-op.
const EXCLUDED_TOOLS = [Tool.GLITCH_BLUR, Tool.INKDROPPER];

// NO_PATTERN=1 removes every image-backed brush from the run: the PATTERN and
// IMAGE_BRUSH tools AND the pattern-fill checkbox on fill/select. They are one
// switch because they share one failure mode — the receiver assigns the brush
// only inside an `Image.onload`, so anything drawn before that decode finishes
// renders differently (or not at all). Splitting "strokes that depend on an
// async decode" from "strokes that don't" is the first cut to make on any
// observer divergence, and tool filtering alone cannot make it: pattern fills
// ride on FLOODFILL/SELECT, not on the PATTERN tool.
const NO_PATTERN = __ENV.NO_PATTERN === '1';
const IMAGE_BACKED_TOOLS = [Tool.PATTERN, Tool.IMAGE_BRUSH];
const TOOL_POOL = ALL_TOOLS
  .filter((t) => !EXCLUDED_TOOLS.includes(t))
  .filter((t) => !(NO_PATTERN && IMAGE_BACKED_TOOLS.includes(t)))
  .filter((t) => TOOL_FILTER.length === 0 || TOOL_FILTER.includes(TOOL_NAMES[t]));

const STROKE_LENGTH = [30, 110];
const STROKE_COUNT  = [2, 6];

/** Tools whose remote render consumes per-point stamp metadata (`rs`). */
const STAMP_TOOLS = [Tool.PEN, Tool.IMAGE_BRUSH, Tool.PATTERN, Tool.CONFETTI, Tool.BLUR, Tool.CIRCLE_BLUR];

function isStrokeTool(tool) {
  return tool !== Tool.TEXT && tool !== Tool.SELECT &&
         tool !== Tool.FLOODFILL && tool !== Tool.INKDROPPER;
}

/**
 * Deterministic per-VU RNG (mulberry32). k6's Math.random cannot be seeded, and
 * an unseeded feed means a failure found at 2am cannot be reproduced at 9am —
 * which has repeatedly turned a real divergence into "we saw it once".
 */
function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export default function () {
  const BASE_SEED = Number(__ENV.SEED || 0x5eed);
  const rng = makeRng(BASE_SEED + __VU * 7919);
  const rpick = (arr) => arr[Math.floor(rng() * arr.length)];
  const rint = (min, max) => min + Math.floor(rng() * (max - min + 1));
  const rcolor = () => randColor(rng);

  sleep(rng() * 2);

  const room = __ENV.ROOM || 'test';
  const baseUrl = __ENV.TARGET_URL || 'ws://127.0.0.1:8030';
  const url = `${baseUrl}/?room=${room}`;

  let sessionIndex = -1;

  const res = ws.connect(url, {}, function (socket) {
    socket.on('open', function () {
      socket.sendBinary(buildMsg({ t: T.CONNECT, n: `LOW_VU_${__VU}` }));

      const BOARD_WIDTH = 1920, BOARD_HEIGHT = 1080;
      const REGION_SIZE = 400, margin = 100;

      const homeX = rng() * (BOARD_WIDTH - REGION_SIZE - 2 * margin) + margin + REGION_SIZE / 2;
      const homeY = rng() * (BOARD_HEIGHT - REGION_SIZE - 2 * margin) + margin + REGION_SIZE / 2;

      let x = homeX, y = homeY, dx = 0, dy = 0;
      let state = 0; // 0=idle, 1=ready, 2=drawing
      let stateTicks = 0, cycleLength = 0;
      let currentTool = Tool.BRUSH;
      let strokesRemaining = 0;
      let idleTicks = 0;
      // Per-bot canvas state that must be tracked so the traffic stays coherent:
      // a SEL_COMMIT with no prior SEL_LIFT, or a REDO with an empty redo stack,
      // is a no-op that inflates message counts without changing any board.
      let activeLayer = 0;
      let selectionOpen = false;      // a lift is outstanding
      let undoDebt = 0;               // undos available to redo
      let pendingRedoTicks = -1;      // countdown to a deferred redo
      let strokeMeta = null;          // {layer, blendMode, radii} for the in-flight stroke
      let blendMode = 'source-over';
      let maskTicksRemaining = -1;    // countdown to clearing a selection mask

      /**
       * Switch layers the way `App.handleLayerSelect` does — including the part
       * that is easy to miss: selecting a layer that does not allow complex
       * blend modes RESETS the user's blend to source-over.
       *
       * Only layer 0 has `allowComplexBlendModes`, so a real client physically
       * cannot have `multiply` active while drawing on layer 1 or 2. A bot that
       * tracks blend and layer independently can, and then stamps that blend
       * onto every MD — and `RemoteUserHandler.handleMouseDown` applies
       * `data.blendMode` with NO layer clamp (unlike the `cbm` handler, which
       * does clamp). The result is a complex blend committing on a restricted
       * layer, which bakes through the lossy `_bakeFlatComplexBlendStroke` path
       * and diverges the observers by tens of percent.
       *
       * That is traffic the product never generates, so feeding it produces a
       * spectacular failure that is the harness's fault, not the product's. The
       * unclamped MD path is still worth hardening — a buggy or hostile client
       * could desync a room this way — but it is not reachable from the UI, so
       * the feed must not pretend it is.
       */
      function switchLayer(next) {
        activeLayer = next;
        sendLayerChange(socket, sessionIndex, activeLayer);
        if (activeLayer !== 0 && blendMode !== 'source-over') {
          blendMode = 'source-over';
          setBlendMode(socket, sessionIndex, blendMode, { rng, layer: activeLayer });
        }
      }
      // Track positions the bot has actually drawn on so floodfill only fires
      // on non-transparent pixels (random points in home region are mostly empty).
      const drawnPoints = [];
      // Points buffered between sends, so MM carries several samples like a real
      // client's per-tick flush rather than one point per message.
      let moveBuf = [];
      let radiiBuf = [];

      function recordDrawn(px, py) {
        drawnPoints.push({ x: px, y: py });
        if (drawnPoints.length > 64) drawnPoints.shift();
      }
      function pickDrawnPoint() {
        return drawnPoints.length ? drawnPoints[Math.floor(rng() * drawnPoints.length)] : null;
      }
      function homeRect(scale = 0.5) {
        return {
          x: homeX - (REGION_SIZE * scale) / 2,
          y: homeY - (REGION_SIZE * scale) / 2,
          width: REGION_SIZE * scale,
          height: REGION_SIZE * scale,
        };
      }
      function flushMoves() {
        if (!moveBuf.length) return;
        sendMoveBatch(socket, sessionIndex, moveBuf,
          strokeMeta && strokeMeta.radii ? radiiBuf : null,
          { stamp: true, confettiData: strokeMeta && strokeMeta.confettiData });
        moveBuf = [];
        radiiBuf = [];
      }

      /**
       * Close whatever selection is outstanding. Every verb here ENDS the
       * selection except flip and move, so the bot must know which it sent or
       * it desynchronises its own model from the receivers'.
       */
      function closeSelection() {
        if (!selectionOpen) return;
        closeSelectionWith(rpick(['commit', 'cancel', 'delete', 'fill', 'stamp']));
      }

      function closeSelectionWith(verb) {
        if (verb === 'commit') sendSelCommit(socket, sessionIndex, activeLayer);
        else if (verb === 'cancel') sendSelCancel(socket, sessionIndex);
        else if (verb === 'delete') sendSelDelete(socket, sessionIndex, activeLayer);
        else if (verb === 'fill') sendSelFill(socket, sessionIndex, rcolor(), activeLayer);
        else if (verb === 'stamp') { sendSelStamp(socket, sessionIndex, activeLayer); sendSelCommit(socket, sessionIndex, activeLayer); }
        selectionOpen = false;
      }

      socket.setInterval(function () {
        if (sessionIndex === -1) return;

        // Deferred redo. Firing REDO immediately after UNDO is the easy case and
        // the one least likely to break; letting other users' commits land in
        // between is where redo-vs-concurrent-commit ordering actually gets
        // tested.
        if (pendingRedoTicks > 0) pendingRedoTicks--;
        else if (pendingRedoTicks === 0) {
          pendingRedoTicks = -1;
          if (undoDebt > 0) { sendRedo(socket, sessionIndex); undoDebt--; }
        }

        if (state === 0) {
          idleTicks++;
          if (idleTicks < 15 + Math.floor(rng() * 30)) return;
          idleTicks = 0;

          // Occasionally fire a special non-stroke action and stay idle.
          if (rng() < SPECIAL_CHANCE && SPECIAL_POOL.length) {
            const action = rpick(SPECIAL_POOL);
            try {
              if (action === 'blendSwap') {
                // Aim the blend at the layer the bot is actually on. Only layer
                // 0 permits complex modes; receivers clamp the rest to
                // source-over, which is correct and worth exercising.
                // Complex modes are only offered on layer 0 (the only group with
                // allowComplexBlendModes), so a bot on layer 1/2 must stay on
                // source-over rather than pick from the full list.
                blendMode = activeLayer === 0 ? rpick(BLEND_MODES) : 'source-over';
                setBlendMode(socket, sessionIndex, blendMode, {
                  rng,
                  layer: activeLayer,
                  bakeMode: rng() < 0.5 ? 'background' : 'existing',
                });
              } else if (action === 'layerSwap') {
                switchLayer(rpick(LAYERS));
              } else if (action === 'selectionTransform') {
                closeSelection();
                performSelectionTransform(socket, sessionIndex, {
                  rng,
                  rect: homeRect(0.5),
                  layer: activeLayer,
                });
              } else if (action === 'selectionVerb') {
                fireSelectionVerb();
              } else if (action === 'floodFill') {
                const target = pickDrawnPoint();
                if (target) {
                  applyFloodFill(socket, sessionIndex, target.x, target.y, rcolor(), {
                    layer: activeLayer,
                    expansion: rng() < 0.3 ? rint(-10, 20) : 0,
                    blurRadius: rng() < 0.3 ? rint(0, 12) : 0,
                  });
                }
              } else if (action === 'undo') {
                sendUndo(socket, sessionIndex);
                undoDebt++;
                if (rng() < REDO_CHANCE) pendingRedoTicks = rint(3, 25);
              }
            } catch (_) { /* ignore */ }
            return;
          }

          strokesRemaining = rint(STROKE_COUNT[0], STROKE_COUNT[1]);
          currentTool = rpick(TOOL_POOL);

          // Switch layers between stroke bursts often enough that every layer
          // accumulates real content, undo history and bake pressure.
          if (rng() < 0.35) {
            switchLayer(rpick(LAYERS));
          }

          const confettiData = currentTool === Tool.CONFETTI ? makeConfettiPayload(rng) : undefined;
          configureTool(socket, sessionIndex, currentTool, {
            rng,
            color: rcolor(),
            size: rint(500, 2500),
            activeLayer,
            // Erase-all routes through beginStrokeAllLayers — a different commit
            // path that no bot has ever taken.
            eraseAll: currentTool === Tool.ERASE && rng() < 0.25,
            // Pattern fill is opt-in in configureTool (shared by seven feeds), so
            // this feed asks for it explicitly. Only rolled for the two tools that
            // can fill, to keep the RNG stream from shifting on every other tool.
            patternFill: (!NO_PATTERN && (currentTool === Tool.FLOODFILL || currentTool === Tool.SELECT))
              ? (rng() < 0.35)
              : false,
            confettiData,
          });

          const targetX = homeX + (rng() - 0.5) * REGION_SIZE;
          const targetY = homeY + (rng() - 0.5) * REGION_SIZE;
          x = Math.max(margin, Math.min(BOARD_WIDTH - margin, targetX));
          y = Math.max(margin, Math.min(BOARD_HEIGHT - margin, targetY));

          strokeMeta = {
            layer: activeLayer,
            blendMode,
            radii: STAMP_TOOLS.indexOf(currentTool) !== -1,
            confettiData,
          };

          sendMove(socket, sessionIndex, x, y);
          state = 1;
        }
        else if (state === 1) {
          if (currentTool === Tool.TEXT) {
            // Mix permanent (pixel) text with ephemeral overlay text. They take
            // different paths: text_pixel rasterises into a real stroke, while
            // the overlay variant expires and is legitimately absent from a
            // late joiner's tail once it has faded.
            const ephemeral = rng() < 0.4;
            applyTextWithFont(socket, sessionIndex, x, y, rpick(TEXT_PHRASES), rpick(FONTS), {
              rng,
              textPixel: !ephemeral,
              textLifetimeMs: ephemeral ? 30000 : 0,
              textFadeMs: ephemeral ? 3000 : 0,
            });
            strokesRemaining--;
            state = 0;
          } else if (currentTool === Tool.SELECT) {
            fireSelectionVerb();
            strokesRemaining--;
            state = 0;
          } else if (currentTool === Tool.FLOODFILL) {
            const target = pickDrawnPoint();
            if (target) {
              applyFloodFill(socket, sessionIndex, target.x, target.y, rcolor(), {
                layer: activeLayer,
                expansion: rng() < 0.3 ? rint(-10, 20) : 0,
                blurRadius: rng() < 0.3 ? rint(0, 12) : 0,
              });
            }
            strokesRemaining--;
            state = 0;
          } else if (isStrokeTool(currentTool)) {
            // Stamp the layer and blend onto the mousedown itself, the way every
            // real client does — the receiver applies these before it opens the
            // stroke, so this is the ordering the product actually ships.
            sendDown(socket, sessionIndex, x, y, {
              layer: strokeMeta.layer,
              blendMode: strokeMeta.blendMode,
              blendBakeMode: 'background',
              radii: strokeMeta.radii ? [rint(4, 30)] : null,
              confettiData: strokeMeta.confettiData,
            });
            cycleLength = rint(STROKE_LENGTH[0], STROKE_LENGTH[1]);
            state = 2;
            stateTicks = 0;
            dx = (rng() - 0.5) * 8;
            dy = (rng() - 0.5) * 8;
          } else {
            strokesRemaining--;
            state = 0;
          }
        }
        else if (state === 2) {
          stateTicks++;
          if (stateTicks < cycleLength) {
            dx += (rng() - 0.5) * 3;
            dy += (rng() - 0.5) * 3;
            dx = Math.max(-12, Math.min(12, dx));
            dy = Math.max(-12, Math.min(12, dy));
            x += dx; y += dy;

            const distFromHome = Math.sqrt((x - homeX) ** 2 + (y - homeY) ** 2);
            if (distFromHome > REGION_SIZE / 2) {
              dx *= -0.5; dy *= -0.5;
              x += (homeX - x) * 0.1;
              y += (homeY - y) * 0.1;
            }
            x = Math.max(margin, Math.min(BOARD_WIDTH - margin, x));
            y = Math.max(margin, Math.min(BOARD_HEIGHT - margin, y));

            moveBuf.push(x, y);
            if (strokeMeta && strokeMeta.radii) radiiBuf.push(rint(4, 30));
            // Flush every few ticks: a real client flushes its input buffer once
            // per tick with whatever accumulated, so batches of 2-4 points are
            // the shape to reproduce.
            if (moveBuf.length >= rint(2, 4) * 2) flushMoves();

            // Pressure changes mid-stroke make the brush commit the current
            // segment before applying the new value — a commit boundary that no
            // bot has ever produced.
            if (currentTool === Tool.BRUSH && rng() < 0.04) {
              flushMoves();
              sendPressure(socket, sessionIndex, 0.2 + rng() * 0.8);
            }

            if (isFillTargetTool(currentTool)) recordDrawn(x, y);
          } else {
            flushMoves();
            sendUp(socket, sessionIndex);
            strokesRemaining--;
            state = 0;
          }
        }
      }, 12); // ~83 TPS tick rate

      /**
       * Fire one complete selection sequence, chosen from the full verb set.
       *
       * The old feed only ever did lift → move → commit, so delete / fill /
       * stamp / flip / merge / mask / cancel and the entire lasso path had no
       * bot coverage at all — and those are exactly the verbs the selection
       * parity suite keeps finding bugs in (SEL_FLIP missing from joiner tails,
       * SEL_DELETE's seq landing at 0, the all-layers flag).
       */
      function fireSelectionVerb() {
        // Be on the select tool first. `broadcastSelectionLift` is only ever
        // called from SelectTool, so a real client ALWAYS has tool === 'select'
        // when a lift goes out. A bot that lifts while still on 'brush' produces
        // a state the product cannot reach, and the receiver's `ct` handler then
        // cancels the dangling selection at the bot's next tool change — an
        // interaction sequence no human generates.
        //
        // Same class of bug as the blend/layer coupling above: the bot tracked
        // "which verb to send" independently of "which tool am I holding", and
        // the real UI keeps those two welded together.
        if (currentTool !== Tool.SELECT) {
          socket.sendBinary(buildMsg({ t: T.CT, u: sessionIndex, l: Tool.SELECT }));
          currentTool = Tool.SELECT;
        }
        const rect = homeRect(0.5);
        const lasso = rng() < 0.4;
        sendSelLift(socket, sessionIndex, rect,
          lasso ? { lassoPath: makeLassoPath(rect, 7, rng) } : {});
        selectionOpen = true;

        const verb = rpick([
          'commit', 'cancel', 'delete', 'fill', 'stamp', 'flip', 'move_commit', 'merge', 'mask',
        ]);
        if (verb === 'flip') {
          // A flip transforms the floating selection IN PLACE and leaves it
          // live, so it must still be closed afterwards.
          sendSelFlip(socket, sessionIndex);
          sendSelCommit(socket, sessionIndex, activeLayer);
          selectionOpen = false;
        } else if (verb === 'move_commit') {
          const dxm = rint(-120, 120), dym = rint(-80, 80);
          sendSelMove(socket, sessionIndex, {
            tl: { x: rect.x + dxm, y: rect.y + dym },
            tr: { x: rect.x + rect.width + dxm, y: rect.y + dym },
            br: { x: rect.x + rect.width + dxm, y: rect.y + rect.height + dym },
            bl: { x: rect.x + dxm, y: rect.y + rect.height + dym },
          }, { sourceCrop: rect });
          sendSelCommit(socket, sessionIndex, activeLayer);
          selectionOpen = false;
        } else if (verb === 'merge') {
          sendSelCommit(socket, sessionIndex, activeLayer);
          selectionOpen = false;
          sendSelMerge(socket, sessionIndex, activeLayer, rpick(['up', 'down', 'all']));
        } else if (verb === 'mask') {
          sendSelCancel(socket, sessionIndex);
          selectionOpen = false;
          // Set a clip mask, then clear it a few strokes later. A mask left set
          // forever would silently constrain every later stroke and look like a
          // rendering bug rather than the bot's own state.
          sendSelMask(socket, sessionIndex, rect, lasso ? makeLassoPath(rect, 6, rng) : null);
          maskTicksRemaining = rint(40, 160);
        } else {
          closeSelectionWith(verb);
        }
      }

      // Mask lifetime, ticked down by its own interval so it survives whatever
      // the main state machine is doing.
      socket.setInterval(function () {
        if (sessionIndex === -1 || maskTicksRemaining < 0) return;
        if (maskTicksRemaining-- === 0) sendSelMask(socket, sessionIndex, null);
      }, 12);
    });

    socket.on('binaryMessage', function (data) {
      const { t, u, ts } = parseInbound(data);
      if (t === 0 && u !== -1 && sessionIndex === -1) sessionIndex = u;
      if (ts !== -1 && u !== sessionIndex) broadcastLatency.add(Date.now() - ts);
    });

    socket.on('error', (e) => console.log('WebSocket Error: ', e.error()));
    socket.setTimeout(() => socket.close(), 55000);
  });

  check(res, { 'Connected': (r) => r && r.status === 101 });
}
