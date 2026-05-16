# Comprehensive Sync Report

Generated: 2026-05-16T09:04:23.638Z
Room: `comp_sync_1778921867065`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±16 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 66/66 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (40/40)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| ink_step_1 | ✅ | 5298ms | 99.955% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_2 | ✅ | 5160ms | 99.988% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_3 | ✅ | 5092ms | 99.991% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_4 | ✅ | 5543ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_5 | ✅ | 5100ms | 99.996% | 64 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_1 | ✅ | 5145ms | 99.903% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_2 | ✅ | 5011ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_3 | ✅ | 5095ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_4 | ✅ | 5102ms | 100.000% | 23 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_5 | ✅ | 5101ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_1 | ✅ | 4955ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_2 | ✅ | 5008ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_3 | ✅ | 4979ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_4 | ✅ | 5045ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_5 | ✅ | 5040ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_1 | ✅ | 5080ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_2 | ✅ | 5165ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_3 | ✅ | 5333ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_4 | ✅ | 5321ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_5 | ✅ | 5091ms | 100.000% | 2 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_1 | ✅ | 4771ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_2 | ✅ | 4769ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_3 | ✅ | 4765ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_4 | ✅ | 4772ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_5 | ✅ | 4772ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_1 | ✅ | 4769ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_2 | ✅ | 4775ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_3 | ✅ | 4770ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_4 | ✅ | 4771ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_5 | ✅ | 4769ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_1 | ✅ | 4773ms | 100.000% | 3 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_2 | ✅ | 4771ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_3 | ✅ | 4774ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_4 | ✅ | 4771ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_5 | ✅ | 4774ms | 100.000% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_1 | ✅ | 5034ms | 99.889% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_2 | ✅ | 5008ms | 99.647% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_3 | ✅ | 4960ms | 99.892% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_4 | ✅ | 5141ms | 99.841% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_5 | ✅ | 5078ms | 99.803% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Special (12/12)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| fill_variations | ✅ | 7368ms | 100.000% | 0 | 10 / 10 / 10 | 1 / 1 / 1 |
| blur_tools_test | ✅ | 7776ms | 99.999% | 66 | 11 / 11 / 11 | 1 / 1 / 1 |
| eraser_over_strokes | ✅ | 6061ms | 99.980% | 255 | 5 / 5 / 5 | 1 / 1 / 1 |
| blend_modes_layered | ✅ | 5988ms | 99.928% | 255 | 4 / 4 / 4 | 1 / 1 / 1 |
| image_brush_set | ✅ | 5925ms | 100.000% | 0 | 5 / 5 / 5 | 1 / 1 / 1 |
| gimp_brush_strokes | ✅ | 5140ms | 100.000% | 0 | 0 / 0 / 0 | 1 / 1 / 1 |
| text_tool_set | ✅ | 7270ms | 100.000% | 0 | 0 / 0 / 0 | 1 / 1 / 1 |
| confetti_image_brush | ✅ | 5757ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| confetti_options_mix | ✅ | 5820ms | 99.994% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| select_complex_transform | ✅ | 5652ms | 100.000% | 0 | 1 / 1 / 1 | 1 / 1 / 1 |
| undo_after_strokes | ✅ | 6600ms | 99.963% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| mixed_tool_sequence | ✅ | 7687ms | 99.983% | 255 | 6 / 6 / 6 | 1 / 1 / 1 |

## Concurrent (9/9)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| brush_concurrent | ✅ | 5406ms | 99.979% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| ink_concurrent | ✅ | 6540ms | 99.996% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| flowPen_concurrent | ✅ | 6039ms | 99.985% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| pixel_concurrent | ✅ | 5361ms | 100.000% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| line_concurrent | ✅ | 5000ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| circle_concurrent | ✅ | 5025ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| rectangle_concurrent | ✅ | 5025ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| confetti_concurrent | ✅ | 5204ms | 99.952% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| mixed_tools_concurrent | ✅ | 5190ms | 99.994% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |

## Flood (5/5)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| flood_drawer_25_brush | ✅ | 12423ms | 99.592% | 255 | 20 / 20 / 20 | 1 / 1 / 1 |
| flood_drawer_30_mixed | ✅ | 14939ms | 99.956% | 255 | 20 / 20 / 20 | 1 / 1 / 1 |
| flood_drawer_25_then_undo | ✅ | 12568ms | 99.769% | 255 | 17 / 17 / 17 | 1 / 1 / 1 |
| flood_concurrent_25_each | ✅ | 13531ms | 99.994% | 255 | 60 / 60 / 60 | 1 / 1 / 1 |
| flood_concurrent_blend_modes | ✅ | 12942ms | 99.513% | 255 | 60 / 60 / 60 | 1 / 1 / 1 |

