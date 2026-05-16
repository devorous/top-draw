# Comprehensive Sync Report

Generated: 2026-05-16T05:15:12.676Z
Room: `comp_sync_1778908500819`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±4 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 0/1 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (0/1)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| line_step_4 | ❌ | 4810ms | 95.341% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Failure detail

### line_step_4

- Worst match: **95.341%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 95.341% (maxΔ 255)
    - group 0: 95.341% match · maxΔ 255 · bbox 31×27@(427,490) · 798/837 px
- bot_2 vs drawer: 95.341% (maxΔ 255)
    - group 0: 95.341% match · maxΔ 255 · bbox 31×27@(427,490) · 798/837 px
- Screenshots: `FAIL_line_step_4__bot_*.png`

