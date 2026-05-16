# Comprehensive Sync Report

Generated: 2026-05-16T07:22:21.308Z
Room: `comp_sync_1778916128700`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±16 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 1/1 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Special (1/1)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| eraser_over_strokes | ✅ | 6115ms | 99.959% | 255 | 5 / 5 / 5 | 1 / 1 / 1 |

