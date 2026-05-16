# Comprehensive Sync Report

Generated: 2026-05-16T05:38:19.035Z
Room: `comp_sync_1778909689620`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±4 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 29/40 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (29/40)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| ink_step_1 | ✅ | 5104ms | 99.982% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_2 | ✅ | 5237ms | 99.987% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_3 | ✅ | 5153ms | 99.991% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_4 | ✅ | 5278ms | 99.998% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_5 | ✅ | 5080ms | 99.983% | 64 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_1 | ✅ | 5233ms | 99.982% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_2 | ✅ | 5102ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_3 | ✅ | 5188ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_4 | ❌ | 5150ms | 99.151% | 14 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_5 | ✅ | 5161ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_1 | ✅ | 4993ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_2 | ✅ | 5033ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_3 | ✅ | 5006ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_4 | ✅ | 5080ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_5 | ✅ | 5053ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_1 | ✅ | 5070ms | 99.891% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_2 | ✅ | 5137ms | 99.974% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_3 | ✅ | 5251ms | 99.961% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_4 | ✅ | 5220ms | 99.984% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_5 | ✅ | 5068ms | 100.000% | 2 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_1 | ✅ | 4814ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_2 | ✅ | 4809ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_3 | ✅ | 4838ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_4 | ✅ | 4802ms | 100.000% | 3 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_5 | ✅ | 4822ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_1 | ✅ | 4810ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_2 | ✅ | 4823ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_3 | ✅ | 4827ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_4 | ✅ | 4834ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_5 | ✅ | 4816ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_1 | ❌ | 4823ms | 98.936% | 31 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_2 | ❌ | 4805ms | 92.490% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_3 | ❌ | 4818ms | 96.194% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_4 | ❌ | 4802ms | 65.549% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_5 | ❌ | 4815ms | 97.912% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_1 | ❌ | 5069ms | 98.685% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_2 | ❌ | 5031ms | 96.085% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_3 | ❌ | 4991ms | 97.307% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_4 | ❌ | 5176ms | 98.573% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_5 | ❌ | 5124ms | 97.701% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Failure detail

### brush_step_4

- Worst match: **99.151%**  Worst maxΔ: **14**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.151% (maxΔ 14)
    - group 0: 99.151% match · maxΔ 14 · bbox 189×149@(598,691) · 27922/28161 px
- bot_2 vs drawer: 99.151% (maxΔ 14)
    - group 0: 99.151% match · maxΔ 14 · bbox 189×149@(598,691) · 27922/28161 px
- Screenshots: `FAIL_brush_step_4__bot_*.png`

### line_step_1

- Worst match: **98.936%**  Worst maxΔ: **31**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.936% (maxΔ 31)
    - group 0: 98.936% match · maxΔ 31 · bbox 222×163@(208,93) · 35801/36186 px
- bot_2 vs drawer: 98.936% (maxΔ 31)
    - group 0: 98.936% match · maxΔ 31 · bbox 222×163@(208,93) · 35801/36186 px
- Screenshots: `FAIL_line_step_1__bot_*.png`

### line_step_2

- Worst match: **92.490%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 92.490% (maxΔ 255)
    - group 0: 92.490% match · maxΔ 255 · bbox 200×98@(726,361) · 18128/19600 px
- bot_2 vs drawer: 92.490% (maxΔ 255)
    - group 0: 92.490% match · maxΔ 255 · bbox 200×98@(726,361) · 18128/19600 px
- Screenshots: `FAIL_line_step_2__bot_*.png`

### line_step_3

- Worst match: **96.194%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 96.194% (maxΔ 255)
    - group 0: 96.194% match · maxΔ 255 · bbox 246×141@(910,406) · 33366/34686 px
- bot_2 vs drawer: 96.194% (maxΔ 255)
    - group 0: 96.194% match · maxΔ 255 · bbox 246×141@(910,406) · 33366/34686 px
- Screenshots: `FAIL_line_step_3__bot_*.png`

### line_step_4

- Worst match: **65.549%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 65.549% (maxΔ 255)
    - group 0: 65.549% match · maxΔ 255 · bbox 65×61@(410,473) · 2599/3965 px
- bot_2 vs drawer: 65.549% (maxΔ 255)
    - group 0: 65.549% match · maxΔ 255 · bbox 65×61@(410,473) · 2599/3965 px
- Screenshots: `FAIL_line_step_4__bot_*.png`

### line_step_5

- Worst match: **97.912%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 97.912% (maxΔ 255)
    - group 0: 97.912% match · maxΔ 255 · bbox 200×261@(171,547) · 51110/52200 px
- bot_2 vs drawer: 97.912% (maxΔ 255)
    - group 0: 97.912% match · maxΔ 255 · bbox 200×261@(171,547) · 51110/52200 px
- Screenshots: `FAIL_line_step_5__bot_*.png`

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

- Worst match: **97.701%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 97.701% (maxΔ 255)
    - group 0: 97.701% match · maxΔ 255 · bbox 402×428@(1456,315) · 168100/172056 px
- bot_2 vs drawer: 97.701% (maxΔ 255)
    - group 0: 97.701% match · maxΔ 255 · bbox 402×428@(1456,315) · 168100/172056 px
- Screenshots: `FAIL_confetti_step_5__bot_*.png`

