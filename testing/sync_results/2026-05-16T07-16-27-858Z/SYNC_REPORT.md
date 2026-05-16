# Comprehensive Sync Report

Generated: 2026-05-16T07:17:00.801Z
Room: `comp_sync_1778915787859`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±16 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 1/3 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Special (1/2)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| eraser_over_strokes | ❌ | 6097ms | 92.149% | 255 | 5 / 5 / 5 | 1 / 1 / 1 |
| image_brush_set | ✅ | 5980ms | 100.000% | 0 | 5 / 5 / 5 | 1 / 1 / 1 |

## Flood (0/1)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| flood_concurrent_blend_modes | ❌ | 12973ms | 99.370% | 240 | 60 / 60 / 60 | 1 / 1 / 1 |

## Failure detail

### eraser_over_strokes

- Worst match: **92.149%**  Worst maxΔ: **255**
- Stroke totals: 5 / 5 / 5 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 92.149% (maxΔ 255)
    - group 0: 92.149% match · maxΔ 255 · bbox 673×280@(160,260) · 173646/188440 px
- bot_2 vs drawer: 92.149% (maxΔ 255)
    - group 0: 92.149% match · maxΔ 255 · bbox 673×280@(160,260) · 173646/188440 px
- Screenshots: `FAIL_eraser_over_strokes__bot_*.png`

### flood_concurrent_blend_modes

- Worst match: **99.370%**  Worst maxΔ: **240**
- Stroke totals: 60 / 60 / 60 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 100.000% (maxΔ 240)
    - group 0: 100.000% match · maxΔ 240 · bbox 959×1010@(170,70) · 968589/968590 px
- bot_2 vs drawer: 99.370% (maxΔ 220)
    - group 0: 99.370% match · maxΔ 220 · bbox 959×1010@(170,70) · 962485/968590 px
- Screenshots: `FAIL_flood_concurrent_blend_modes__bot_*.png`

