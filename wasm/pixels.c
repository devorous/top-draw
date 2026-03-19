/**
 * pixels.c - WASM module for pixel scanning operations
 *
 * Compile with Emscripten:
 *   emcc wasm/pixels.c -O3 -s WASM=1 -s EXPORTED_FUNCTIONS="['_has_content','_find_content_bounds','_mark_dirty_tiles','_malloc','_free']" -s EXPORTED_RUNTIME_METHODS="['ccall','cwrap']" -s ALLOW_MEMORY_GROWTH=1 -s STANDALONE_WASM=0 -s ENVIRONMENT='worker' -o public/pixels.js
 *
 * For SIMD build (Tier 1):
 *   emcc wasm/pixels.c -O3 -msimd128 -s WASM=1 ... -o public/pixels-simd.js
 */

#include <stdint.h>
#include <stdlib.h>

/**
 * Scan RGBA pixel data for any non-transparent pixel.
 * @param data   Pointer to RGBA pixel buffer
 * @param length Total byte length of the buffer (width * height * 4)
 * @return 1 if any alpha > 0, 0 if fully transparent
 */
int has_content(const uint8_t* data, int length) {
    // Process 16 bytes (4 pixels) at a time
    int i = 3;
    int end16 = length - 15;

    while (i < end16) {
        if (data[i] | data[i + 4] | data[i + 8] | data[i + 12]) {
            return 1;
        }
        i += 16;
    }

    // Handle remaining pixels
    while (i < length) {
        if (data[i]) return 1;
        i += 4;
    }

    return 0;
}

/**
 * Find the tight bounding box of non-transparent pixels.
 * Writes result into output[0..3] = {x, y, width, height}.
 * If no content found, writes {-1, -1, 0, 0}.
 *
 * @param data   Pointer to RGBA pixel buffer
 * @param width  Image width in pixels
 * @param height Image height in pixels
 * @param output Pointer to int[4] for the result
 */
void find_content_bounds(const uint8_t* data, int width, int height, int* output) {
    int minX = width;
    int minY = height;
    int maxX = -1;
    int maxY = -1;

    // Scan top-to-bottom to find minY
    for (int y = 0; y < height && minY == height; y++) {
        const uint8_t* row = data + y * width * 4;
        for (int x = 0; x < width; x++) {
            if (row[x * 4 + 3] > 0) {
                minY = y;
                break;
            }
        }
    }

    if (minY == height) {
        // No content at all
        output[0] = -1;
        output[1] = -1;
        output[2] = 0;
        output[3] = 0;
        return;
    }

    // Scan bottom-to-top to find maxY
    for (int y = height - 1; y >= minY; y--) {
        const uint8_t* row = data + y * width * 4;
        for (int x = 0; x < width; x++) {
            if (row[x * 4 + 3] > 0) {
                maxY = y;
                break;
            }
        }
        if (maxY >= 0) break;
    }

    // Scan only the rows with content for minX / maxX
    for (int y = minY; y <= maxY; y++) {
        const uint8_t* row = data + y * width * 4;

        // Left edge
        for (int x = 0; x < minX; x++) {
            if (row[x * 4 + 3] > 0) {
                minX = x;
                break;
            }
        }

        // Right edge
        for (int x = width - 1; x > maxX; x--) {
            if (row[x * 4 + 3] > 0) {
                maxX = x;
                break;
            }
        }

        // Early exit if we've reached the canvas edges
        if (minX == 0 && maxX == width - 1) break;
    }

    output[0] = minX;
    output[1] = minY;
    output[2] = maxX - minX + 1;
    output[3] = maxY - minY + 1;
}

/**
 * Mark tiles overlapping a pixel-space rectangle as dirty.
 *
 * @param tiles    Pointer to tile flags (Uint8Array, cols*rows)
 * @param cols     Number of tile columns
 * @param rows     Number of tile rows
 * @param x        Left edge (pixels)
 * @param y        Top edge (pixels)
 * @param w        Width (pixels)
 * @param h        Height (pixels)
 * @param tileSize Tile size in pixels (32)
 */
void mark_dirty_tiles(uint8_t* tiles, int cols, int rows,
                      int x, int y, int w, int h, int tileSize) {
    if (w <= 0 || h <= 0) return;

    int startCol = x / tileSize;
    int startRow = y / tileSize;
    int endCol   = (x + w - 1) / tileSize;
    int endRow   = (y + h - 1) / tileSize;

    if (startCol < 0) startCol = 0;
    if (startRow < 0) startRow = 0;
    if (endCol >= cols) endCol = cols - 1;
    if (endRow >= rows) endRow = rows - 1;

    for (int r = startRow; r <= endRow; r++) {
        int offset = r * cols;
        for (int c = startCol; c <= endCol; c++) {
            tiles[offset + c] = 1;
        }
    }
}
