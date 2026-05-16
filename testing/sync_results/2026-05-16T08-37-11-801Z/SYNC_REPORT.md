# Comprehensive Sync Report

Generated: 2026-05-16T08:37:32.902Z
Room: `comp_sync_1778920631802`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±16 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 0/1 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Flood (0/1)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| flood_drawer_25_then_undo | ❌ | 12738ms | 91.812% | 255 | ❌ 17 / 20 / 20 | 1 / 1 / 1 |

## Failure detail

### flood_drawer_25_then_undo

- Worst match: **91.812%**  Worst maxΔ: **255**
- Stroke totals: 17 / 20 / 20 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 91.812% (maxΔ 255)
    - group 0: 91.812% match · maxΔ 255 · bbox 1313×900@(186,66) · 1084943/1181700 px
- bot_2 vs drawer: 91.812% (maxΔ 255)
    - group 0: 91.812% match · maxΔ 255 · bbox 1313×900@(186,66) · 1084943/1181700 px
- Screenshots: `FAIL_flood_drawer_25_then_undo__bot_*.png`

