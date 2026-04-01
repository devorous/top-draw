use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn qoi_encode_tile(data: &[u8]) -> Vec<u8> {
    if data.len() != 4096 { // 32 * 32 * 4
        return Vec::new();
    }

    // qoi::encode_to_vec expects raw RGBA pixels and dimensions
    match qoi::encode_to_vec(data, 32, 32) {
        Ok(v) => v,
        Err(_) => Vec::new(),
    }
}

#[wasm_bindgen]
pub fn qoi_decode_tile(encoded: &[u8]) -> Vec<u8> {
    match qoi::decode_to_vec(encoded) {
        Ok((_header, pixels)) => pixels,
        Err(_) => Vec::new(),
    }
}

/// A specialized content check for QOI-encoded buffers.
/// Returns true if the tile contains ANY pixel with Alpha > 0.
#[wasm_bindgen]
pub fn qoi_has_content(encoded: &[u8]) -> bool {
    if let Ok((_header, pixels)) = qoi::decode_to_vec(encoded) {
        // Process alpha channel (every 4th byte)
        for i in (3..pixels.len()).step_by(4) {
            if pixels[i] > 0 {
                return true;
            }
        }
    }
    false
}
