# Comprehensive Sync Report

Generated: 2026-05-16T05:24:22.737Z
Room: `comp_sync_1778908977408`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±4 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 3/6 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Concurrent (1/1)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| mixed_tools_concurrent | ✅ | 5390ms | 99.999% | 219 | 3 / 3 / 3 | 1 / 1 / 1 |

## Flood (2/5)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| flood_drawer_25_brush | ✅ | 12582ms | 99.948% | 247 | 20 / 20 / 20 | 1 / 1 / 1 |
| flood_drawer_30_mixed | ✅ | 14700ms | 99.868% | 255 | 20 / 20 / 20 | 1 / 1 / 1 |
| flood_drawer_25_then_undo | ❌ | 12702ms | 91.095% | 255 | ❌ 17 / 20 / 20 | 1 / 1 / 1 |
| flood_concurrent_25_each | ❌ | 13695ms | 81.661% | 255 | 60 / 60 / 60 | 1 / 1 / 1 |
| flood_concurrent_blend_modes | ❌ | 13179ms | 99.995% | 255 | ❌ 59 / 59 / 60 | 1 / 1 / 1 |

## Failure detail

### flood_drawer_25_then_undo

- Worst match: **91.095%**  Worst maxΔ: **255**
- Stroke totals: 17 / 20 / 20 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 91.095% (maxΔ 255)
    - group 0: 91.095% match · maxΔ 255 · bbox 1234×900@(186,66) · 1011699/1110600 px
- bot_2 vs drawer: 91.095% (maxΔ 255)
    - group 0: 91.095% match · maxΔ 255 · bbox 1234×900@(186,66) · 1011699/1110600 px
- Screenshots: `FAIL_flood_drawer_25_then_undo__bot_*.png`

### flood_concurrent_25_each

- Worst match: **81.661%**  Worst maxΔ: **255**
- Stroke totals: 60 / 60 / 60 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 81.661% (maxΔ 255)
    - group 0: 81.661% match · maxΔ 255 · bbox 1543×833@(162,0) · 1049609/1285319 px
- bot_2 vs drawer: 81.661% (maxΔ 255)
    - group 0: 81.661% match · maxΔ 255 · bbox 1543×833@(162,0) · 1049601/1285319 px
- Screenshots: `FAIL_flood_concurrent_25_each__bot_*.png`

### flood_concurrent_blend_modes

- Worst match: **99.995%**  Worst maxΔ: **255**
- Stroke totals: 59 / 59 / 60 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.995% (maxΔ 255)
    - group 0: 99.995% match · maxΔ 255 · bbox 959×1010@(170,70) · 968539/968590 px
- bot_2 vs drawer: 99.996% (maxΔ 255)
    - group 0: 99.996% match · maxΔ 255 · bbox 959×1010@(170,70) · 968552/968590 px
- Screenshots: `FAIL_flood_concurrent_blend_modes__bot_*.png`

