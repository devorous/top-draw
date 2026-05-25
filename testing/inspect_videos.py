"""Probe time-lapse export webm files — decode every frame sequentially so we
catch truncated streams, and sample mean brightness across the timeline so we
can tell the export actually captured drawing content (not all-white)."""
import os, sys, glob, cv2

DIR = os.path.join(os.path.dirname(__file__), 'timelapse')
files = sorted(glob.glob(os.path.join(DIR, '*.webm')))
if not files:
    print('no webm files in', DIR); sys.exit(1)

for path in files:
    name = os.path.basename(path)
    cap = cv2.VideoCapture(path)
    if not cap.isOpened():
        print(name, 'FAILED TO OPEN'); continue
    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    reported_fps = cap.get(cv2.CAP_PROP_FPS) or 0.0
    reported_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    size_kb = os.path.getsize(path) / 1024
    # Walk every frame sequentially.
    means = []
    while True:
        ok, frame = cap.read()
        if not ok: break
        means.append(float(frame.mean()))
    n = len(means)
    # cv2 also exposes the last successful pts in ms.
    last_pts_ms = cap.get(cv2.CAP_PROP_POS_MSEC)
    cap.release()
    if n == 0:
        print(name, 'no frames decoded'); continue
    # Sample brightness across the timeline to confirm content evolves.
    indices = [0, n // 4, n // 2, 3 * n // 4, n - 1]
    samples = [(i, round(means[i], 1)) for i in indices]
    # Count "drawing" frames (mean clearly below pure-white 255).
    nontrivial = sum(1 for m in means if m < 250.0)
    print(f'{name}')
    print(f'  size={size_kb:.0f}KB  dims={w}x{h}  reportedFps={reported_fps:.1f}  reportedFrames={reported_frames}')
    print(f'  decodedFrames={n}  lastPTS={last_pts_ms/1000:.2f}s  realFps={n/(last_pts_ms/1000):.2f}' if last_pts_ms > 0 else f'  decodedFrames={n}')
    print(f'  brightness samples (0,25%,50%,75%,end): {samples}')
    print(f'  nontrivial frames (<250 mean): {nontrivial}/{n}  ({100*nontrivial/n:.0f}%)')
