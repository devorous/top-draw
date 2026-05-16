# Comprehensive Sync Report

Generated: 2026-05-16T07:44:15.833Z
Room: `comp_sync_1778917048588`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±16 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 60/66 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (40/40)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| ink_step_1 | ✅ | 5131ms | 99.999% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_2 | ✅ | 5223ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_3 | ✅ | 5025ms | 99.996% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_4 | ✅ | 5330ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_5 | ✅ | 5005ms | 100.000% | 64 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_1 | ✅ | 5191ms | 99.997% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_2 | ✅ | 5077ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_3 | ✅ | 5154ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_4 | ✅ | 5139ms | 100.000% | 14 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_5 | ✅ | 5162ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_1 | ✅ | 5022ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_2 | ✅ | 5062ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_3 | ✅ | 5030ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_4 | ✅ | 5113ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_5 | ✅ | 5070ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_1 | ✅ | 5031ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_2 | ✅ | 5073ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_3 | ✅ | 5216ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_4 | ✅ | 5176ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_5 | ✅ | 5019ms | 100.000% | 2 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_1 | ✅ | 4828ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_2 | ✅ | 4835ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_3 | ✅ | 4801ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_4 | ✅ | 4815ms | 100.000% | 3 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_5 | ✅ | 4808ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_1 | ✅ | 4823ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_2 | ✅ | 4820ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_3 | ✅ | 4809ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_4 | ✅ | 4819ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_5 | ✅ | 4809ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_1 | ✅ | 4833ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_2 | ✅ | 4809ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_3 | ✅ | 4812ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_4 | ✅ | 4828ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_5 | ✅ | 4831ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_1 | ✅ | 5076ms | 99.954% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_2 | ✅ | 5044ms | 99.873% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_3 | ✅ | 4989ms | 99.915% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_4 | ✅ | 5153ms | 99.931% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_5 | ✅ | 5131ms | 99.822% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Special (9/12)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| fill_variations | ❌ | 7596ms | 96.433% | 255 | ❌ 10 / 9 / 9 | 1 / 1 / 1 |
| blur_tools_test | ❌ | 10555ms | 6.380% | 255 | ❌ 11 / 12 / 12 | 1 / 1 / 1 |
| eraser_over_strokes | ✅ | 6088ms | 99.989% | 255 | 5 / 5 / 5 | 1 / 1 / 1 |
| blend_modes_layered | ✅ | 6168ms | 100.000% | 255 | 4 / 4 / 4 | 1 / 1 / 1 |
| image_brush_set | ✅ | 6000ms | 100.000% | 0 | 5 / 5 / 5 | 1 / 1 / 1 |
| gimp_brush_strokes | ✅ | 5163ms | 100.000% | 0 | 0 / 0 / 0 | 1 / 1 / 1 |
| text_tool_set | ✅ | 7307ms | 100.000% | 0 | 0 / 0 / 0 | 1 / 1 / 1 |
| confetti_image_brush | ✅ | 5786ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| confetti_options_mix | ✅ | 5873ms | 99.998% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| select_complex_transform | ✅ | 5724ms | 100.000% | 0 | 1 / 1 / 1 | 1 / 1 / 1 |
| undo_after_strokes | ❌ | 6715ms | 81.605% | 255 | ❌ 3 / 5 / 5 | 1 / 1 / 1 |
| mixed_tool_sequence | ✅ | 7387ms | 99.997% | 255 | 6 / 6 / 6 | 1 / 1 / 1 |

## Concurrent (9/9)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| brush_concurrent | ✅ | 5288ms | 99.999% | 221 | 3 / 3 / 3 | 1 / 1 / 1 |
| ink_concurrent | ✅ | 5523ms | 100.000% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| flowPen_concurrent | ✅ | 5359ms | 99.989% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| pixel_concurrent | ✅ | 5352ms | 100.000% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| line_concurrent | ✅ | 5016ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| circle_concurrent | ✅ | 5104ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| rectangle_concurrent | ✅ | 5026ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| confetti_concurrent | ✅ | 5194ms | 99.975% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| mixed_tools_concurrent | ✅ | 5264ms | 100.000% | 219 | 3 / 3 / 3 | 1 / 1 / 1 |

## Flood (2/5)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| flood_drawer_25_brush | ✅ | 12492ms | 99.965% | 255 | 20 / 20 / 20 | 1 / 1 / 1 |
| flood_drawer_30_mixed | ✅ | 14749ms | 99.998% | 255 | 20 / 20 / 20 | 1 / 1 / 1 |
| flood_drawer_25_then_undo | ❌ | 12864ms | 91.822% | 255 | ❌ 17 / 20 / 20 | 1 / 1 / 1 |
| flood_concurrent_25_each | ❌ | 13939ms | 73.637% | 255 | 60 / 60 / 60 | 1 / 1 / 1 |
| flood_concurrent_blend_modes | ❌ | 12787ms | 100.000% | 255 | ❌ 59 / 59 / 60 | 1 / 1 / 1 |

## Failure detail

### fill_variations

- Worst match: **96.433%**  Worst maxΔ: **255**
- Stroke totals: 10 / 9 / 9 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 96.433% (maxΔ 255)
    - group 0: 96.433% match · maxΔ 255 · bbox 1438×438@(131,181) · 607377/629844 px
- bot_2 vs drawer: 96.433% (maxΔ 255)
    - group 0: 96.433% match · maxΔ 255 · bbox 1438×438@(131,181) · 607377/629844 px
- Screenshots: `FAIL_fill_variations__bot_*.png`

### blur_tools_test

- Worst match: **6.380%**  Worst maxΔ: **255**
- Stroke totals: 11 / 12 / 12 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 6.380% (maxΔ 255)
    - group 0: 6.380% match · maxΔ 255 · bbox 1920×1080@(0,0) · 132299/2073600 px
- bot_2 vs drawer: 6.380% (maxΔ 255)
    - group 0: 6.380% match · maxΔ 255 · bbox 1920×1080@(0,0) · 132299/2073600 px
- Screenshots: `FAIL_blur_tools_test__bot_*.png`

### undo_after_strokes

- Worst match: **81.605%**  Worst maxΔ: **255**
- Stroke totals: 3 / 5 / 5 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 81.605% (maxΔ 255)
    - group 0: 81.605% match · maxΔ 255 · bbox 584×583@(160,220) · 277841/340472 px
- bot_2 vs drawer: 81.605% (maxΔ 255)
    - group 0: 81.605% match · maxΔ 255 · bbox 584×583@(160,220) · 277841/340472 px
- Screenshots: `FAIL_undo_after_strokes__bot_*.png`

### flood_drawer_25_then_undo

- Worst match: **91.822%**  Worst maxΔ: **255**
- Stroke totals: 17 / 20 / 20 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 91.822% (maxΔ 255)
    - group 0: 91.822% match · maxΔ 255 · bbox 1234×900@(186,66) · 1019775/1110600 px
- bot_2 vs drawer: 91.822% (maxΔ 255)
    - group 0: 91.822% match · maxΔ 255 · bbox 1234×900@(186,66) · 1019775/1110600 px
- Screenshots: `FAIL_flood_drawer_25_then_undo__bot_*.png`

### flood_concurrent_25_each

- Worst match: **73.637%**  Worst maxΔ: **255**
- Stroke totals: 60 / 60 / 60 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 73.637% (maxΔ 255)
    - group 0: 73.637% match · maxΔ 255 · bbox 1339×832@(162,0) · 820357/1114048 px
- bot_2 vs drawer: 73.637% (maxΔ 255)
    - group 0: 73.637% match · maxΔ 255 · bbox 1339×832@(162,0) · 820353/1114048 px
- Screenshots: `FAIL_flood_concurrent_25_each__bot_*.png`

### flood_concurrent_blend_modes

- Worst match: **100.000%**  Worst maxΔ: **255**
- Stroke totals: 59 / 59 / 60 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 100.000% (maxΔ 255)
    - group 0: 100.000% match · maxΔ 255 · bbox 846×1010@(170,70) · 854459/854460 px
- bot_2 vs drawer: 100.000% (maxΔ 255)
    - group 0: 100.000% match · maxΔ 255 · bbox 846×1010@(170,70) · 854460/854460 px
- Screenshots: `FAIL_flood_concurrent_blend_modes__bot_*.png`

