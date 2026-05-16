# Comprehensive Sync Report

Generated: 2026-05-16T08:28:58.671Z
Room: `comp_sync_1778920125296`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±16 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 1/1 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Special (1/1)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| undo_after_strokes | ✅ | 6710ms | 100.000% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |

