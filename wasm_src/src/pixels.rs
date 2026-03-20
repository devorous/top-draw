use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn has_content(data: &[u8]) -> bool {
    // Process alpha channel (every 4th byte)
    for i in (3..data.len()).step_by(4) {
        if data[i] > 0 {
            return true;
        }
    }
    false
}

#[wasm_bindgen]
pub fn find_content_bounds(data: &[u8], width: u32, height: u32) -> Vec<i32> {
    let (mut min_x, mut min_y) = (width as i32, height as i32);
    let (mut max_x, mut max_y) = (-1, -1);
    let w = width as usize;

    for y in 0..height as usize {
        for x in 0..w {
            if data[(y * w + x) * 4 + 3] > 0 {
                let xi = x as i32;
                let yi = y as i32;
                if xi < min_x { min_x = xi; }
                if xi > max_x { max_x = xi; }
                if yi < min_y { min_y = yi; }
                if yi > max_y { max_y = yi; }
            }
        }
    }

    if max_x == -1 { vec![-1, -1, 0, 0] } 
    else { vec![min_x, min_y, max_x - min_x + 1, max_y - min_y + 1] }
}