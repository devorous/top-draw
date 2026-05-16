# Comprehensive Sync Report

Generated: 2026-05-16T05:24:22.374Z
Room: `comp_sync_1778908975077`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±4 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 10/12 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Special (10/12)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| fill_variations | ✅ | 7825ms | 100.000% | 0 | 10 / 10 / 10 | 1 / 1 / 1 |
| blur_tools_test | ✅ | 8235ms | 100.000% | 64 | 11 / 11 / 11 | 1 / 1 / 1 |
| eraser_over_strokes | ❌ | 6116ms | 91.415% | 255 | 5 / 5 / 5 | 1 / 1 / 1 |
| blend_modes_layered | ✅ | 6433ms | 99.993% | 255 | 4 / 4 / 4 | 1 / 1 / 1 |
| image_brush_set | ❌ | 5994ms | 98.232% | 255 | ❌ 5 / 4 / 4 | 1 / 1 / 1 |
| gimp_brush_strokes | ✅ | 5172ms | 100.000% | 0 | 0 / 0 / 0 | 1 / 1 / 1 |
| text_tool_set | ✅ | 7304ms | 100.000% | 0 | 0 / 0 / 0 | 1 / 1 / 1 |
| confetti_image_brush | ✅ | 5835ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| confetti_options_mix | ✅ | 5864ms | 99.911% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| select_complex_transform | ✅ | 5709ms | 100.000% | 0 | 1 / 1 / 1 | 1 / 1 / 1 |
| undo_after_strokes | ✅ | 6653ms | 100.000% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| mixed_tool_sequence | ✅ | 7508ms | 99.957% | 255 | 6 / 6 / 6 | 1 / 1 / 1 |

## Failure detail

### eraser_over_strokes

- Worst match: **91.415%**  Worst maxΔ: **255**
- Stroke totals: 5 / 5 / 5 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 91.415% (maxΔ 255)
    - group 0: 91.415% match · maxΔ 255 · bbox 678×280@(160,260) · 173542/189840 px
- bot_2 vs drawer: 91.415% (maxΔ 255)
    - group 0: 91.415% match · maxΔ 255 · bbox 678×280@(160,260) · 173542/189840 px
- Screenshots: `FAIL_eraser_over_strokes__bot_*.png`

### image_brush_set

- Worst match: **98.232%**  Worst maxΔ: **255**
- Stroke totals: 5 / 4 / 4 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.232% (maxΔ 255)
    - group 0: 98.232% match · maxΔ 255 · bbox 1344×608@(235,151) · 802705/817152 px
- bot_2 vs drawer: 98.232% (maxΔ 255)
    - group 0: 98.232% match · maxΔ 255 · bbox 1344×608@(235,151) · 802705/817152 px
- Screenshots: `FAIL_image_brush_set__bot_*.png`

