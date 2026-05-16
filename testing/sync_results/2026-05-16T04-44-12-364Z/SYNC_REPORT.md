# Comprehensive Sync Report

Generated: 2026-05-16T04:44:50.129Z
Room: `comp_sync_1778906652366`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±4 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 5/6 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (5/6)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| pixel_step_1 | ✅ | 5014ms | 99.835% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_2 | ✅ | 5099ms | 99.790% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_3 | ✅ | 5012ms | 99.724% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_4 | ✅ | 5077ms | 99.745% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_5 | ✅ | 5072ms | 99.790% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_1 | ❌ | 5076ms | 98.833% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Failure detail

### flowPen_step_1

- Worst match: **98.833%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.833% (maxΔ 255)
    - group 0: 98.833% match · maxΔ 255 · bbox 276×253@(691,572) · 69013/69828 px
- bot_2 vs drawer: 98.833% (maxΔ 255)
    - group 0: 98.833% match · maxΔ 255 · bbox 276×253@(691,572) · 69013/69828 px
- Screenshots: `FAIL_flowpen_step_1__bot_*.png`

