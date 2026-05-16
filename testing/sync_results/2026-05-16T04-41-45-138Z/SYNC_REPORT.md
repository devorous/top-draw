# Comprehensive Sync Report

Generated: 2026-05-16T04:41:57.759Z
Room: `comp_sync_1778906505139`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±4 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 0/1 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (0/1)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| flowPen_step_1 | ❌ | 5073ms | 98.735% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Failure detail

### flowPen_step_1

- Worst match: **98.735%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.735% (maxΔ 255)
    - group 0: 98.735% match · maxΔ 255 · bbox 274×253@(693,572) · 68445/69322 px
- bot_2 vs drawer: 98.735% (maxΔ 255)
    - group 0: 98.735% match · maxΔ 255 · bbox 274×253@(693,572) · 68445/69322 px
- Screenshots: `FAIL_flowpen_step_1__bot_*.png`

