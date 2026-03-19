#!/bin/bash
# Build WASM pixel scanning module using Emscripten
# Requires: emcc (Emscripten) in PATH
#
# Produces:
#   public/wasm/pixels.wasm  - standalone WASM binary
#   public/wasm/pixels.js    - JS glue (loader)

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
OUT_DIR="$PROJECT_DIR/public/wasm"

mkdir -p "$OUT_DIR"

echo "Building standard WASM..."
emcc "$SCRIPT_DIR/pixels.c" \
  -O3 \
  -s WASM=1 \
  -s EXPORTED_FUNCTIONS="['_has_content','_find_content_bounds','_mark_dirty_tiles','_malloc','_free']" \
  -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','HEAPU8','HEAP32']" \
  -s ALLOW_MEMORY_GROWTH=1 \
  -s INITIAL_MEMORY=1048576 \
  -s ENVIRONMENT='worker' \
  -s MODULARIZE=1 \
  -s EXPORT_NAME='createPixelsModule' \
  -s FILESYSTEM=0 \
  -s SINGLE_FILE=0 \
  -o "$OUT_DIR/pixels.js"

echo "Standard WASM built: $OUT_DIR/pixels.js + pixels.wasm"

# Tier 1: SIMD build (optional, skip if emcc doesn't support -msimd128)
if emcc --check 2>&1 | grep -q "simd128" || true; then
  echo "Building SIMD WASM..."
  emcc "$SCRIPT_DIR/pixels.c" \
    -O3 \
    -msimd128 \
    -s WASM=1 \
    -s EXPORTED_FUNCTIONS="['_has_content','_find_content_bounds','_mark_dirty_tiles','_malloc','_free']" \
    -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap','HEAPU8','HEAP32']" \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=1048576 \
    -s ENVIRONMENT='worker' \
    -s MODULARIZE=1 \
    -s EXPORT_NAME='createPixelsModule' \
    -s FILESYSTEM=0 \
    -s SINGLE_FILE=0 \
    -o "$OUT_DIR/pixels-simd.js" 2>/dev/null && \
    echo "SIMD WASM built: $OUT_DIR/pixels-simd.js + pixels-simd.wasm" || \
    echo "SIMD build skipped (not supported by this emcc version)"
fi

echo "Done."
