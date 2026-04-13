#!/usr/bin/env python3
"""
compare_sync.py — Canvas sync diff analyser for Top Draw.

Loads PNG screenshots from a sync_results run folder, groups them by tool,
and compares every bot's canvas against bot_0 (the drawer).

Usage:
    # Compare the latest run automatically
    python testing/compare_sync.py

    # Compare a specific run
    python testing/compare_sync.py testing/sync_results/2026-04-13T12-00-00-000Z

    # Compare two specific images directly
    python testing/compare_sync.py image_a.png image_b.png

Outputs:
    - Per-tool diff stats printed to stdout
    - diff_<tool>_<bot>.png  saved next to the source images (red = pixel differs)
    - heatmap_<tool>.png     overlaid heatmap of all bots' differences combined
    - compare_report.txt     plain-text summary of the whole run
"""

import sys
import os
import json
import re
import glob
from pathlib import Path
from collections import defaultdict

import numpy as np
from PIL import Image, ImageDraw, ImageFont


# ── Colour constants for the diff overlay ────────────────────────────────────

DIFF_COLOUR  = (255, 40,  40, 200)   # red — pixel differs
MATCH_COLOUR = (  0,  0,   0,   0)   # transparent — pixel matches
HEAT_CMAP    = [                      # blue → yellow → red heatmap
    (  0,   0, 180),
    (  0, 180, 255),
    (  0, 255, 120),
    (255, 220,   0),
    (255,  60,   0),
]


def lerp_colour(t, cmap):
    """Interpolate a colour from a list of RGB stops for t in [0, 1]."""
    if t <= 0: return cmap[0]
    if t >= 1: return cmap[-1]
    seg   = t * (len(cmap) - 1)
    lo    = int(seg)
    hi    = min(lo + 1, len(cmap) - 1)
    frac  = seg - lo
    return tuple(int(cmap[lo][c] + frac * (cmap[hi][c] - cmap[lo][c])) for c in range(3))


# ── Core diff logic ───────────────────────────────────────────────────────────

def load_rgba(path: Path) -> np.ndarray:
    """Load an image as a float32 RGBA array normalised to [0, 1]."""
    img = Image.open(path).convert('RGBA')
    return np.array(img, dtype=np.float32) / 255.0


def diff_stats(a: np.ndarray, b: np.ndarray) -> dict:
    """
    Compare two RGBA float32 arrays of the same shape.
    Returns a dict of statistics.
    """
    assert a.shape == b.shape, f"Shape mismatch: {a.shape} vs {b.shape}"

    delta       = np.abs(a - b)                    # (H, W, 4)
    per_pixel   = delta.mean(axis=2)               # (H, W) mean RGBA diff per pixel
    changed_mask = per_pixel > (1 / 255)           # pixels that differ at all

    changed_count = int(changed_mask.sum())
    total_pixels  = a.shape[0] * a.shape[1]
    pct_changed   = 100.0 * changed_count / total_pixels

    # Per-channel stats
    channel_names = ['R', 'G', 'B', 'A']
    channels = {}
    for i, ch in enumerate(channel_names):
        d = delta[:, :, i]
        channels[ch] = {
            'mean':    float(d.mean()),
            'max':     float(d.max()),
            'std':     float(d.std()),
        }

    # Bounding box of changed region
    rows = np.any(changed_mask, axis=1)
    cols = np.any(changed_mask, axis=0)
    if rows.any():
        r0, r1 = int(rows.argmax()), int(len(rows) - rows[::-1].argmax() - 1)
        c0, c1 = int(cols.argmax()), int(len(cols) - cols[::-1].argmax() - 1)
        bbox = (c0, r0, c1, r1)
        bbox_area = (c1 - c0 + 1) * (r1 - r0 + 1)
    else:
        bbox = None
        bbox_area = 0

    # Largest contiguous diff cluster (crude: connected component of changed pixels)
    # Using a fast flood-fill estimate via dilation
    cluster_size = _largest_cluster(changed_mask)

    # Overall severity: 0 = identical, 1 = completely different
    severity = float(per_pixel.mean())

    return {
        'total_pixels':   total_pixels,
        'changed_pixels': changed_count,
        'pct_changed':    pct_changed,
        'severity':       severity,
        'channels':       channels,
        'bbox':           bbox,
        'bbox_area':      bbox_area,
        'largest_cluster': cluster_size,
        'mask':           changed_mask,
        'delta':          per_pixel,
    }


def _largest_cluster(mask: np.ndarray) -> int:
    """Estimate the largest contiguous diff region via a simple BFS."""
    if not mask.any():
        return 0
    visited = np.zeros_like(mask, dtype=bool)
    H, W    = mask.shape
    best    = 0

    # Only BFS from a subset of changed pixels to keep it fast
    ys, xs = np.where(mask)
    step    = max(1, len(ys) // 500)   # sample at most 500 seeds

    for idx in range(0, len(ys), step):
        sy, sx = int(ys[idx]), int(xs[idx])
        if visited[sy, sx]:
            continue
        # BFS
        queue   = [(sy, sx)]
        visited[sy, sx] = True
        size    = 0
        while queue:
            y, x = queue.pop()
            if not mask[y, x]:
                continue
            size += 1
            for dy, dx in ((-1,0),(1,0),(0,-1),(0,1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < H and 0 <= nx < W and not visited[ny, nx]:
                    visited[ny, nx] = True
                    queue.append((ny, nx))
        best = max(best, size)

    return best


# ── Diff image generation ─────────────────────────────────────────────────────

def make_diff_image(a: np.ndarray, b: np.ndarray, mask: np.ndarray) -> Image.Image:
    """
    Returns a side-by-side comparison image:
      left  = image A  |  right = image B  |  far right = red diff overlay on A
    """
    H, W = a.shape[:2]
    out  = Image.new('RGBA', (W * 3, H), (30, 30, 30, 255))

    img_a = Image.fromarray((a * 255).astype(np.uint8), 'RGBA')
    img_b = Image.fromarray((b * 255).astype(np.uint8), 'RGBA')

    # Diff overlay: A + red highlights
    overlay_data       = (a * 255).astype(np.uint8).copy()
    overlay_data[mask] = DIFF_COLOUR
    img_overlay        = Image.fromarray(overlay_data, 'RGBA')

    out.paste(img_a,      (0,     0))
    out.paste(img_b,      (W,     0))
    out.paste(img_overlay,(W * 2, 0))

    # Label strip
    draw = ImageDraw.Draw(out)
    for x, label in [(4, 'Bot 0 (drawer)'), (W + 4, 'Bot N (observer)'), (W * 2 + 4, 'Diff overlay')]:
        draw.rectangle([x, 0, x + 160, 18], fill=(0, 0, 0, 180))
        draw.text((x + 2, 2), label, fill=(255, 255, 255))

    return out


def make_heatmap(delta_stack: list[np.ndarray], shape: tuple) -> Image.Image:
    """
    Combine multiple (H,W) delta arrays into a single heatmap image.
    Brighter/redder = more bots disagree at that pixel.
    """
    H, W   = shape[:2]
    combined = np.zeros((H, W), dtype=np.float32)
    for d in delta_stack:
        combined += d
    combined /= max(len(delta_stack), 1)

    # Normalise to [0, 1]
    m = combined.max()
    if m > 0:
        combined /= m

    rgb = np.zeros((H, W, 3), dtype=np.uint8)
    # Vectorised colour mapping (coarse but fast)
    for y in range(H):
        for x in range(W):
            r, g, b = lerp_colour(float(combined[y, x]), HEAT_CMAP)
            rgb[y, x] = (r, g, b)

    return Image.fromarray(rgb, 'RGB')


# ── Report formatting ─────────────────────────────────────────────────────────

SEVERITY_LABELS = [
    (0.000,  'identical'),
    (0.001,  'imperceptible'),
    (0.005,  'minor'),
    (0.020,  'moderate'),
    (0.060,  'significant'),
    (1.000,  'severe'),
]

def severity_label(s: float) -> str:
    for threshold, label in SEVERITY_LABELS:
        if s <= threshold:
            return label
    return 'severe'


def format_stats(stats: dict, label: str) -> str:
    s     = stats['severity']
    sev   = severity_label(s)
    lines = [
        f"  {label}",
        f"    Changed pixels : {stats['changed_pixels']:,} / {stats['total_pixels']:,}  ({stats['pct_changed']:.2f}%)",
        f"    Severity       : {s:.5f}  [{sev}]",
        f"    Largest cluster: {stats['largest_cluster']:,} px",
    ]
    if stats['bbox']:
        c0, r0, c1, r1 = stats['bbox']
        lines.append(f"    Diff region    : ({c0},{r0}) → ({c1},{r1})  area={stats['bbox_area']:,} px")
    for ch, v in stats['channels'].items():
        if v['max'] > 0:
            lines.append(f"    Channel {ch}      : mean={v['mean']:.4f}  max={v['max']:.4f}  std={v['std']:.4f}")
    return '\n'.join(lines)


# ── Run-folder mode ───────────────────────────────────────────────────────────

def find_latest_run() -> Path | None:
    base = Path(__file__).parent / 'sync_results'
    if not base.exists():
        return None
    runs = sorted(base.iterdir(), reverse=True)
    return next((r for r in runs if r.is_dir()), None)


def group_screenshots(folder: Path) -> dict[str, list[Path]]:
    """
    Group PNG files by tool name.
    Filename pattern: fail_<tool>_<bot>.png  or  pass_<tool>_<bot>.png
    """
    groups = defaultdict(list)
    for p in sorted(folder.glob('*.png')):
        # strip leading pass_/fail_ and trailing _bot_N
        m = re.match(r'^(?:fail|pass)_(.+?)_(bot_\d+)\.png$', p.name)
        if m:
            groups[m.group(1)].append(p)
    return dict(groups)


def run_folder_analysis(folder: Path):
    groups  = group_screenshots(folder)
    summary_json = folder / 'summary.json'
    run_meta = {}
    if summary_json.exists():
        run_meta = json.loads(summary_json.read_text())

    if not groups:
        print(f"No screenshots found in {folder}")
        print("(Screenshots are only saved on FAIL — run the sync suite first.)")
        return

    report_lines = [
        f"Top Draw Sync Diff Report",
        f"Run: {folder.name}",
        f"Bots: {run_meta.get('bots', '?')}  |  Propagation: {run_meta.get('propagationMs', '?')}ms",
        f"Pass: {run_meta.get('passed', '?')}/{run_meta.get('total', '?')}",
        "",
    ]

    all_pass  = True
    tool_rows = []   # for the final table

    for tool_key, paths in sorted(groups.items()):
        print(f"\n{'─'*60}")
        print(f"Tool: {tool_key}  ({len(paths)} screenshots)")

        # bot_0 is the reference (drawer)
        ref_path  = next((p for p in paths if 'bot_0' in p.name), paths[0])
        ref       = load_rgba(ref_path)
        deltas    = []

        report_lines.append(f"Tool: {tool_key}")

        worst_severity = 0.0
        for cmp_path in paths:
            if cmp_path == ref_path:
                continue
            cmp    = load_rgba(cmp_path)
            if ref.shape != cmp.shape:
                print(f"  ⚠ Size mismatch: {ref_path.name} {ref.shape} vs {cmp_path.name} {cmp.shape}")
                continue

            stats  = diff_stats(ref, cmp)
            label  = f"{ref_path.name}  vs  {cmp_path.name}"
            print(format_stats(stats, label))
            report_lines.append(format_stats(stats, label))

            worst_severity = max(worst_severity, stats['severity'])
            deltas.append(stats['delta'])

            # Save side-by-side diff image
            diff_img  = make_diff_image(ref, cmp, stats['mask'])
            diff_out  = folder / f"diff_{tool_key}_{cmp_path.stem}.png"
            diff_img.save(diff_out)
            print(f"  → Saved {diff_out.name}")

        # Heatmap across all observers
        if deltas:
            hmap     = make_heatmap(deltas, ref.shape)
            hmap_out = folder / f"heatmap_{tool_key}.png"
            hmap.save(hmap_out)
            print(f"  → Saved {hmap_out.name}")

        verdict = severity_label(worst_severity)
        tool_rows.append((tool_key, worst_severity, verdict))
        if worst_severity > 0.001:
            all_pass = False
        report_lines.append("")

    # Summary table
    print(f"\n{'═'*60}")
    print(f"{'Tool':<28} {'Severity':>10}  {'Verdict'}")
    print(f"{'─'*60}")
    for tool_key, sev, verdict in sorted(tool_rows, key=lambda x: -x[1]):
        icon  = '✅' if sev <= 0.001 else ('⚠️ ' if sev <= 0.02 else '❌')
        print(f"  {icon} {tool_key:<24} {sev:>10.5f}  {verdict}")
    print(f"{'═'*60}\n")

    report_path = folder / 'compare_report.txt'
    report_lines += [
        "Summary",
        f"{'Tool':<28} {'Severity':>10}  Verdict",
    ] + [f"  {t:<28} {s:>10.5f}  {v}" for t, s, v in sorted(tool_rows, key=lambda x: -x[1])]
    report_path.write_text('\n'.join(report_lines))
    print(f"Report saved → {report_path}\n")


# ── Two-image mode ────────────────────────────────────────────────────────────

def run_two_image(path_a: str, path_b: str):
    a = load_rgba(Path(path_a))
    b = load_rgba(Path(path_b))

    if a.shape != b.shape:
        print(f"Size mismatch: {path_a} {a.shape} vs {path_b} {b.shape}")
        sys.exit(1)

    stats = diff_stats(a, b)
    print(format_stats(stats, f"{path_a}  vs  {path_b}"))

    diff_img  = make_diff_image(a, b, stats['mask'])
    out_path  = Path(path_a).with_name('diff_comparison.png')
    diff_img.save(out_path)
    print(f"\nDiff image saved → {out_path}")

    if stats['changed_pixels'] > 0:
        hmap     = make_heatmap([stats['delta']], a.shape)
        hmap_out = Path(path_a).with_name('heatmap_comparison.png')
        hmap.save(hmap_out)
        print(f"Heatmap saved   → {hmap_out}")


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == '__main__':
    args = sys.argv[1:]

    if len(args) == 2 and args[0].endswith('.png') and args[1].endswith('.png'):
        run_two_image(args[0], args[1])

    elif len(args) == 1:
        folder = Path(args[0])
        if not folder.is_dir():
            print(f"Not a directory: {folder}")
            sys.exit(1)
        run_folder_analysis(folder)

    else:
        folder = find_latest_run()
        if folder is None:
            print("No sync_results folder found. Run `npm run test:sync` first.")
            sys.exit(1)
        print(f"Analysing latest run: {folder.name}")
        run_folder_analysis(folder)
