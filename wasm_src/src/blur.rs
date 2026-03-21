use wasm_bindgen::prelude::*;
use stackblur_iter::imgref::Img;
use stackblur_iter::blur_argb;

const MUL_TABLE: [u16; 256] = [
    512,512,456,512,328,456,335,512,405,328,271,456,388,335,292,512,
    454,405,364,328,298,271,496,456,420,388,360,335,312,292,273,512,
    482,454,428,405,383,364,345,328,312,298,284,271,259,496,475,456,
    437,420,404,388,374,360,347,335,323,312,302,292,282,273,265,512,
    497,482,468,454,441,428,417,405,394,383,373,364,354,345,337,328,
    320,312,305,298,291,284,278,271,265,259,507,496,485,475,465,456,
    446,437,428,420,412,404,396,388,381,374,367,360,354,347,341,335,
    329,323,318,312,307,302,297,292,287,282,278,273,269,265,261,512,
    505,497,489,482,475,468,461,454,447,441,435,428,422,417,411,405,
    399,394,389,383,378,373,368,364,359,354,350,345,341,337,332,328,
    324,320,316,312,309,305,301,298,294,291,287,284,281,278,274,271,
    268,265,262,259,257,507,501,496,491,485,480,475,470,465,460,456,
    451,446,442,437,433,428,424,420,416,412,408,404,400,396,392,388,
    385,381,377,374,370,367,363,360,357,354,350,347,344,341,338,335,
    332,329,326,323,320,318,315,312,310,307,304,302,299,297,294,292,
    289,287,285,282,280,278,275,273,271,269,267,265,263,261,259,0,
];

const SHG_TABLE: [u8; 256] = [
     9, 11, 12, 13, 13, 14, 14, 15, 15, 15, 15, 16, 16, 16, 16, 17,
    17, 17, 17, 17, 17, 17, 18, 18, 18, 18, 18, 18, 18, 18, 18, 19,
    19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 19, 20, 20, 20,
    20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 20, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 21,
    21, 21, 21, 21, 21, 21, 21, 21, 21, 21, 22, 22, 22, 22, 22, 22,
    22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22,
    22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 22, 23,
    23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23,
    23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23,
    23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23, 23,
    23, 23, 23, 23, 23, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,
    24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24, 24,  0,
];

#[wasm_bindgen]
pub fn stackblur_rgba(mut pixels: Vec<u8>, width: u32, height: u32, radius: u32) -> Vec<u8> {
    if radius < 1 { return pixels; }

    let w = width as usize;
    let h = height as usize;

    // We need to treat the Vec<u8> as a slice of u32 (4 bytes = 1 pixel)
    // We use a scope so the borrow of 'pixels' ends before we return it.
    {
        let pixels_u32: &mut [u32] = unsafe {
            let (prefix, mid, suffix) = pixels.align_to_mut::<u32>();
            // If the buffer isn't 4-byte aligned, we can't safely blur it this way
            if !prefix.is_empty() || !suffix.is_empty() {
                return pixels; 
            }
            mid
        };

        // Create the 2D view expected by the crate
        // 'Img' is the standard struct for a mutable image reference
        let mut img = Img::new(pixels_u32, w, h);

        // Perform the high-quality Stackblur
        blur_argb(&mut img, radius as usize);
    }

    pixels
}

#[wasm_bindgen]
pub fn apply_brush_hardness(mut pixels: Vec<u8>, width: u32, height: u32, hardness: f32) -> Vec<u8> {
    let w = width as f32;
    let h = height as f32;
    let center_x = w / 2.0;
    let center_y = h / 2.0;
    let radius = w.min(h) / 2.0;
    
    // Hardness 1.0 means sharp edges (no ramp)
    // Hardness 0.0 means the ramp starts at the very center
    let inner_radius = radius * hardness;

    for y in 0..height as usize {
        for x in 0..width as usize {
            let dx = x as f32 - center_x;
            let dy = y as f32 - center_y;
            let dist = (dx * dx + dy * dy).sqrt();

            let alpha_idx = (y * width as usize + x) * 4 + 3;

            if dist > radius {
                pixels[alpha_idx] = 0;
            } else if dist > inner_radius {
                // Smoothly taper alpha from 255 to 0 between inner and outer radius
                let factor = 1.0 - (dist - inner_radius) / (radius - inner_radius);
                pixels[alpha_idx] = (pixels[alpha_idx] as f32 * factor) as u8;
            }
            // else: dist <= inner_radius, keep original alpha (fully hard)
        }
    }
    pixels
}

/// Stackblur with an intentional vertical-pass sampling glitch.
/// Line-for-line Rust port of stackblur_rgba_glitch() in wasm/stackblur_glitch.c.
/// The glitch: during vertical blur init, `yp` stops accumulating one step early
/// (condition is `i < height_minus_1` rather than a proper clamp), producing a
/// directional smear artifact at certain radii.
#[wasm_bindgen]
pub fn stackblur_rgba_glitch(mut pixels: Vec<u8>, width: u32, height: u32, radius: u32) -> Vec<u8> {
    if radius < 1 || radius > 255 {
        return pixels;
    }

    let radius = radius as usize;
    let width = width as usize;
    let height = height as usize;
    let div = radius + radius + 1;
    let width_minus_1 = width - 1;
    let height_minus_1 = height - 1;
    let radius_plus_1 = radius + 1;
    let sum_factor = radius_plus_1 * (radius_plus_1 + 1) / 2;
    let mul_sum = MUL_TABLE[radius] as usize;
    let shg_sum = SHG_TABLE[radius] as usize;

    let mut stack_r = vec![0u8; 512];
    let mut stack_g = vec![0u8; 512];
    let mut stack_b = vec![0u8; 512];
    let mut stack_a = vec![0u8; 512];

    // Pre-multiply alpha
    for i in (0..pixels.len()).step_by(4) {
        let a = pixels[i + 3] as usize;
        if a == 0 {
            pixels[i] = 0; pixels[i+1] = 0; pixels[i+2] = 0;
        } else if a < 255 {
            pixels[i]   = ((pixels[i]   as usize * a + 127) / 255) as u8;
            pixels[i+1] = ((pixels[i+1] as usize * a + 127) / 255) as u8;
            pixels[i+2] = ((pixels[i+2] as usize * a + 127) / 255) as u8;
        }
    }

    // Horizontal pass
    let mut yw = 0usize;
    let mut yi = 0usize;
    for _y in 0..height {
        let mut r_in_sum = 0usize; let mut g_in_sum = 0usize;
        let mut b_in_sum = 0usize; let mut a_in_sum = 0usize;

        let pr = pixels[yi]; let pg = pixels[yi+1];
        let pb = pixels[yi+2]; let pa = pixels[yi+3];

        let mut r_out_sum = radius_plus_1 * pr as usize;
        let mut g_out_sum = radius_plus_1 * pg as usize;
        let mut b_out_sum = radius_plus_1 * pb as usize;
        let mut a_out_sum = radius_plus_1 * pa as usize;

        let mut r_sum = sum_factor * pr as usize;
        let mut g_sum = sum_factor * pg as usize;
        let mut b_sum = sum_factor * pb as usize;
        let mut a_sum = sum_factor * pa as usize;

        for i in 0..radius_plus_1 {
            stack_r[i] = pr; stack_g[i] = pg; stack_b[i] = pb; stack_a[i] = pa;
        }

        for i in 1..radius_plus_1 {
            let p = yi + (i.min(width_minus_1) << 2);
            let pr2 = pixels[p]; let pg2 = pixels[p+1];
            let pb2 = pixels[p+2]; let pa2 = pixels[p+3];
            let rbs = radius_plus_1 - i;
            r_sum += pr2 as usize * rbs; g_sum += pg2 as usize * rbs;
            b_sum += pb2 as usize * rbs; a_sum += pa2 as usize * rbs;
            r_in_sum += pr2 as usize; g_in_sum += pg2 as usize;
            b_in_sum += pb2 as usize; a_in_sum += pa2 as usize;
            stack_r[i+radius] = pr2; stack_g[i+radius] = pg2;
            stack_b[i+radius] = pb2; stack_a[i+radius] = pa2;
        }

        let mut si_in = 0usize;
        let mut si_out = radius;

        for x in 0..width {
            let pa_out = ((a_sum * mul_sum) >> shg_sum) as u8;
            pixels[yi+3] = pa_out;
            if pa_out != 0 {
                pixels[yi]   = ((r_sum * mul_sum) >> shg_sum) as u8;
                pixels[yi+1] = ((g_sum * mul_sum) >> shg_sum) as u8;
                pixels[yi+2] = ((b_sum * mul_sum) >> shg_sum) as u8;
            } else {
                pixels[yi] = 0; pixels[yi+1] = 0; pixels[yi+2] = 0;
            }

            r_sum -= r_out_sum; g_sum -= g_out_sum;
            b_sum -= b_out_sum; a_sum -= a_out_sum;
            r_out_sum -= stack_r[si_in] as usize; g_out_sum -= stack_g[si_in] as usize;
            b_out_sum -= stack_b[si_in] as usize; a_out_sum -= stack_a[si_in] as usize;

            let px = if x + radius + 1 > width_minus_1 { width_minus_1 } else { x + radius + 1 };
            let p = (yw + px) << 2;
            let pr2 = pixels[p]; let pg2 = pixels[p+1];
            let pb2 = pixels[p+2]; let pa2 = pixels[p+3];

            stack_r[si_in] = pr2; stack_g[si_in] = pg2;
            stack_b[si_in] = pb2; stack_a[si_in] = pa2;
            r_in_sum += pr2 as usize; g_in_sum += pg2 as usize;
            b_in_sum += pb2 as usize; a_in_sum += pa2 as usize;
            r_sum += r_in_sum; g_sum += g_in_sum;
            b_sum += b_in_sum; a_sum += a_in_sum;

            si_in = (si_in + 1) % div;

            let pr3 = stack_r[si_out]; let pg3 = stack_g[si_out];
            let pb3 = stack_b[si_out]; let pa3 = stack_a[si_out];
            r_out_sum += pr3 as usize; g_out_sum += pg3 as usize;
            b_out_sum += pb3 as usize; a_out_sum += pa3 as usize;
            r_in_sum -= pr3 as usize; g_in_sum -= pg3 as usize;
            b_in_sum -= pb3 as usize; a_in_sum -= pa3 as usize;

            si_out = (si_out + 1) % div;
            yi += 4;
        }
        yw += width;
    }

    // Vertical pass
    for x in 0..width {
        let mut r_in_sum = 0usize; let mut g_in_sum = 0usize;
        let mut b_in_sum = 0usize; let mut a_in_sum = 0usize;

        let yi0 = x << 2;
        let pr = pixels[yi0]; let pg = pixels[yi0+1];
        let pb = pixels[yi0+2]; let pa = pixels[yi0+3];

        let mut r_out_sum = radius_plus_1 * pr as usize;
        let mut g_out_sum = radius_plus_1 * pg as usize;
        let mut b_out_sum = radius_plus_1 * pb as usize;
        let mut a_out_sum = radius_plus_1 * pa as usize;

        let mut r_sum = sum_factor * pr as usize;
        let mut g_sum = sum_factor * pg as usize;
        let mut b_sum = sum_factor * pb as usize;
        let mut a_sum = sum_factor * pa as usize;

        for i in 0..radius_plus_1 {
            stack_r[i] = pr; stack_g[i] = pg; stack_b[i] = pb; stack_a[i] = pa;
        }

        // GLITCH: yp only advances when i < height_minus_1 (off-by-one vs. correct clamping)
        let mut yp = width;
        for i in 1..=radius {
            let yi2 = (yp + x) << 2;
            let pr2 = pixels[yi2]; let pg2 = pixels[yi2+1];
            let pb2 = pixels[yi2+2]; let pa2 = pixels[yi2+3];
            let rbs = radius_plus_1 - i;
            r_sum += pr2 as usize * rbs; g_sum += pg2 as usize * rbs;
            b_sum += pb2 as usize * rbs; a_sum += pa2 as usize * rbs;
            r_in_sum += pr2 as usize; g_in_sum += pg2 as usize;
            b_in_sum += pb2 as usize; a_in_sum += pa2 as usize;
            stack_r[i+radius] = pr2; stack_g[i+radius] = pg2;
            stack_b[i+radius] = pb2; stack_a[i+radius] = pa2;
            if i < height_minus_1 {
                yp += width;
            }
        }

        let mut yi_col = x;
        let mut si_in = 0usize;
        let mut si_out = radius;

        for y in 0..height {
            let p = yi_col << 2;
            let pa_out = ((a_sum * mul_sum) >> shg_sum) as u8;
            pixels[p+3] = pa_out;
            if pa_out > 0 {
                pixels[p]   = ((r_sum * mul_sum) >> shg_sum) as u8;
                pixels[p+1] = ((g_sum * mul_sum) >> shg_sum) as u8;
                pixels[p+2] = ((b_sum * mul_sum) >> shg_sum) as u8;
            } else {
                pixels[p] = 0; pixels[p+1] = 0; pixels[p+2] = 0;
            }

            r_sum -= r_out_sum; g_sum -= g_out_sum;
            b_sum -= b_out_sum; a_sum -= a_out_sum;
            r_out_sum -= stack_r[si_in] as usize; g_out_sum -= stack_g[si_in] as usize;
            b_out_sum -= stack_b[si_in] as usize; a_out_sum -= stack_a[si_in] as usize;

            let p2 = if y + radius_plus_1 > height_minus_1 { height_minus_1 } else { y + radius_plus_1 };
            let p2 = (x + p2 * width) << 2;
            let pr2 = pixels[p2]; let pg2 = pixels[p2+1];
            let pb2 = pixels[p2+2]; let pa2 = pixels[p2+3];

            stack_r[si_in] = pr2; stack_g[si_in] = pg2;
            stack_b[si_in] = pb2; stack_a[si_in] = pa2;
            r_in_sum += pr2 as usize; g_in_sum += pg2 as usize;
            b_in_sum += pb2 as usize; a_in_sum += pa2 as usize;
            r_sum += r_in_sum; g_sum += g_in_sum;
            b_sum += b_in_sum; a_sum += a_in_sum;

            si_in = (si_in + 1) % div;

            let pr3 = stack_r[si_out]; let pg3 = stack_g[si_out];
            let pb3 = stack_b[si_out]; let pa3 = stack_a[si_out];
            r_out_sum += pr3 as usize; g_out_sum += pg3 as usize;
            b_out_sum += pb3 as usize; a_out_sum += pa3 as usize;
            r_in_sum -= pr3 as usize; g_in_sum -= pg3 as usize;
            b_in_sum -= pb3 as usize; a_in_sum -= pa3 as usize;

            si_out = (si_out + 1) % div;
            yi_col += width;
        }
    }

    // Un-pre-multiply alpha
    for i in (0..pixels.len()).step_by(4) {
        let a = pixels[i+3] as usize;
        if a > 0 && a < 255 {
            let v = (pixels[i]   as usize * 255 + (a >> 1)) / a;
            pixels[i]   = if v > 255 { 255 } else { v as u8 };
            let v = (pixels[i+1] as usize * 255 + (a >> 1)) / a;
            pixels[i+1] = if v > 255 { 255 } else { v as u8 };
            let v = (pixels[i+2] as usize * 255 + (a >> 1)) / a;
            pixels[i+2] = if v > 255 { 255 } else { v as u8 };
        }
    }

    pixels
}