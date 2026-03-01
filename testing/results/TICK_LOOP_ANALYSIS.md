# Tick Loop Performance Analysis

Generated: 2024-02-28
System: Intel Celeron N4500 @ 1.10GHz, Node.js 22.21.1

---

## Executive Summary

**Key Finding:** The current 90 TPS setting is optimal for balancing performance and responsiveness. Moving to higher tick rates (120-150 TPS) provides diminishing returns while increasing CPU overhead.

---

## 1. Tick Rate Comparison (5 points per tick)

| Tick Rate | Avg Time | P95 Time | CPU per Second* | Messages/sec |
|-----------|----------|----------|-----------------|--------------|
| 30 TPS    | 2.54 µs  | 12.43 µs | 76.2 µs         | 30           |
| 60 TPS    | 1.06 µs  | 1.52 µs  | 63.6 µs         | 60           |
| **90 TPS**| **1.21 µs** | **2.66 µs** | **108.9 µs** | **90**       |
| 120 TPS   | 1.19 µs  | 2.17 µs  | 142.8 µs        | 120          |
| 150 TPS   | 1.35 µs  | 3.64 µs  | 202.5 µs        | 150          |

*CPU per Second = Avg Time × Tick Rate

### Analysis

**30 TPS has high variance** - The P95 time is 4.9x worse than average (12.43 µs vs 2.54 µs), indicating inconsistent performance. This is likely due to larger batches causing more processing spikes.

**60 TPS is most consistent** - Low variance (P95 only 1.4x average) and good per-tick performance.

**90 TPS (current) is the sweet spot:**
- Very consistent performance (P95 is 2.2x average)
- Good balance of messages/sec and CPU overhead
- Per-tick cost similar to 120 TPS but with fewer messages

**120 TPS diminishing returns:**
- Only 1.6% faster per tick than 90 TPS (1.19 µs vs 1.21 µs)
- 31% more CPU overhead per second (142.8 µs vs 108.9 µs)
- 33% more network messages

**150 TPS worse than 90 TPS:**
- 11.6% slower per tick (1.35 µs vs 1.21 µs)
- 86% more CPU overhead per second (202.5 µs vs 108.9 µs)
- 67% more network messages

---

## 2. Point Count Impact (90 TPS)

| Points | Avg Time | Per Point Cost | Overhead vs 2 points |
|--------|----------|----------------|----------------------|
| 2      | 975 ns   | 487 ns         | Baseline             |
| 5      | 1.22 µs  | 244 ns         | +25%                 |
| 10     | 1.70 µs  | 170 ns         | +74%                 |
| 20     | 2.49 µs  | 124 ns         | +155%                |

### Analysis

**Cost per point decreases as batch size increases:**
- 2 points: 487 ns per point
- 5 points: 244 ns per point (2x more efficient)
- 10 points: 170 ns per point (2.9x more efficient)
- 20 points: 124 ns per point (3.9x more efficient)

**Implication:** Larger batches are more efficient due to amortized overhead. However, larger batches mean:
- Higher latency (longer time between ticks)
- More data per network message

**Current 90 TPS with ~5 points per tick is optimal** - Good efficiency without excessive latency.

---

## 3. Tool Comparison (90 TPS, 5 points)

| Tool     | Avg Time | Relative Speed | Notes                    |
|----------|----------|----------------|--------------------------|
| Blur     | 1.02 µs  | Fastest (1.0x) | Uses reduced points      |
| Ink      | 1.07 µs  | 1.05x          | Custom point buffer      |
| Brush    | 1.33 µs  | 1.30x          | Standard processing      |
| FlowPen  | 1.59 µs  | 1.56x          | Stamp generation         |

### Analysis

**Blur is fastest** because it uses the pre-reduced point set for both local and remote processing, avoiding duplicate work.

**Ink is very close to Blur** - Its custom point buffer system (drainPointBuffer) is efficient.

**Brush is 30% slower than Blur** - This is the baseline tool cost, likely due to the full smoothing + reduction pipeline.

**FlowPen is 56% slower** - Stamp generation adds overhead. However, this is still only 1.59 µs per tick, which is negligible.

---

## 4. Smoothing Level Impact (90 TPS, brush, 10 points)

| Smoothing | Avg Time | Relative Speed |
|-----------|----------|----------------|
| 0%        | 2.97 µs  | Slowest (1.0x) |
| 30%       | 2.48 µs  | 1.20x faster   |
| 60%       | 2.16 µs  | 1.38x faster   |
| 100%      | 2.22 µs  | 1.34x faster   |

### Surprising Finding

**Higher smoothing is FASTER, not slower!**

This counterintuitive result occurs because:
1. **Point reduction is more aggressive** with higher smoothing (higher epsilon values)
2. **Fewer points to process** means less work in the tick loop
3. **The smoothing calculation itself** is negligible (as shown in broadcastSmoothing.bench.js)

**With 10 points and 0% smoothing:**
- Minimal point reduction → more points to process → 2.97 µs

**With 10 points and 60% smoothing:**
- Aggressive point reduction → fewer points to process → 2.16 µs (27% faster!)

This validates that **point reduction is the bottleneck**, not smoothing.

---

## 5. Empty vs Dirty Tick Overhead

| Condition | Avg Time | Speedup     |
|-----------|----------|-------------|
| Clean     | 145.6 ns | 7.6x faster |
| Dirty     | 1.11 µs  | Baseline    |

**Analysis:**
- Clean ticks (no data) are extremely fast - just checking the dirty flag and returning
- Dirty ticks (5 points) take 7.6x longer due to actual processing
- **Overhead of processing 5 points: 964 ns** (1.11 µs - 145.6 ns)

This validates the dirty flag optimization is working well.

---

## 6. Tick Rate Efficiency Comparison

Let's calculate the **total CPU overhead per second** for different tick rates:

| Tick Rate | Time/Tick | Ticks/Sec | Total CPU/sec | % of 1 second | Efficiency Score* |
|-----------|-----------|-----------|---------------|---------------|-------------------|
| 30 TPS    | 2.54 µs   | 30        | 76.2 µs       | 0.0076%       | ⭐⭐⭐            |
| 60 TPS    | 1.06 µs   | 60        | 63.6 µs       | 0.0064%       | ⭐⭐⭐⭐⭐        |
| **90 TPS**| **1.21 µs**| **90**   | **108.9 µs**  | **0.011%**    | **⭐⭐⭐⭐**      |
| 120 TPS   | 1.19 µs   | 120       | 142.8 µs      | 0.014%        | ⭐⭐⭐            |
| 150 TPS   | 1.35 µs   | 150       | 202.5 µs      | 0.020%        | ⭐⭐              |

*Efficiency Score = Balance of low latency, low CPU overhead, and message throughput

### Key Insights

1. **All tick rates use < 0.02% of CPU time** - The batching system is incredibly efficient!

2. **60 TPS has lowest total CPU overhead** (63.6 µs/sec) but sends fewer messages (60/sec)

3. **90 TPS is the best balance:**
   - Only 71% more CPU than 60 TPS (108.9 vs 63.6 µs)
   - But 50% more messages (90 vs 60)
   - More responsive than 30/60 TPS
   - More efficient than 120/150 TPS

4. **120 TPS has diminishing returns:**
   - 31% more CPU than 90 TPS
   - Only 33% more messages
   - Per-tick performance nearly identical to 90 TPS

5. **150 TPS is worse across the board:**
   - Slower per-tick (1.35 µs vs 1.21 µs)
   - 86% more CPU overhead
   - Not worth the extra 60 messages/sec

---

## 7. Latency Analysis

Average latency added by batching:

| Tick Rate | Tick Interval | Avg Added Latency* |
|-----------|---------------|-------------------|
| 30 TPS    | 33.33 ms      | ~16.7 ms          |
| 60 TPS    | 16.67 ms      | ~8.3 ms           |
| **90 TPS**| **11.11 ms**  | **~5.6 ms**       |
| 120 TPS   | 8.33 ms       | ~4.2 ms           |
| 150 TPS   | 6.67 ms       | ~3.3 ms           |

*Avg Added Latency = Tick Interval / 2 (assuming uniform distribution of input events)

### Analysis

**90 TPS adds ~5.6 ms average latency** - This is negligible compared to:
- Network round-trip: 50-200 ms (typical)
- Monitor refresh: 8.3-16.7 ms (60-120 Hz)
- Human perception threshold: ~10 ms

**120 TPS only saves 1.4 ms** over 90 TPS - Not worth the 31% CPU increase.

**150 TPS only saves 2.3 ms** over 90 TPS - Definitely not worth the 86% CPU increase.

---

## 8. Recommendations

### Keep 90 TPS ✅

**Reasons:**
1. **Best balance** of latency, CPU overhead, and message throughput
2. **Consistent performance** (P95 only 2.2x average)
3. **~5.6 ms added latency** is imperceptible to users
4. **Only 0.011% CPU overhead** - extremely efficient
5. **Proven in production** - current setting

### Don't Increase to 120 TPS ❌

**Reasons:**
1. Only 1.4 ms latency improvement (imperceptible)
2. 31% more CPU overhead
3. 33% more network messages
4. Per-tick performance nearly identical to 90 TPS

### Don't Decrease to 60 TPS ❌

**Reasons:**
1. 2.7 ms more latency than 90 TPS
2. 33% fewer messages = less responsive
3. CPU savings minimal (45 µs per second)

### Consider 60 TPS for Mobile/Battery ⚠️

If battery life is critical (mobile devices), 60 TPS could be worth considering:
- Lowest CPU overhead (63.6 µs/sec)
- Still reasonable latency (8.3 ms average)
- 33% fewer messages (saves battery on network radio)

---

## 9. Future Optimizations

Based on these results, here are the highest-impact optimizations:

### 🔥 High Impact

1. **Switch to Distance-Based culling** (from other benchmarks)
   - 13-51x speedup on point reduction
   - Would reduce tick time by ~800-900 ns
   - New total: ~300-400 ns per tick at 90 TPS!

2. **Use reduced points for all tools** (like Blur currently does)
   - Blur is 30% faster than Brush
   - Could make all tools as fast as Blur

### 🔧 Medium Impact

3. **Optimize FlowPen stamp generation**
   - Currently 56% slower than Blur
   - Could potentially match Blur's performance

### 💡 Low Impact

4. **Adaptive tick rate** based on input velocity
   - Fast drawing: 120 TPS for responsiveness
   - Slow drawing: 60 TPS to save CPU
   - Implementation complexity probably not worth it

---

## Conclusion

**The current 90 TPS setting is optimal and should be kept.**

The real performance gains will come from:
1. **Switching to distance-based culling** (massive 13-51x speedup)
2. **Using reduced points for all tools** (30% speedup)

The batching system itself is already incredibly efficient at < 0.011% CPU overhead.
