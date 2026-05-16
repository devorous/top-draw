# Comprehensive Sync Report

Generated: 2026-05-16T08:38:59.240Z
Room: `comp_sync_1778920719705`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±16 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 1/1 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Flood (1/1)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| flood_drawer_25_then_undo | ✅ | 12611ms | 99.982% | 243 | 17 / 17 / 17 | 1 / 1 / 1 |

