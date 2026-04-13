// wasm_src/src/lib.rs
use wasm_bindgen::prelude::*;

// Declare your sub-modules
pub mod pixels;
pub mod blur;
pub mod qoi;
pub mod douglas_peucker;

// Re-export the functions so wasm-bindgen can see them at the top level
pub use crate::pixels::*;
pub use crate::blur::*;
pub use crate::qoi::*;
pub use crate::douglas_peucker::*;

#[wasm_bindgen]
pub fn init_panic_hook() {
    // Better error messages in the browser console if Rust crashes
    console_error_panic_hook::set_once();
}