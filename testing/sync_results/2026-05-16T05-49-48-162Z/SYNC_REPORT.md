# Comprehensive Sync Report

Generated: 2026-05-16T05:53:17.863Z
Room: `comp_sync_1778910588163`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±4 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 33/40 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (33/40)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| ink_step_1 | ✅ | 5125ms | 99.982% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_2 | ✅ | 5250ms | 99.973% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_3 | ✅ | 5131ms | 99.984% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_4 | ✅ | 5448ms | 99.999% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_5 | ✅ | 5134ms | 99.996% | 64 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_1 | ✅ | 5219ms | 99.985% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_2 | ✅ | 5145ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_3 | ❌ | 5209ms | 99.373% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_4 | ❌ | 5190ms | 99.333% | 19 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_5 | ✅ | 5249ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_1 | ✅ | 5004ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_2 | ✅ | 5061ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_3 | ✅ | 5008ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_4 | ✅ | 5086ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_5 | ✅ | 5090ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_1 | ✅ | 5151ms | 99.902% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_2 | ✅ | 5118ms | 99.966% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_3 | ✅ | 5330ms | 99.962% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_4 | ✅ | 5269ms | 99.996% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_5 | ✅ | 5121ms | 100.000% | 2 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_1 | ✅ | 4820ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_2 | ✅ | 4804ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_3 | ✅ | 4786ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_4 | ✅ | 4832ms | 100.000% | 3 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_5 | ✅ | 4805ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_1 | ✅ | 4817ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_2 | ✅ | 4809ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_3 | ✅ | 4822ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_4 | ✅ | 4826ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_5 | ✅ | 4811ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_1 | ✅ | 4845ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_2 | ✅ | 4802ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_3 | ✅ | 4819ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_4 | ✅ | 4816ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_5 | ✅ | 4820ms | 99.785% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_1 | ❌ | 5068ms | 98.685% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_2 | ❌ | 5048ms | 96.085% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_3 | ❌ | 4988ms | 97.307% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_4 | ❌ | 5183ms | 98.573% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_5 | ❌ | 5127ms | 97.779% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Failure detail

### brush_step_3

- Worst match: **99.373%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.373% (maxΔ 255)
    - group 0: 99.373% match · maxΔ 255 · bbox 440×362@(905,39) · 158282/159280 px
- bot_2 vs drawer: 99.373% (maxΔ 255)
    - group 0: 99.373% match · maxΔ 255 · bbox 440×362@(905,39) · 158282/159280 px
- Screenshots: `FAIL_brush_step_3__bot_*.png`

### brush_step_4

- Worst match: **99.333%**  Worst maxΔ: **19**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.333% (maxΔ 19)
    - group 0: 99.333% match · maxΔ 19 · bbox 208×163@(585,688) · 33678/33904 px
- bot_2 vs drawer: 99.333% (maxΔ 19)
    - group 0: 99.333% match · maxΔ 19 · bbox 208×163@(585,688) · 33678/33904 px
- Screenshots: `FAIL_brush_step_4__bot_*.png`

### confetti_step_1

- Worst match: **98.685%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.685% (maxΔ 255)
    - group 0: 98.685% match · maxΔ 255 · bbox 367×401@(1023,264) · 145232/147167 px
- bot_2 vs drawer: 98.685% (maxΔ 255)
    - group 0: 98.685% match · maxΔ 255 · bbox 367×401@(1023,264) · 145232/147167 px
- Screenshots: `FAIL_confetti_step_1__bot_*.png`

### confetti_step_2

- Worst match: **96.085%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 96.085% (maxΔ 255)
    - group 0: 96.085% match · maxΔ 255 · bbox 431×328@(508,375) · 135834/141368 px
- bot_2 vs drawer: 96.085% (maxΔ 255)
    - group 0: 96.085% match · maxΔ 255 · bbox 431×328@(508,375) · 135834/141368 px
- Screenshots: `FAIL_confetti_step_2__bot_*.png`

### confetti_step_3

- Worst match: **97.307%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 97.307% (maxΔ 255)
    - group 0: 97.307% match · maxΔ 255 · bbox 357×367@(526,582) · 127491/131019 px
- bot_2 vs drawer: 97.307% (maxΔ 255)
    - group 0: 97.307% match · maxΔ 255 · bbox 357×367@(526,582) · 127491/131019 px
- Screenshots: `FAIL_confetti_step_3__bot_*.png`

### confetti_step_4

- Worst match: **98.573%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.573% (maxΔ 255)
    - group 0: 98.573% match · maxΔ 255 · bbox 340×387@(1156,169) · 129703/131580 px
- bot_2 vs drawer: 98.573% (maxΔ 255)
    - group 0: 98.573% match · maxΔ 255 · bbox 340×387@(1156,169) · 129703/131580 px
- Screenshots: `FAIL_confetti_step_4__bot_*.png`

### confetti_step_5

- Worst match: **97.779%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 97.779% (maxΔ 255)
    - group 0: 97.779% match · maxΔ 255 · bbox 402×428@(1456,315) · 168235/172056 px
- bot_2 vs drawer: 97.779% (maxΔ 255)
    - group 0: 97.779% match · maxΔ 255 · bbox 402×428@(1456,315) · 168235/172056 px
- Screenshots: `FAIL_confetti_step_5__bot_*.png`

