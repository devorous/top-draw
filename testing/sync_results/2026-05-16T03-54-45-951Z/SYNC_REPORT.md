# Comprehensive Sync Report

Generated: 2026-05-16T04:01:29.470Z
Room: `comp_sync_1778903685952`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±4 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 25/66 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Tool (13/40)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| ink_step_1 | ✅ | 5114ms | 99.796% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_2 | ✅ | 5156ms | 99.531% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_3 | ✅ | 5056ms | 99.506% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_4 | ✅ | 5338ms | 99.747% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| ink_step_5 | ✅ | 5049ms | 99.854% | 128 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_1 | ❌ | 5237ms | 99.244% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_2 | ❌ | 5081ms | 83.007% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_3 | ❌ | 5173ms | 93.397% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_4 | ✅ | 5143ms | 100.000% | 1 | 1 / 1 / 1 | 1 / 1 / 1 |
| brush_step_5 | ❌ | 5141ms | 82.664% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_1 | ✅ | 4998ms | 99.835% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_2 | ✅ | 5066ms | 99.790% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_3 | ✅ | 5034ms | 99.724% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_4 | ✅ | 5112ms | 99.745% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| pixel_step_5 | ✅ | 5064ms | 99.790% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_1 | ❌ | 5081ms | 45.602% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_2 | ❌ | 5112ms | 60.286% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_3 | ❌ | 5203ms | 61.409% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_4 | ❌ | 5218ms | 51.982% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| flowPen_step_5 | ❌ | 5080ms | 59.523% | 51 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_1 | ❌ | 4829ms | 98.928% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_2 | ❌ | 4840ms | 74.341% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_3 | ✅ | 4785ms | 99.747% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_4 | ❌ | 4819ms | 96.022% | 7 | 1 / 1 / 1 | 1 / 1 / 1 |
| rectangle_step_5 | ❌ | 4817ms | 96.322% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_1 | ❌ | 4806ms | 86.944% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_2 | ❌ | 4815ms | 96.156% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_3 | ✅ | 4829ms | 99.971% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_4 | ❌ | 4825ms | 97.784% | 7 | 1 / 1 / 1 | 1 / 1 / 1 |
| circle_step_5 | ❌ | 4808ms | 96.114% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_1 | ❌ | 4805ms | 97.415% | 23 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_2 | ❌ | 4824ms | 84.485% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_3 | ❌ | 4804ms | 89.934% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_4 | ❌ | 4805ms | 43.146% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| line_step_5 | ❌ | 4827ms | 68.225% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_1 | ❌ | 5080ms | 98.357% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_2 | ❌ | 5044ms | 95.095% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_3 | ❌ | 4987ms | 96.900% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_4 | ❌ | 5165ms | 98.313% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| confetti_step_5 | ❌ | 5116ms | 96.977% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |

## Special (6/12)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| fill_variations | ❌ | 7530ms | 91.947% | 255 | ❌ 10 / 9 / 9 | 1 / 1 / 1 |
| blur_tools_test | ❌ | 8358ms | 6.001% | 255 | ❌ 11 / 12 / 12 | 1 / 1 / 1 |
| eraser_over_strokes | ❌ | 6065ms | 88.560% | 255 | 5 / 5 / 5 | 1 / 1 / 1 |
| blend_modes_layered | ✅ | 6291ms | 99.929% | 255 | 4 / 4 / 4 | 1 / 1 / 1 |
| image_brush_set | ❌ | 5991ms | 98.162% | 255 | ❌ 5 / 4 / 4 | 1 / 1 / 1 |
| gimp_brush_strokes | ✅ | 5161ms | 100.000% | 0 | 0 / 0 / 0 | 1 / 1 / 1 |
| text_tool_set | ✅ | 7311ms | 100.000% | 0 | 0 / 0 / 0 | 1 / 1 / 1 |
| confetti_image_brush | ✅ | 5823ms | 100.000% | 0 | 3 / 3 / 3 | 1 / 1 / 1 |
| confetti_options_mix | ✅ | 5876ms | 99.890% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| select_complex_transform | ✅ | 5694ms | 99.553% | 255 | 1 / 1 / 1 | 1 / 1 / 1 |
| undo_after_strokes | ❌ | 6685ms | 65.053% | 255 | ❌ 3 / 5 / 5 | 1 / 1 / 1 |
| mixed_tool_sequence | ❌ | 7422ms | 92.024% | 255 | 6 / 6 / 6 | 1 / 1 / 1 |

## Concurrent (4/9)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| brush_concurrent | ✅ | 5353ms | 99.834% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| ink_concurrent | ❌ | 5528ms | 99.241% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| flowPen_concurrent | ❌ | 5400ms | 82.356% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| pixel_concurrent | ✅ | 5311ms | 99.943% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| line_concurrent | ❌ | 5000ms | 98.976% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| circle_concurrent | ✅ | 5124ms | 99.982% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| rectangle_concurrent | ✅ | 5108ms | 99.838% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| confetti_concurrent | ❌ | 5200ms | 99.297% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |
| mixed_tools_concurrent | ❌ | 5333ms | 99.086% | 255 | 3 / 3 / 3 | 1 / 1 / 1 |

## Flood (2/5)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| flood_drawer_25_brush | ✅ | 12700ms | 99.812% | 255 | 20 / 20 / 20 | 1 / 1 / 1 |
| flood_drawer_30_mixed | ❌ | 14991ms | 71.229% | 255 | 20 / 20 / 20 | 1 / 1 / 1 |
| flood_drawer_25_then_undo | ❌ | 12855ms | 84.683% | 255 | ❌ 17 / 20 / 20 | 1 / 1 / 1 |
| flood_concurrent_25_each | ❌ | 13602ms | 57.022% | 255 | 60 / 60 / 60 | 1 / 1 / 1 |
| flood_concurrent_blend_modes | ✅ | 12788ms | 99.817% | 255 | 60 / 60 / 60 | 1 / 1 / 1 |

## Failure detail

### brush_step_1

- Worst match: **99.244%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.244% (maxΔ 255)
    - group 0: 99.244% match · maxΔ 255 · bbox 453×438@(652,492) · 196914/198414 px
- bot_2 vs drawer: 99.244% (maxΔ 255)
    - group 0: 99.244% match · maxΔ 255 · bbox 453×438@(652,492) · 196914/198414 px
- Screenshots: `FAIL_brush_step_1__bot_*.png`

### brush_step_2

- Worst match: **83.007%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 83.007% (maxΔ 255)
    - group 0: 83.007% match · maxΔ 255 · bbox 394×447@(646,101) · 146190/176118 px
- bot_2 vs drawer: 83.007% (maxΔ 255)
    - group 0: 83.007% match · maxΔ 255 · bbox 394×447@(646,101) · 146190/176118 px
- Screenshots: `FAIL_brush_step_2__bot_*.png`

### brush_step_3

- Worst match: **93.397%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 93.397% (maxΔ 255)
    - group 0: 93.397% match · maxΔ 255 · bbox 516×520@(873,0) · 250604/268320 px
- bot_2 vs drawer: 93.397% (maxΔ 255)
    - group 0: 93.397% match · maxΔ 255 · bbox 516×520@(873,0) · 250604/268320 px
- Screenshots: `FAIL_brush_step_3__bot_*.png`

### brush_step_5

- Worst match: **82.664%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 82.664% (maxΔ 255)
    - group 0: 82.664% match · maxΔ 255 · bbox 413×445@(834,609) · 151924/183785 px
- bot_2 vs drawer: 82.664% (maxΔ 255)
    - group 0: 82.664% match · maxΔ 255 · bbox 413×445@(834,609) · 151924/183785 px
- Screenshots: `FAIL_brush_step_5__bot_*.png`

### flowPen_step_1

- Worst match: **45.602%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 45.602% (maxΔ 255)
    - group 0: 45.602% match · maxΔ 255 · bbox 326×313@(667,543) · 46531/102038 px
- bot_2 vs drawer: 45.602% (maxΔ 255)
    - group 0: 45.602% match · maxΔ 255 · bbox 326×313@(667,543) · 46531/102038 px
- Screenshots: `FAIL_flowpen_step_1__bot_*.png`

### flowPen_step_2

- Worst match: **60.286%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 60.286% (maxΔ 255)
    - group 0: 60.286% match · maxΔ 255 · bbox 398×482@(170,289) · 115651/191836 px
- bot_2 vs drawer: 60.286% (maxΔ 255)
    - group 0: 60.286% match · maxΔ 255 · bbox 398×482@(170,289) · 115651/191836 px
- Screenshots: `FAIL_flowpen_step_2__bot_*.png`

### flowPen_step_3

- Worst match: **61.409%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 61.409% (maxΔ 255)
    - group 0: 61.409% match · maxΔ 255 · bbox 505×469@(1415,575) · 145445/236845 px
- bot_2 vs drawer: 61.409% (maxΔ 255)
    - group 0: 61.409% match · maxΔ 255 · bbox 505×469@(1415,575) · 145445/236845 px
- Screenshots: `FAIL_flowpen_step_3__bot_*.png`

### flowPen_step_4

- Worst match: **51.982%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 51.982% (maxΔ 255)
    - group 0: 51.982% match · maxΔ 255 · bbox 458×466@(869,464) · 110944/213428 px
- bot_2 vs drawer: 51.982% (maxΔ 255)
    - group 0: 51.982% match · maxΔ 255 · bbox 458×466@(869,464) · 110944/213428 px
- Screenshots: `FAIL_flowpen_step_4__bot_*.png`

### flowPen_step_5

- Worst match: **59.523%**  Worst maxΔ: **51**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 59.523% (maxΔ 51)
    - group 0: 59.523% match · maxΔ 51 · bbox 430×387@(982,320) · 99053/166410 px
- bot_2 vs drawer: 59.523% (maxΔ 51)
    - group 0: 59.523% match · maxΔ 51 · bbox 430×387@(982,320) · 99053/166410 px
- Screenshots: `FAIL_flowpen_step_5__bot_*.png`

### rectangle_step_1

- Worst match: **98.928%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.928% (maxΔ 255)
    - group 0: 98.928% match · maxΔ 255 · bbox 231×101@(1084,418) · 23081/23331 px
- bot_2 vs drawer: 98.928% (maxΔ 255)
    - group 0: 98.928% match · maxΔ 255 · bbox 231×101@(1084,418) · 23081/23331 px
- Screenshots: `FAIL_rectangle_step_1__bot_*.png`

### rectangle_step_2

- Worst match: **74.341%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 74.341% (maxΔ 255)
    - group 0: 74.341% match · maxΔ 255 · bbox 131×217@(595,0) · 21133/28427 px
- bot_2 vs drawer: 74.341% (maxΔ 255)
    - group 0: 74.341% match · maxΔ 255 · bbox 131×217@(595,0) · 21133/28427 px
- Screenshots: `FAIL_rectangle_step_2__bot_*.png`

### rectangle_step_4

- Worst match: **96.022%**  Worst maxΔ: **7**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 96.022% (maxΔ 7)
    - group 0: 96.022% match · maxΔ 7 · bbox 237×164@(92,145) · 37322/38868 px
- bot_2 vs drawer: 96.022% (maxΔ 7)
    - group 0: 96.022% match · maxΔ 7 · bbox 237×164@(92,145) · 37322/38868 px
- Screenshots: `FAIL_rectangle_step_4__bot_*.png`

### rectangle_step_5

- Worst match: **96.322%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 96.322% (maxΔ 255)
    - group 0: 96.322% match · maxΔ 255 · bbox 218×165@(199,317) · 34647/35970 px
- bot_2 vs drawer: 96.322% (maxΔ 255)
    - group 0: 96.322% match · maxΔ 255 · bbox 218×165@(199,317) · 34647/35970 px
- Screenshots: `FAIL_rectangle_step_5__bot_*.png`

### circle_step_1

- Worst match: **86.944%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 86.944% (maxΔ 255)
    - group 0: 86.944% match · maxΔ 255 · bbox 165×155@(1543,206) · 22236/25575 px
- bot_2 vs drawer: 86.944% (maxΔ 255)
    - group 0: 86.944% match · maxΔ 255 · bbox 165×155@(1543,206) · 22236/25575 px
- Screenshots: `FAIL_circle_step_1__bot_*.png`

### circle_step_2

- Worst match: **96.156%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 96.156% (maxΔ 255)
    - group 0: 96.156% match · maxΔ 255 · bbox 217×176@(563,89) · 36724/38192 px
- bot_2 vs drawer: 96.156% (maxΔ 255)
    - group 0: 96.156% match · maxΔ 255 · bbox 217×176@(563,89) · 36724/38192 px
- Screenshots: `FAIL_circle_step_2__bot_*.png`

### circle_step_4

- Worst match: **97.784%**  Worst maxΔ: **7**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 97.784% (maxΔ 7)
    - group 0: 97.784% match · maxΔ 7 · bbox 209×144@(189,660) · 29429/30096 px
- bot_2 vs drawer: 97.784% (maxΔ 7)
    - group 0: 97.784% match · maxΔ 7 · bbox 209×144@(189,660) · 29429/30096 px
- Screenshots: `FAIL_circle_step_4__bot_*.png`

### circle_step_5

- Worst match: **96.114%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 96.114% (maxΔ 255)
    - group 0: 96.114% match · maxΔ 255 · bbox 96×152@(945,639) · 14025/14592 px
- bot_2 vs drawer: 96.114% (maxΔ 255)
    - group 0: 96.114% match · maxΔ 255 · bbox 96×152@(945,639) · 14025/14592 px
- Screenshots: `FAIL_circle_step_5__bot_*.png`

### line_step_1

- Worst match: **97.415%**  Worst maxΔ: **23**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 97.415% (maxΔ 23)
    - group 0: 97.415% match · maxΔ 23 · bbox 231×175@(205,87) · 39380/40425 px
- bot_2 vs drawer: 97.415% (maxΔ 23)
    - group 0: 97.415% match · maxΔ 23 · bbox 231×175@(205,87) · 39380/40425 px
- Screenshots: `FAIL_line_step_1__bot_*.png`

### line_step_2

- Worst match: **84.485%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 84.485% (maxΔ 255)
    - group 0: 84.485% match · maxΔ 255 · bbox 208×111@(722,355) · 19506/23088 px
- bot_2 vs drawer: 84.485% (maxΔ 255)
    - group 0: 84.485% match · maxΔ 255 · bbox 208×111@(722,355) · 19506/23088 px
- Screenshots: `FAIL_line_step_2__bot_*.png`

### line_step_3

- Worst match: **89.934%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 89.934% (maxΔ 255)
    - group 0: 89.934% match · maxΔ 255 · bbox 257×154@(906,401) · 35594/39578 px
- bot_2 vs drawer: 89.934% (maxΔ 255)
    - group 0: 89.934% match · maxΔ 255 · bbox 257×154@(906,401) · 35594/39578 px
- Screenshots: `FAIL_line_step_3__bot_*.png`

### line_step_4

- Worst match: **43.146%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 43.146% (maxΔ 255)
    - group 0: 43.146% match · maxΔ 255 · bbox 77×72@(403,468) · 2392/5544 px
- bot_2 vs drawer: 43.146% (maxΔ 255)
    - group 0: 43.146% match · maxΔ 255 · bbox 77×72@(403,468) · 2392/5544 px
- Screenshots: `FAIL_line_step_4__bot_*.png`

### line_step_5

- Worst match: **68.225%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 68.225% (maxΔ 255)
    - group 0: 68.225% match · maxΔ 255 · bbox 208×272@(167,543) · 38599/56576 px
- bot_2 vs drawer: 68.225% (maxΔ 255)
    - group 0: 68.225% match · maxΔ 255 · bbox 208×272@(167,543) · 38599/56576 px
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

- Worst match: **96.977%**  Worst maxΔ: **255**
- Stroke totals: 1 / 1 / 1 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 96.977% (maxΔ 255)
    - group 0: 96.977% match · maxΔ 255 · bbox 402×428@(1456,315) · 166855/172056 px
- bot_2 vs drawer: 96.977% (maxΔ 255)
    - group 0: 96.977% match · maxΔ 255 · bbox 402×428@(1456,315) · 166855/172056 px
- Screenshots: `FAIL_confetti_step_5__bot_*.png`

### fill_variations

- Worst match: **91.947%**  Worst maxΔ: **255**
- Stroke totals: 10 / 9 / 9 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 91.947% (maxΔ 255)
    - group 0: 91.947% match · maxΔ 255 · bbox 1450×450@(125,175) · 599956/652500 px
- bot_2 vs drawer: 91.947% (maxΔ 255)
    - group 0: 91.947% match · maxΔ 255 · bbox 1450×450@(125,175) · 599956/652500 px
- Screenshots: `FAIL_fill_variations__bot_*.png`

### blur_tools_test

- Worst match: **6.001%**  Worst maxΔ: **255**
- Stroke totals: 11 / 12 / 12 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 6.001% (maxΔ 255)
    - group 0: 6.001% match · maxΔ 255 · bbox 1920×1080@(0,0) · 124447/2073600 px
- bot_2 vs drawer: 6.001% (maxΔ 255)
    - group 0: 6.001% match · maxΔ 255 · bbox 1920×1080@(0,0) · 124447/2073600 px
- Screenshots: `FAIL_blur_tools_test__bot_*.png`

### eraser_over_strokes

- Worst match: **88.560%**  Worst maxΔ: **255**
- Stroke totals: 5 / 5 / 5 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 88.560% (maxΔ 255)
    - group 0: 88.560% match · maxΔ 255 · bbox 746×353@(129,225) · 233212/263338 px
- bot_2 vs drawer: 88.560% (maxΔ 255)
    - group 0: 88.560% match · maxΔ 255 · bbox 746×353@(129,225) · 233212/263338 px
- Screenshots: `FAIL_eraser_over_strokes__bot_*.png`

### image_brush_set

- Worst match: **98.162%**  Worst maxΔ: **255**
- Stroke totals: 5 / 4 / 4 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.162% (maxΔ 255)
    - group 0: 98.162% match · maxΔ 255 · bbox 1344×608@(235,151) · 802129/817152 px
- bot_2 vs drawer: 98.162% (maxΔ 255)
    - group 0: 98.162% match · maxΔ 255 · bbox 1344×608@(235,151) · 802129/817152 px
- Screenshots: `FAIL_image_brush_set__bot_*.png`

### undo_after_strokes

- Worst match: **65.053%**  Worst maxΔ: **255**
- Stroke totals: 3 / 5 / 5 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 65.053% (maxΔ 255)
    - group 0: 65.053% match · maxΔ 255 · bbox 946×681@(125,187) · 419089/644226 px
- bot_2 vs drawer: 65.053% (maxΔ 255)
    - group 0: 65.053% match · maxΔ 255 · bbox 946×681@(125,187) · 419089/644226 px
- Screenshots: `FAIL_undo_after_strokes__bot_*.png`

### mixed_tool_sequence

- Worst match: **92.024%**  Worst maxΔ: **255**
- Stroke totals: 6 / 6 / 6 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 92.024% (maxΔ 255)
    - group 0: 92.024% match · maxΔ 255 · bbox 1239×918@(653,0) · 1046686/1137402 px
- bot_2 vs drawer: 92.024% (maxΔ 255)
    - group 0: 92.024% match · maxΔ 255 · bbox 1239×918@(653,0) · 1046686/1137402 px
- Screenshots: `FAIL_mixed_tool_sequence__bot_*.png`

### ink_concurrent

- Worst match: **99.241%**  Worst maxΔ: **255**
- Stroke totals: 3 / 3 / 3 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.241% (maxΔ 255)
    - group 0: 99.241% match · maxΔ 255 · bbox 1002×690@(183,198) · 686133/691380 px
- bot_2 vs drawer: 99.312% (maxΔ 255)
    - group 0: 99.312% match · maxΔ 255 · bbox 1002×690@(183,198) · 686623/691380 px
- Screenshots: `FAIL_ink_concurrent__bot_*.png`

### flowPen_concurrent

- Worst match: **82.356%**  Worst maxΔ: **255**
- Stroke totals: 3 / 3 / 3 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 82.573% (maxΔ 255)
    - group 0: 82.573% match · maxΔ 255 · bbox 1052×793@(150,163) · 688852/834236 px
- bot_2 vs drawer: 82.356% (maxΔ 255)
    - group 0: 82.356% match · maxΔ 255 · bbox 1052×793@(150,163) · 687043/834236 px
- Screenshots: `FAIL_flowpen_concurrent__bot_*.png`

### line_concurrent

- Worst match: **98.976%**  Worst maxΔ: **255**
- Stroke totals: 3 / 3 / 3 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 98.976% (maxΔ 255)
    - group 0: 98.976% match · maxΔ 255 · bbox 960×738@(170,170) · 701224/708480 px
- bot_2 vs drawer: 98.982% (maxΔ 255)
    - group 0: 98.982% match · maxΔ 255 · bbox 938×760@(170,170) · 705624/712880 px
- Screenshots: `FAIL_line_concurrent__bot_*.png`

### confetti_concurrent

- Worst match: **99.297%**  Worst maxΔ: **255**
- Stroke totals: 3 / 3 / 3 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.328% (maxΔ 255)
    - group 0: 99.328% match · maxΔ 255 · bbox 996×737@(180,187) · 729116/734052 px
- bot_2 vs drawer: 99.297% (maxΔ 255)
    - group 0: 99.297% match · maxΔ 255 · bbox 996×737@(180,187) · 728894/734052 px
- Screenshots: `FAIL_confetti_concurrent__bot_*.png`

### mixed_tools_concurrent

- Worst match: **99.086%**  Worst maxΔ: **255**
- Stroke totals: 3 / 3 / 3 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 99.086% (maxΔ 255)
    - group 0: 99.086% match · maxΔ 255 · bbox 998×798@(150,153) · 789122/796404 px
- bot_2 vs drawer: 99.844% (maxΔ 255)
    - group 0: 99.844% match · maxΔ 255 · bbox 972×777@(150,174) · 754068/755244 px
- Screenshots: `FAIL_mixed_tools_concurrent__bot_*.png`

### flood_drawer_30_mixed

- Worst match: **71.229%**  Worst maxΔ: **255**
- Stroke totals: 20 / 20 / 20 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 71.229% (maxΔ 255)
    - group 0: 71.229% match · maxΔ 255 · bbox 1441×1080@(131,0) · 1108521/1556280 px
- bot_2 vs drawer: 71.229% (maxΔ 255)
    - group 0: 71.229% match · maxΔ 255 · bbox 1441×1080@(131,0) · 1108521/1556280 px
- Screenshots: `FAIL_flood_drawer_30_mixed__bot_*.png`

### flood_drawer_25_then_undo

- Worst match: **84.683%**  Worst maxΔ: **255**
- Stroke totals: 17 / 20 / 20 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 84.683% (maxΔ 255)
    - group 0: 84.683% match · maxΔ 255 · bbox 1381×956@(161,38) · 1118016/1320236 px
- bot_2 vs drawer: 84.683% (maxΔ 255)
    - group 0: 84.683% match · maxΔ 255 · bbox 1381×956@(161,38) · 1118016/1320236 px
- Screenshots: `FAIL_flood_drawer_25_then_undo__bot_*.png`

### flood_concurrent_25_each

- Worst match: **57.022%**  Worst maxΔ: **255**
- Stroke totals: 60 / 60 / 60 (equal: yes)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 57.022% (maxΔ 255)
    - group 0: 57.022% match · maxΔ 255 · bbox 1610×860@(131,0) · 789530/1384600 px
- bot_2 vs drawer: 57.212% (maxΔ 255)
    - group 0: 57.212% match · maxΔ 255 · bbox 1610×864@(131,0) · 795842/1391040 px
- Screenshots: `FAIL_flood_concurrent_25_each__bot_*.png`

