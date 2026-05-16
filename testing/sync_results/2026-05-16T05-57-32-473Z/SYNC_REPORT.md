# Comprehensive Sync Report

Generated: 2026-05-16T06:04:13.944Z
Room: `comp_sync_1778911052474`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±16 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 63/66 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (40/40)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| ink_step_1 | ✅ | 5123ms | 99.993% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_2 | ✅ | 5275ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_3 | ✅ | 5120ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_4 | ✅ | 5372ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_5 | ✅ | 5156ms | 100.000% | 64 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_1 | ✅ | 5252ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_2 | ✅ | 5151ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_3 | ✅ | 5223ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_4 | ✅ | 5209ms | 100.000% | 19 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_5 | ✅ | 5228ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_1 | ✅ | 5010ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_2 | ✅ | 5036ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_3 | ✅ | 5030ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_4 | ✅ | 5105ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_5 | ✅ | 5057ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_1 | ✅ | 5166ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_2 | ✅ | 5193ms | 99.994% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_3 | ✅ | 5326ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_4 | ✅ | 5245ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_5 | ✅ | 5091ms | 100.000% | 2 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_1 | ✅ | 4825ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_2 | ✅ | 4805ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_3 | ✅ | 5157ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_4 | ✅ | 4809ms | 100.000% | 3 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_5 | ✅ | 4817ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_1 | ✅ | 4802ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_2 | ✅ | 4821ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_3 | ✅ | 4828ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_4 | ✅ | 4821ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_5 | ✅ | 4809ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_1 | ✅ | 4822ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_2 | ✅ | 4828ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_3 | ✅ | 4809ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_4 | ✅ | 4821ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_5 | ✅ | 4810ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_1 | ✅ | 5077ms | 99.954% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_2 | ✅ | 5059ms | 99.873% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_3 | ✅ | 4977ms | 99.915% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_4 | ✅ | 5172ms | 99.931% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_5 | ✅ | 5126ms | 99.836% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Special (10/12)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| fill_variations | ✅ | 7466ms | 100.000% | 0 | 10 / 10 / 10 | 1 / 1 / 1 |
| blur_tools_test | ✅ | 8038ms | 100.000% | 64 | 11 / 11 / 11 | 1 / 1 / 1 |
| eraser_over_strokes | ❌ | 6115ms | 93.961% | 255 | 5 / 5 / 5 | 1 / 1 / 1 |
| blend_modes_layered | ✅ | 6306ms | 100.000% | 255 | 4 / 4 / 4 | 1 / 1 / 1 |
| image_brush_set | ❌ | 5984ms | 98.333% | 255 | ❌ 5 / 4 / 4 | 1 / 1 / 1 |
| gimp_brush_strokes | ✅ | 5172ms | 100.000% | 0 | 0 / 0 / 0 | 1 / 1 / 1 |
| text_tool_set | ✅ | 7310ms | 100.000% | 0 | 0 / 0 / 0 | 1 / 1 / 1 |
| confetti_image_brush | ✅ | 5781ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| confetti_options_mix | ✅ | 5847ms | 99.998% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| select_complex_transform | ✅ | 5853ms | 100.000% | 0 | 1 / 1 / 1 | 1 / 1 / 1 |
| undo_after_strokes | ✅ | 6661ms | 99.999% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| mixed_tool_sequence | ✅ | 7453ms | 99.996% | 255 | 6 / 6 / 6 | 1 / 1 / 1 |

## Concurrent (9/9)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| brush_concurrent | ✅ | 5433ms | 100.000% | 221 | 3 / 3 / 3 | 1 / 1 / 1 |
| ink_concurrent | ✅ | 5470ms | 100.000% | 221 | 3 / 3 / 3 | 1 / 1 / 1 |
| flowPen_concurrent | ✅ | 5298ms | 99.991% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| pixel_concurrent | ✅ | 5254ms | 100.000% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| line_concurrent | ✅ | 5027ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| circle_concurrent | ✅ | 4993ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| rectangle_concurrent | ✅ | 5062ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| confetti_concurrent | ✅ | 5148ms | 99.975% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| mixed_tools_concurrent | ✅ | 5338ms | 100.000% | 219 | 3 / 3 / 3 | 1 / 1 / 1 |

## Flood (4/5)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| flood_drawer_25_brush | ✅ | 12845ms | 99.899% | 255 | 20 / 20 / 20 | 1 / 1 / 1 |
| flood_drawer_30_mixed | ✅ | 14882ms | 99.996% | 255 | 20 / 20 / 20 | 1 / 1 / 1 |
| flood_drawer_25_then_undo | ✅ | 12990ms | 99.988% | 255 | 17 / 17 / 17 | 1 / 1 / 1 |
| flood_concurrent_25_each | ✅ | 13401ms | 100.000% | 255 | 60 / 60 / 60 | 1 / 1 / 1 |
| flood_concurrent_blend_modes | ❌ | 12842ms | 99.999% | 255 | ❌ 59 / 59 / 60 | 1 / 1 / 1 |

## Failure detail

### eraser_over_strokes

- Worst match: **93.961%**  Worst maxΔ: **255**
- Stroke totals: 5 / 5 / 5 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 93.961% (maxΔ 255)
    - group 0: 93.961% match · maxΔ 255 · bbox 437×280@(160,260) · 114971/122360 px
- bot_2 vs drawer: 93.961% (maxΔ 255)
    - group 0: 93.961% match · maxΔ 255 · bbox 437×280@(160,260) · 114971/122360 px
- Screenshots: `FAIL_eraser_over_strokes__bot_*.png`

### image_brush_set

- Worst match: **98.333%**  Worst maxΔ: **255**
- Stroke totals: 5 / 4 / 4 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.333% (maxΔ 255)
    - group 0: 98.333% match · maxΔ 255 · bbox 1344×608@(235,151) · 803534/817152 px
- bot_2 vs drawer: 98.333% (maxΔ 255)
    - group 0: 98.333% match · maxΔ 255 · bbox 1344×608@(235,151) · 803534/817152 px
- Screenshots: `FAIL_image_brush_set__bot_*.png`

### flood_concurrent_blend_modes

- Worst match: **99.999%**  Worst maxΔ: **255**
- Stroke totals: 59 / 59 / 60 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.999% (maxΔ 255)
    - group 0: 99.999% match · maxΔ 255 · bbox 849×1010@(170,70) · 857479/857490 px
- bot_2 vs drawer: 99.999% (maxΔ 255)
    - group 0: 99.999% match · maxΔ 255 · bbox 849×1010@(170,70) · 857480/857490 px
- Screenshots: `FAIL_flood_concurrent_blend_modes__bot_*.png`

