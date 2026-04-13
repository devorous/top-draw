use wasm_bindgen::prelude::*;

/**
 * Douglas-Peucker point reduction algorithm (Rust/WASM)
 * 
 * Takes a flattened slice of f32 coordinates [x, y, p, x, y, p...]
 * and returns a new flattened slice with fewer points while preserving shape.
 */
#[wasm_bindgen]
pub fn douglas_peucker_wasm(points: &[f32], epsilon: f32) -> Vec<f32> {
    let len = points.len();
    if len < 6 {
        return points.to_vec();
    }

    let mut kept = vec![false; len / 3];
    kept[0] = true;
    kept[len / 3 - 1] = true;

    simplify_step(points, 0, len / 3 - 1, epsilon, &mut kept);

    let mut result = Vec::with_capacity(len);
    for i in 0..len / 3 {
        if kept[i] {
            result.push(points[i * 3]);
            result.push(points[i * 3 + 1]);
            result.push(points[i * 3 + 2]);
        }
    }
    result
}

fn simplify_step(points: &[f32], start: usize, end: usize, epsilon: f32, kept: &mut [bool]) {
    if end <= start + 1 {
        return;
    }

    let mut max_dist = 0.0;
    let mut max_idx = 0;

    let x1 = points[start * 3];
    let y1 = points[start * 3 + 1];
    let x2 = points[end * 3];
    let y2 = points[end * 3 + 1];

    let dx = x2 - x1;
    let dy = y2 - y1;
    let mag_sq = dx * dx + dy * dy;

    for i in start + 1..end {
        let x = points[i * 3];
        let y = points[i * 3 + 1];

        let dist = if mag_sq == 0.0 {
            let d_dx = x - x1;
            let d_dy = y - y1;
            (d_dx * d_dx + d_dy * d_dy).sqrt()
        } else {
            let t = ((x - x1) * dx + (y - y1) * dy) / mag_sq;
            let t_clamped = t.max(0.0).min(1.0);
            let proj_x = x1 + t_clamped * dx;
            let proj_y = y1 + t_clamped * dy;
            let d_dx = x - proj_x;
            let d_dy = y - proj_y;
            (d_dx * d_dx + d_dy * d_dy).sqrt()
        };

        if dist > max_dist {
            max_dist = dist;
            max_idx = i;
        }
    }

    if max_dist > epsilon {
        kept[max_idx] = true;
        simplify_step(points, start, max_idx, epsilon, kept);
        simplify_step(points, max_idx, end, epsilon, kept);
    }
}
