#!/usr/bin/env python3
"""
board_state_compare.py — tolerance-based board-state comparison for multi-window sync tests.

Compares the composited board canvas captured from several live clients (three or
more Chrome windows driven over the DevTools MCP) and reports how closely they
agree. Rendering is never bit-exact across clients — antialiasing, soft-brush
hardness falloff and blend rounding all drift a channel value or two — so hashing
is useless here. This scores agreement per pixel with a tolerance instead.

Two thresholds are applied to every pixel:

    tolerance  (default 8)   max per-channel delta still counted as "identical".
                             Absorbs antialiasing / rounding noise.
    structural (default 48)  per-channel delta above which the pixel is counted
                             as a *structural* difference — real missing or extra
                             ink, e.g. a stroke that never synced, an erase that
                             only landed on one client, a shape drawn at the
                             wrong size.

A pair passes when match% >= --threshold (default 99.0) AND the structural
difference count is within --max-structural (default "0.05%" of the canvas).

The structural budget is not zero on purpose. Where geometry shifts by a
sub-pixel amount — e.g. an observer ends a shape on the last MM sample while the
drawer ends it on the true pointer-up point — the antialiased edge pixels along
an arc differ by a lot individually (deltas near 100) while amounting to almost
nothing. On a 2560x1440 board 0.05% is ~1,800 px, comfortably above that edge
noise and comfortably below a whole missing stroke (a circle outline is ~4,000
px, and a shape rendered at the wrong size ran to ~54,000).

Input
-----
Accepts any mix of, in a directory or as explicit paths:
  * .png                       — a saved board capture
  * .json / .txt               — output of the DevTools MCP `evaluate_script`
                                 tool saved via its `filePath` argument, with a
                                 `dataUrl` field somewhere in it (a data: URI).
                                 Keeps multi-megabyte base64 out of the agent
                                 transcript.

The label for each capture is the file stem (e.g. `A.json` -> `A`), so name
captures after the window/user they came from.

Usage
-----
    # compare every capture in a folder against the first one (alphabetical)
    python testing/devtools/board_state_compare.py captures/

    # pick the baseline explicitly, loosen the gate, write diff images
    python testing/devtools/board_state_compare.py captures/ \
        --baseline A --threshold 99.5 --out captures/diffs

    # compare two files directly
    python testing/devtools/board_state_compare.py a.png b.png

Exit code is 0 when every pair passes, 1 otherwise, so it can gate a suite.

The companion capture snippet lives in board_capture.js.
"""

from __future__ import annotations

import argparse
import base64
import json
import re
import sys
from itertools import combinations
from pathlib import Path

import numpy as np
from PIL import Image

# The board renders on white; flattening RGBA over white makes "transparent"
# and "painted white" compare equal, which is what a viewer actually sees.
BACKGROUND = (255, 255, 255)

DATA_URL_RE = re.compile(r"data:image/\w+;base64,([A-Za-z0-9+/=\s]+)")


def _decode_data_url(text: str) -> bytes | None:
    """Pull the first PNG data: URI out of arbitrary text and decode it."""
    match = DATA_URL_RE.search(text)
    if not match:
        return None
    return base64.b64decode(re.sub(r"\s+", "", match.group(1)))


def load_capture(path: Path) -> np.ndarray:
    """Load a capture file as an (H, W, 3) uint8 array flattened over white."""
    if path.suffix.lower() == ".png":
        raw = path.read_bytes()
    else:
        text = path.read_text(encoding="utf-8", errors="replace")
        raw = _decode_data_url(text)
        if raw is None:
            # Maybe it is JSON with the base64 stored bare rather than as a URI.
            try:
                blob = json.loads(text)
            except json.JSONDecodeError:
                raise SystemExit(f"{path.name}: no data: URI or JSON found")
            found = _find_b64(blob)
            if found is None:
                raise SystemExit(f"{path.name}: no image payload found")
            raw = base64.b64decode(found)

    import io

    img = Image.open(io.BytesIO(raw)).convert("RGBA")
    arr = np.asarray(img).astype(np.float32)
    alpha = arr[..., 3:4] / 255.0
    rgb = arr[..., :3] * alpha + np.array(BACKGROUND, dtype=np.float32) * (1.0 - alpha)
    return rgb.round().astype(np.uint8)


def _find_b64(node) -> str | None:
    """Depth-first search for a base64-ish string in decoded JSON."""
    if isinstance(node, str):
        if len(node) > 256 and re.fullmatch(r"[A-Za-z0-9+/=\s]+", node):
            return re.sub(r"\s+", "", node)
        return None
    if isinstance(node, dict):
        for value in node.values():
            found = _find_b64(value)
            if found:
                return found
    if isinstance(node, list):
        for value in node:
            found = _find_b64(value)
            if found:
                return found
    return None


def compare(a: np.ndarray, b: np.ndarray, tolerance: int, structural: int) -> dict:
    """Score two board states against each other."""
    if a.shape != b.shape:
        return {
            "size_mismatch": True,
            "shape_a": a.shape,
            "shape_b": b.shape,
        }

    delta = np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2)
    total = int(delta.size)

    within = delta <= tolerance
    struct_mask = delta > structural

    differing = total - int(within.sum())
    struct_count = int(struct_mask.sum())

    result = {
        "size_mismatch": False,
        "total_px": total,
        "match_pct": 100.0 * float(within.sum()) / total,
        "differing_px": differing,
        "structural_px": struct_count,
        "max_delta": int(delta.max()),
        "mean_delta": float(delta.mean()),
        "bbox": None,
        "struct_mask": struct_mask,
        "delta": delta,
    }

    # Bounding box of the structural differences — tells you *where* the two
    # clients disagree, which is usually enough to name the offending stroke.
    if struct_count:
        ys, xs = np.nonzero(struct_mask)
        result["bbox"] = {
            "x": int(xs.min()),
            "y": int(ys.min()),
            "w": int(xs.max() - xs.min() + 1),
            "h": int(ys.max() - ys.min() + 1),
        }
    return result


def write_diff(out_dir: Path, name: str, base: np.ndarray, res: dict) -> Path:
    """Write a diff image: greyed board, structural diffs in red, soft diffs blue."""
    out_dir.mkdir(parents=True, exist_ok=True)
    grey = base.mean(axis=2).astype(np.uint8)
    canvas = np.stack([grey, grey, grey], axis=2)
    canvas = (canvas * 0.35 + 255 * 0.65).astype(np.uint8)  # fade the backdrop

    soft = (res["delta"] > 0) & ~res["struct_mask"]
    canvas[soft] = (60, 120, 255)
    canvas[res["struct_mask"]] = (255, 32, 32)

    path = out_dir / f"diff_{name}.png"
    Image.fromarray(canvas).save(path)
    return path


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Tolerance-based board-state comparison across live clients.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("paths", nargs="+", help="capture files, or a directory of them")
    ap.add_argument("--tolerance", type=int, default=8,
                    help="max per-channel delta counted as identical (default 8)")
    ap.add_argument("--structural", type=int, default=48,
                    help="per-channel delta counted as a real difference (default 48)")
    ap.add_argument("--threshold", type=float, default=99.0,
                    help="min match%% for a pair to pass (default 99.0)")
    ap.add_argument("--max-structural", default="0.05%",
                    help="structural px allowed before failing: an absolute "
                         "count, or a percentage of the canvas (default 0.05%%)")
    ap.add_argument("--baseline", default=None,
                    help="label to compare everything against (default: all pairs)")
    ap.add_argument("--out", default=None, help="directory for diff images")
    args = ap.parse_args()

    files: list[Path] = []
    for raw in args.paths:
        p = Path(raw)
        if p.is_dir():
            files.extend(sorted(
                q for q in p.iterdir()
                if q.suffix.lower() in (".png", ".json", ".txt")
                and not q.name.startswith("diff_")
            ))
        else:
            files.append(p)

    if len(files) < 2:
        print(f"Need at least 2 captures, found {len(files)}", file=sys.stderr)
        return 1

    boards = {f.stem: load_capture(f) for f in files}
    labels = list(boards)

    total_px = int(next(iter(boards.values())).shape[0]
                   * next(iter(boards.values())).shape[1])
    raw_budget = str(args.max_structural).strip()
    if raw_budget.endswith("%"):
        budget = int(total_px * float(raw_budget[:-1]) / 100.0)
        budget_label = f"{raw_budget} ({budget:,} px)"
    else:
        budget = int(float(raw_budget))
        budget_label = f"{budget:,} px"

    print(f"Loaded {len(labels)} captures: {', '.join(labels)}")
    print(f"tolerance={args.tolerance}  structural={args.structural}  "
          f"threshold={args.threshold}%  max-structural={budget_label}\n")

    if args.baseline:
        if args.baseline not in boards:
            print(f"Baseline '{args.baseline}' not among {labels}", file=sys.stderr)
            return 1
        pairs = [(args.baseline, o) for o in labels if o != args.baseline]
    else:
        pairs = list(combinations(labels, 2))

    out_dir = Path(args.out) if args.out else None
    failures = 0

    for left, right in pairs:
        res = compare(boards[left], boards[right], args.tolerance, args.structural)
        tag = f"{left} vs {right}"

        if res["size_mismatch"]:
            print(f"FAIL  {tag}: canvas size differs "
                  f"{res['shape_a']} vs {res['shape_b']}")
            failures += 1
            continue

        ok = (res["match_pct"] >= args.threshold
              and res["structural_px"] <= budget)
        status = "PASS" if ok else "FAIL"
        if not ok:
            failures += 1

        print(f"{status}  {tag}")
        print(f"        match {res['match_pct']:.4f}%   "
              f"differing {res['differing_px']:,}   "
              f"structural {res['structural_px']:,}")
        print(f"        max delta {res['max_delta']}   "
              f"mean delta {res['mean_delta']:.3f}")
        if res["bbox"]:
            b = res["bbox"]
            print(f"        differs in region x={b['x']} y={b['y']} "
                  f"w={b['w']} h={b['h']}")
        if out_dir and not ok:
            path = write_diff(out_dir, f"{left}_vs_{right}", boards[left], res)
            print(f"        diff image -> {path}")
        print()

    total = len(pairs)
    print(f"{total - failures}/{total} pairs agree "
          f"(>= {args.threshold}% match, <= {budget:,} structural px)")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
