# Comprehensive Sync Report

Generated: 2026-05-16T07:29:11.992Z
Room: `comp_sync_1778916151268`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±16 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 65/66 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (40/40)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| ink_step_1 | ✅ | 5135ms | 99.992% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_2 | ✅ | 5265ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_3 | ✅ | 5185ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_4 | ✅ | 5360ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_5 | ✅ | 5137ms | 100.000% | 128 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_1 | ✅ | 5213ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_2 | ✅ | 5137ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_3 | ✅ | 5223ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_4 | ✅ | 5207ms | 100.000% | 18 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_5 | ✅ | 5208ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_1 | ✅ | 5067ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_2 | ✅ | 5045ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_3 | ✅ | 5028ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_4 | ✅ | 5083ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_5 | ✅ | 5084ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_1 | ✅ | 5149ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_2 | ✅ | 5124ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_3 | ✅ | 5312ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_4 | ✅ | 5261ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_5 | ✅ | 5126ms | 100.000% | 2 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_1 | ✅ | 4845ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_2 | ✅ | 4828ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_3 | ✅ | 5180ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_4 | ✅ | 4814ms | 100.000% | 3 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_5 | ✅ | 4816ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_1 | ✅ | 4837ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_2 | ✅ | 4820ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_3 | ✅ | 4806ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_4 | ✅ | 4827ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_5 | ✅ | 4817ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_1 | ✅ | 4874ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_2 | ✅ | 4871ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_3 | ✅ | 4831ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_4 | ✅ | 4831ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_5 | ✅ | 4826ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_1 | ✅ | 5063ms | 99.954% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_2 | ✅ | 5064ms | 99.873% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_3 | ✅ | 5000ms | 99.915% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_4 | ✅ | 5152ms | 99.931% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_5 | ✅ | 5092ms | 99.829% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Special (12/12)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| fill_variations | ✅ | 7484ms | 100.000% | 0 | 10 / 10 / 10 | 1 / 1 / 1 |
| blur_tools_test | ✅ | 7976ms | 100.000% | 64 | 11 / 11 / 11 | 1 / 1 / 1 |
| eraser_over_strokes | ✅ | 6086ms | 99.974% | 255 | 5 / 5 / 5 | 1 / 1 / 1 |
| blend_modes_layered | ✅ | 6197ms | 100.000% | 255 | 4 / 4 / 4 | 1 / 1 / 1 |
| image_brush_set | ✅ | 5996ms | 100.000% | 0 | 5 / 5 / 5 | 1 / 1 / 1 |
| gimp_brush_strokes | ✅ | 5156ms | 100.000% | 0 | 0 / 0 / 0 | 1 / 1 / 1 |
| text_tool_set | ✅ | 7321ms | 100.000% | 0 | 0 / 0 / 0 | 1 / 1 / 1 |
| confetti_image_brush | ✅ | 5800ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| confetti_options_mix | ✅ | 5897ms | 99.998% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| select_complex_transform | ✅ | 5729ms | 100.000% | 0 | 1 / 1 / 1 | 1 / 1 / 1 |
| undo_after_strokes | ✅ | 6627ms | 100.000% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| mixed_tool_sequence | ✅ | 7410ms | 99.996% | 255 | 6 / 6 / 6 | 1 / 1 / 1 |

## Concurrent (9/9)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| brush_concurrent | ✅ | 5505ms | 100.000% | 221 | 3 / 3 / 3 | 1 / 1 / 1 |
| ink_concurrent | ✅ | 5525ms | 100.000% | 219 | 3 / 3 / 3 | 1 / 1 / 1 |
| flowPen_concurrent | ✅ | 5358ms | 99.992% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| pixel_concurrent | ✅ | 5301ms | 100.000% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| line_concurrent | ✅ | 5184ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| circle_concurrent | ✅ | 5107ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| rectangle_concurrent | ✅ | 5105ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| confetti_concurrent | ✅ | 5191ms | 99.975% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| mixed_tools_concurrent | ✅ | 5323ms | 100.000% | 221 | 3 / 3 / 3 | 1 / 1 / 1 |

## Flood (4/5)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| flood_drawer_25_brush | ✅ | 12757ms | 99.907% | 255 | 20 / 20 / 20 | 1 / 1 / 1 |
| flood_drawer_30_mixed | ✅ | 14800ms | 99.996% | 255 | 20 / 20 / 20 | 1 / 1 / 1 |
| flood_drawer_25_then_undo | ✅ | 12980ms | 99.987% | 255 | 17 / 17 / 17 | 1 / 1 / 1 |
| flood_concurrent_25_each | ✅ | 13451ms | 100.000% | 255 | 60 / 60 / 60 | 1 / 1 / 1 |
| flood_concurrent_blend_modes | ❌ | 12877ms | 99.998% | 255 | ❌ 59 / 59 / 60 | 1 / 1 / 1 |

## Failure detail

### flood_concurrent_blend_modes

- Worst match: **99.998%**  Worst maxΔ: **255**
- Stroke totals: 59 / 59 / 60 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.998% (maxΔ 255)
    - group 0: 99.998% match · maxΔ 255 · bbox 849×1010@(170,70) · 857477/857490 px
- bot_2 vs drawer: 99.998% (maxΔ 255)
    - group 0: 99.998% match · maxΔ 255 · bbox 849×1010@(170,70) · 857477/857490 px
- Screenshots: `FAIL_flood_concurrent_blend_modes__bot_*.png`

