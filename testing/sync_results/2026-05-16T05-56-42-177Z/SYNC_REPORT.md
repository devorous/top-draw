# Comprehensive Sync Report

Generated: 2026-05-16T05:57:14.404Z
Room: `comp_sync_1778911002178`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±16 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 5/5 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (5/5)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| confetti_step_1 | ✅ | 5088ms | 99.954% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_2 | ✅ | 5067ms | 99.873% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_3 | ✅ | 4987ms | 99.915% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_4 | ✅ | 5179ms | 99.931% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_5 | ✅ | 5114ms | 99.833% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

