# Comprehensive Sync Report

Generated: 2026-05-16T04:51:23.143Z
Room: `comp_sync_1778907043586`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±4 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 3/6 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (3/6)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| brush_step_1 | ✅ | 5253ms | 99.971% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_2 | ✅ | 5145ms | 99.572% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_3 | ❌ | 5214ms | 93.718% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_4 | ✅ | 5171ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_5 | ❌ | 5198ms | 82.526% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_1 | ❌ | 5092ms | 43.986% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Failure detail

### brush_step_3

- Worst match: **93.718%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 93.718% (maxΔ 255)
    - group 0: 93.718% match · maxΔ 255 · bbox 513×511@(873,0) · 245675/262143 px
- bot_2 vs drawer: 93.718% (maxΔ 255)
    - group 0: 93.718% match · maxΔ 255 · bbox 513×511@(873,0) · 245675/262143 px
- Screenshots: `FAIL_brush_step_3__bot_*.png`

### brush_step_5

- Worst match: **82.526%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 82.526% (maxΔ 255)
    - group 0: 82.526% match · maxΔ 255 · bbox 404×441@(839,615) · 147031/178164 px
- bot_2 vs drawer: 82.526% (maxΔ 255)
    - group 0: 82.526% match · maxΔ 255 · bbox 404×441@(839,615) · 147031/178164 px
- Screenshots: `FAIL_brush_step_5__bot_*.png`

### flowPen_step_1

- Worst match: **43.986%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 43.986% (maxΔ 255)
    - group 0: 43.986% match · maxΔ 255 · bbox 322×300@(669,548) · 42490/96600 px
- bot_2 vs drawer: 43.986% (maxΔ 255)
    - group 0: 43.986% match · maxΔ 255 · bbox 322×300@(669,548) · 42490/96600 px
- Screenshots: `FAIL_flowpen_step_1__bot_*.png`

