# Comprehensive Sync Report

Generated: 2026-05-16T05:20:52.680Z
Room: `comp_sync_1778908640893`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±4 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 28/40 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (28/40)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| ink_step_1 | ✅ | 5183ms | 99.961% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_2 | ✅ | 5252ms | 99.989% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_3 | ✅ | 5141ms | 99.997% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_4 | ✅ | 5328ms | 99.987% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_5 | ✅ | 5115ms | 99.987% | 64 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_1 | ✅ | 5291ms | 99.985% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_2 | ✅ | 5158ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_3 | ❌ | 5254ms | 99.314% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_4 | ❌ | 6114ms | 99.255% | 27 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_5 | ✅ | 5438ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_1 | ✅ | 5002ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_2 | ✅ | 5052ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_3 | ✅ | 5021ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_4 | ✅ | 5086ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_5 | ✅ | 5056ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_1 | ✅ | 5005ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_2 | ✅ | 5091ms | 99.931% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_3 | ✅ | 5359ms | 99.966% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_4 | ✅ | 5295ms | 99.997% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_5 | ✅ | 5100ms | 100.000% | 2 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_1 | ✅ | 4827ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_2 | ✅ | 4785ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_3 | ✅ | 4796ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_4 | ✅ | 4810ms | 100.000% | 3 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_5 | ✅ | 4805ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_1 | ✅ | 4808ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_2 | ✅ | 4829ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_3 | ✅ | 4818ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_4 | ✅ | 4821ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_5 | ✅ | 4815ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_1 | ❌ | 4823ms | 98.936% | 31 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_2 | ❌ | 4805ms | 92.490% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_3 | ❌ | 4829ms | 96.194% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_4 | ❌ | 4809ms | 65.549% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_5 | ❌ | 4818ms | 97.912% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_1 | ❌ | 5072ms | 98.685% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_2 | ❌ | 5063ms | 96.085% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_3 | ❌ | 5027ms | 97.307% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_4 | ❌ | 5180ms | 98.573% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_5 | ❌ | 5155ms | 97.746% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Failure detail

### brush_step_3

- Worst match: **99.314%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.314% (maxΔ 255)
    - group 0: 99.314% match · maxΔ 255 · bbox 440×360@(903,37) · 157314/158400 px
- bot_2 vs drawer: 99.314% (maxΔ 255)
    - group 0: 99.314% match · maxΔ 255 · bbox 440×360@(903,37) · 157314/158400 px
- Screenshots: `FAIL_brush_step_3__bot_*.png`

### brush_step_4

- Worst match: **99.255%**  Worst maxΔ: **27**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.255% (maxΔ 27)
    - group 0: 99.255% match · maxΔ 27 · bbox 203×162@(591,688) · 32641/32886 px
- bot_2 vs drawer: 99.255% (maxΔ 27)
    - group 0: 99.255% match · maxΔ 27 · bbox 203×162@(591,688) · 32641/32886 px
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

- Worst match: **97.746%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 97.746% (maxΔ 255)
    - group 0: 97.746% match · maxΔ 255 · bbox 402×428@(1456,315) · 168178/172056 px
- bot_2 vs drawer: 97.746% (maxΔ 255)
    - group 0: 97.746% match · maxΔ 255 · bbox 402×428@(1456,315) · 168178/172056 px
- Screenshots: `FAIL_confetti_step_5__bot_*.png`

