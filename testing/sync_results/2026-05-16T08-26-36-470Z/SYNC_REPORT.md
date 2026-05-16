# Comprehensive Sync Report

Generated: 2026-05-16T08:26:51.372Z
Room: `comp_sync_1778919996471`
Bots: 3  |  Drawer: bot_0  |  Propagation: 3500ms
Pixel tolerance: ±16 per channel  |  Pass threshold: ≥99.5% matching pixels in union dirty bbox

**Result: 0/1 passed**

> Comparison is on each layer group's *model state* (flatCanvas + strokeStack composited in timestamp order), not the rendered mainCanvas. Diffs run over the union of non-transparent bboxes between drawer and observer.

## Special (0/1)

| Test | Status | Elapsed | Worst match % | Worst maxΔ | Stroke totals | Baked groups |
| :--- | :--- | --- | --- | --- | :--- | :--- |
| undo_after_strokes | ❌ | 6873ms | 81.996% | 255 | ❌ 3 / 5 / 5 | 1 / 1 / 1 |

## Failure detail

### undo_after_strokes

- Worst match: **81.996%**  Worst maxΔ: **255**
- Stroke totals: 3 / 5 / 5 (equal: no)
- Baked groups per bot: 1 / 1 / 1
- bot_1 vs drawer: 81.996% (maxΔ 255)
    - group 0: 81.996% match · maxΔ 255 · bbox 875×608@(160,220) · 436220/532000 px
- bot_2 vs drawer: 81.996% (maxΔ 255)
    - group 0: 81.996% match · maxΔ 255 · bbox 875×608@(160,220) · 436220/532000 px
- Screenshots: `FAIL_undo_after_strokes__bot_*.png`

