/* tslint:disable */
/* eslint-disable */

export function apply_brush_hardness(pixels: Uint8Array, width: number, height: number, hardness: number): Uint8Array;

export function find_content_bounds(data: Uint8Array, width: number, height: number): Int32Array;

export function has_content(data: Uint8Array): boolean;

export function init_panic_hook(): void;

export function qoi_decode(encoded: Uint8Array): Uint8Array;

export function qoi_decode_tile(encoded: Uint8Array): Uint8Array;

export function qoi_encode(data: Uint8Array, width: number, height: number): Uint8Array;

export function qoi_encode_tile(data: Uint8Array): Uint8Array;

/**
 * A specialized content check for QOI-encoded buffers.
 * Returns true if the tile contains ANY pixel with Alpha > 0.
 */
export function qoi_has_content(encoded: Uint8Array): boolean;

export function stackblur_rgba(pixels: Uint8Array, width: number, height: number, radius: number): Uint8Array;

/**
 * Stackblur with an intentional vertical-pass sampling glitch.
 * Line-for-line Rust port of stackblur_rgba_glitch() in wasm/stackblur_glitch.c.
 * The glitch: during vertical blur init, `yp` stops accumulating one step early
 * (condition is `i < height_minus_1` rather than a proper clamp), producing a
 * directional smear artifact at certain radii.
 */
export function stackblur_rgba_glitch(pixels: Uint8Array, width: number, height: number, radius: number): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly qoi_decode: (a: number, b: number) => [number, number];
    readonly qoi_decode_tile: (a: number, b: number) => [number, number];
    readonly qoi_encode: (a: number, b: number, c: number, d: number) => [number, number];
    readonly qoi_encode_tile: (a: number, b: number) => [number, number];
    readonly qoi_has_content: (a: number, b: number) => number;
    readonly apply_brush_hardness: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly stackblur_rgba: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly stackblur_rgba_glitch: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly find_content_bounds: (a: number, b: number, c: number, d: number) => [number, number];
    readonly has_content: (a: number, b: number) => number;
    readonly init_panic_hook: () => void;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
