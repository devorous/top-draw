# Comprehensive Sync Report

Generated: 2026-05-16T05:08:51.307Z
Room: `comp_sync_1778907920290`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±4 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 24/40 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (24/40)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| ink_step_1 | ✅ | 5139ms | 99.865% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_2 | ✅ | 5251ms | 99.887% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_3 | ✅ | 5061ms | 99.783% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_4 | ✅ | 5281ms | 99.955% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_5 | ✅ | 4998ms | 99.909% | 64 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_1 | ✅ | 5340ms | 99.806% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_2 | ✅ | 5098ms | 99.938% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_3 | ✅ | 5125ms | 99.992% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_4 | ❌ | 5176ms | 98.754% | 14 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_5 | ✅ | 5190ms | 99.973% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_1 | ✅ | 5015ms | 99.835% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_2 | ✅ | 5043ms | 99.790% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_3 | ✅ | 5029ms | 99.724% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_4 | ✅ | 5117ms | 99.745% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_5 | ✅ | 5078ms | 99.790% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_1 | ❌ | 5035ms | 99.320% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_2 | ❌ | 5085ms | 99.457% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_3 | ✅ | 5234ms | 99.729% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_4 | ❌ | 5199ms | 99.411% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_5 | ✅ | 5093ms | 100.000% | 2 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_1 | ❌ | 4841ms | 98.938% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_2 | ✅ | 4862ms | 99.992% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_3 | ✅ | 4791ms | 99.962% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_4 | ✅ | 4801ms | 100.000% | 3 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_5 | ✅ | 4800ms | 99.718% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_1 | ✅ | 4821ms | 99.788% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_2 | ❌ | 4912ms | 99.293% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_3 | ✅ | 4839ms | 99.899% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_4 | ✅ | 4807ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_5 | ✅ | 4789ms | 99.943% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_1 | ❌ | 4820ms | 98.292% | 31 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_2 | ❌ | 4820ms | 90.240% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_3 | ❌ | 4873ms | 94.937% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_4 | ❌ | 4799ms | 56.444% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_5 | ❌ | 4816ms | 83.820% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_1 | ❌ | 5071ms | 98.357% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_2 | ❌ | 5033ms | 95.095% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_3 | ❌ | 4992ms | 96.900% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_4 | ❌ | 5168ms | 98.313% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_5 | ❌ | 5121ms | 96.928% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Failure detail

### brush_step_4

- Worst match: **98.754%**  Worst maxΔ: **14**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.754% (maxΔ 14)
    - group 0: 98.754% match · maxΔ 14 · bbox 189×149@(598,691) · 27810/28161 px
- bot_2 vs drawer: 98.754% (maxΔ 14)
    - group 0: 98.754% match · maxΔ 14 · bbox 189×149@(598,691) · 27810/28161 px
- Screenshots: `FAIL_brush_step_4__bot_*.png`

### flowPen_step_1

- Worst match: **99.320%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.320% (maxΔ 255)
    - group 0: 99.320% match · maxΔ 255 · bbox 209×140@(711,641) · 29061/29260 px
- bot_2 vs drawer: 99.320% (maxΔ 255)
    - group 0: 99.320% match · maxΔ 255 · bbox 209×140@(711,641) · 29061/29260 px
- Screenshots: `FAIL_flowpen_step_1__bot_*.png`

### flowPen_step_2

- Worst match: **99.457%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.457% (maxΔ 255)
    - group 0: 99.457% match · maxΔ 255 · bbox 193×314@(259,368) · 60273/60602 px
- bot_2 vs drawer: 99.457% (maxΔ 255)
    - group 0: 99.457% match · maxΔ 255 · bbox 193×314@(259,368) · 60273/60602 px
- Screenshots: `FAIL_flowpen_step_2__bot_*.png`

### flowPen_step_4

- Worst match: **99.411%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.411% (maxΔ 255)
    - group 0: 99.411% match · maxΔ 255 · bbox 329×309@(918,525) · 101062/101661 px
- bot_2 vs drawer: 99.411% (maxΔ 255)
    - group 0: 99.411% match · maxΔ 255 · bbox 329×309@(918,525) · 101062/101661 px
- Screenshots: `FAIL_flowpen_step_4__bot_*.png`

### rectangle_step_1

- Worst match: **98.938%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.938% (maxΔ 255)
    - group 0: 98.938% match · maxΔ 255 · bbox 219×89@(1090,424) · 19284/19491 px
- bot_2 vs drawer: 98.938% (maxΔ 255)
    - group 0: 98.938% match · maxΔ 255 · bbox 219×89@(1090,424) · 19284/19491 px
- Screenshots: `FAIL_rectangle_step_1__bot_*.png`

### circle_step_2

- Worst match: **99.293%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.293% (maxΔ 255)
    - group 0: 99.293% match · maxΔ 255 · bbox 203×161@(569,97) · 32452/32683 px
- bot_2 vs drawer: 99.293% (maxΔ 255)
    - group 0: 99.293% match · maxΔ 255 · bbox 203×161@(569,97) · 32452/32683 px
- Screenshots: `FAIL_circle_step_2__bot_*.png`

### line_step_1

- Worst match: **98.292%**  Worst maxΔ: **31**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.292% (maxΔ 31)
    - group 0: 98.292% match · maxΔ 31 · bbox 222×163@(208,93) · 35568/36186 px
- bot_2 vs drawer: 98.292% (maxΔ 31)
    - group 0: 98.292% match · maxΔ 31 · bbox 222×163@(208,93) · 35568/36186 px
- Screenshots: `FAIL_line_step_1__bot_*.png`

### line_step_2

- Worst match: **90.240%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 90.240% (maxΔ 255)
    - group 0: 90.240% match · maxΔ 255 · bbox 200×98@(726,361) · 17687/19600 px
- bot_2 vs drawer: 90.240% (maxΔ 255)
    - group 0: 90.240% match · maxΔ 255 · bbox 200×98@(726,361) · 17687/19600 px
- Screenshots: `FAIL_line_step_2__bot_*.png`

### line_step_3

- Worst match: **94.937%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 94.937% (maxΔ 255)
    - group 0: 94.937% match · maxΔ 255 · bbox 246×141@(910,406) · 32930/34686 px
- bot_2 vs drawer: 94.937% (maxΔ 255)
    - group 0: 94.937% match · maxΔ 255 · bbox 246×141@(910,406) · 32930/34686 px
- Screenshots: `FAIL_line_step_3__bot_*.png`

### line_step_4

- Worst match: **56.444%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 56.444% (maxΔ 255)
    - group 0: 56.444% match · maxΔ 255 · bbox 65×61@(410,473) · 2238/3965 px
- bot_2 vs drawer: 56.444% (maxΔ 255)
    - group 0: 56.444% match · maxΔ 255 · bbox 65×61@(410,473) · 2238/3965 px
- Screenshots: `FAIL_line_step_4__bot_*.png`

### line_step_5

- Worst match: **83.820%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 83.820% (maxΔ 255)
    - group 0: 83.820% match · maxΔ 255 · bbox 200×261@(171,547) · 43754/52200 px
- bot_2 vs drawer: 83.820% (maxΔ 255)
    - group 0: 83.820% match · maxΔ 255 · bbox 200×261@(171,547) · 43754/52200 px
- Screenshots: `FAIL_line_step_5__bot_*.png`

### confetti_step_1

- Worst match: **98.357%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.357% (maxΔ 255)
    - group 0: 98.357% match · maxΔ 255 · bbox 367×401@(1023,264) · 144749/147167 px
- bot_2 vs drawer: 98.357% (maxΔ 255)
    - group 0: 98.357% match · maxΔ 255 · bbox 367×401@(1023,264) · 144749/147167 px
- Screenshots: `FAIL_confetti_step_1__bot_*.png`

### confetti_step_2

- Worst match: **95.095%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 95.095% (maxΔ 255)
    - group 0: 95.095% match · maxΔ 255 · bbox 431×328@(508,375) · 134434/141368 px
- bot_2 vs drawer: 95.095% (maxΔ 255)
    - group 0: 95.095% match · maxΔ 255 · bbox 431×328@(508,375) · 134434/141368 px
- Screenshots: `FAIL_confetti_step_2__bot_*.png`

### confetti_step_3

- Worst match: **96.900%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 96.900% (maxΔ 255)
    - group 0: 96.900% match · maxΔ 255 · bbox 357×367@(526,582) · 126958/131019 px
- bot_2 vs drawer: 96.900% (maxΔ 255)
    - group 0: 96.900% match · maxΔ 255 · bbox 357×367@(526,582) · 126958/131019 px
- Screenshots: `FAIL_confetti_step_3__bot_*.png`

### confetti_step_4

- Worst match: **98.313%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.313% (maxΔ 255)
    - group 0: 98.313% match · maxΔ 255 · bbox 340×387@(1156,169) · 129360/131580 px
- bot_2 vs drawer: 98.313% (maxΔ 255)
    - group 0: 98.313% match · maxΔ 255 · bbox 340×387@(1156,169) · 129360/131580 px
- Screenshots: `FAIL_confetti_step_4__bot_*.png`

### confetti_step_5

- Worst match: **96.928%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 96.928% (maxΔ 255)
    - group 0: 96.928% match · maxΔ 255 · bbox 402×428@(1456,315) · 166771/172056 px
- bot_2 vs drawer: 96.928% (maxΔ 255)
    - group 0: 96.928% match · maxΔ 255 · bbox 402×428@(1456,315) · 166771/172056 px
- Screenshots: `FAIL_confetti_step_5__bot_*.png`

