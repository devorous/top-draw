# Comprehensive Sync Report

Generated: 2026-05-16T05:54:41.993Z
Room: `comp_sync_1778910848458`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±4 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 0/5 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (0/5)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| confetti_step_1 | ❌ | 5099ms | 98.859% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_2 | ❌ | 5071ms | 96.718% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_3 | ❌ | 4997ms | 97.420% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_4 | ❌ | 5172ms | 98.735% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_5 | ❌ | 5153ms | 98.141% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Failure detail

### confetti_step_1

- Worst match: **98.859%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.859% (maxΔ 255)
    - group 0: 98.859% match · maxΔ 255 · bbox 367×401@(1023,264) · 145488/147167 px
- bot_2 vs drawer: 98.859% (maxΔ 255)
    - group 0: 98.859% match · maxΔ 255 · bbox 367×401@(1023,264) · 145488/147167 px
- Screenshots: `FAIL_confetti_step_1__bot_*.png`

### confetti_step_2

- Worst match: **96.718%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 96.718% (maxΔ 255)
    - group 0: 96.718% match · maxΔ 255 · bbox 431×328@(508,375) · 136728/141368 px
- bot_2 vs drawer: 96.718% (maxΔ 255)
    - group 0: 96.718% match · maxΔ 255 · bbox 431×328@(508,375) · 136728/141368 px
- Screenshots: `FAIL_confetti_step_2__bot_*.png`

### confetti_step_3

- Worst match: **97.420%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 97.420% (maxΔ 255)
    - group 0: 97.420% match · maxΔ 255 · bbox 357×367@(526,582) · 127639/131019 px
- bot_2 vs drawer: 97.420% (maxΔ 255)
    - group 0: 97.420% match · maxΔ 255 · bbox 357×367@(526,582) · 127639/131019 px
- Screenshots: `FAIL_confetti_step_3__bot_*.png`

### confetti_step_4

- Worst match: **98.735%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.735% (maxΔ 255)
    - group 0: 98.735% match · maxΔ 255 · bbox 340×387@(1156,169) · 129916/131580 px
- bot_2 vs drawer: 98.735% (maxΔ 255)
    - group 0: 98.735% match · maxΔ 255 · bbox 340×387@(1156,169) · 129916/131580 px
- Screenshots: `FAIL_confetti_step_4__bot_*.png`

### confetti_step_5

- Worst match: **98.141%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.141% (maxΔ 255)
    - group 0: 98.141% match · maxΔ 255 · bbox 402×428@(1456,315) · 168857/172056 px
- bot_2 vs drawer: 98.141% (maxΔ 255)
    - group 0: 98.141% match · maxΔ 255 · bbox 402×428@(1456,315) · 168857/172056 px
- Screenshots: `FAIL_confetti_step_5__bot_*.png`

