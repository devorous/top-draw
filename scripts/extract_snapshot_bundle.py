#!/usr/bin/env python3
"""Extract images from a Top Draw snapshot .bundle file.

The .bundle format is a tiny protobuf message:
  message SnapshotBundle {
    repeated bytes layers = 1;  // QOI encoded layers
    bytes thumbnail = 2;        // JPEG encoded thumbnail
  }

This script intentionally uses only the Python standard library so it can run
quickly without installing protobuf/Pillow.
"""

from __future__ import annotations

import argparse
import pathlib
import struct
import sys
import zlib


QOI_MAGIC = b"qoif"
QOI_OP_INDEX = 0x00
QOI_OP_DIFF = 0x40
QOI_OP_LUMA = 0x80
QOI_OP_RUN = 0xC0
QOI_OP_RGB = 0xFE
QOI_OP_RGBA = 0xFF
QOI_MASK_2 = 0xC0
QOI_END_MARKER = b"\x00\x00\x00\x00\x00\x00\x00\x01"


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Extract PNG layers and thumbnail from a snapshot .bundle file."
    )
    parser.add_argument("bundle", help="Path to the .bundle file")
    parser.add_argument(
        "-o",
        "--out",
        help="Output directory (defaults to <bundle-name>_extracted)",
    )
    parser.add_argument(
        "--no-composite",
        action="store_true",
        help="Skip writing the flattened composite PNG",
    )
    return parser.parse_args()


def read_varint(data: bytes, offset: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while True:
        if offset >= len(data):
            raise ValueError("Unexpected end of file while reading varint")
        byte = data[offset]
        offset += 1
        value |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            return value, offset
        shift += 7
        if shift > 63:
            raise ValueError("Varint is too large")


def parse_snapshot_bundle(data: bytes) -> tuple[list[bytes], bytes | None]:
    layers: list[bytes] = []
    thumbnail: bytes | None = None
    offset = 0

    while offset < len(data):
        key, offset = read_varint(data, offset)
        field_number = key >> 3
        wire_type = key & 0x07

        if wire_type != 2:
            raise ValueError(f"Unsupported wire type {wire_type} in SnapshotBundle")

        length, offset = read_varint(data, offset)
        end = offset + length
        if end > len(data):
            raise ValueError("Invalid length-delimited field in SnapshotBundle")
        payload = data[offset:end]
        offset = end

        if field_number == 1:
            layers.append(payload)
        elif field_number == 2:
            thumbnail = payload

    return layers, thumbnail


def qoi_color_hash(px: tuple[int, int, int, int]) -> int:
    r, g, b, a = px
    return (r * 3 + g * 5 + b * 7 + a * 11) % 64


def qoi_decode(encoded: bytes) -> tuple[int, int, bytes]:
    if len(encoded) < 14 + len(QOI_END_MARKER):
        raise ValueError("QOI buffer is too short")
    if encoded[:4] != QOI_MAGIC:
        raise ValueError("Invalid QOI magic")

    width = struct.unpack(">I", encoded[4:8])[0]
    height = struct.unpack(">I", encoded[8:12])[0]
    channels = encoded[12]
    if channels not in (3, 4):
        raise ValueError(f"Unsupported QOI channel count: {channels}")

    pixel_count = width * height
    index: list[tuple[int, int, int, int]] = [(0, 0, 0, 0)] * 64
    px = (0, 0, 0, 255)
    out = bytearray(pixel_count * 4)

    src = 14
    dst = 0
    written = 0

    while written < pixel_count:
        if src >= len(encoded):
            raise ValueError("Unexpected end of QOI data")

        byte = encoded[src]
        src += 1

        if byte == QOI_OP_RGB:
            if src + 3 > len(encoded):
                raise ValueError("Truncated QOI_OP_RGB payload")
            px = (encoded[src], encoded[src + 1], encoded[src + 2], px[3])
            src += 3
        elif byte == QOI_OP_RGBA:
            if src + 4 > len(encoded):
                raise ValueError("Truncated QOI_OP_RGBA payload")
            px = (encoded[src], encoded[src + 1], encoded[src + 2], encoded[src + 3])
            src += 4
        else:
            tag = byte & QOI_MASK_2
            if tag == QOI_OP_INDEX:
                px = index[byte & 0x3F]
            elif tag == QOI_OP_DIFF:
                dr = ((byte >> 4) & 0x03) - 2
                dg = ((byte >> 2) & 0x03) - 2
                db = (byte & 0x03) - 2
                px = (
                    (px[0] + dr) & 0xFF,
                    (px[1] + dg) & 0xFF,
                    (px[2] + db) & 0xFF,
                    px[3],
                )
            elif tag == QOI_OP_LUMA:
                if src >= len(encoded):
                    raise ValueError("Truncated QOI_OP_LUMA payload")
                byte2 = encoded[src]
                src += 1
                dg = (byte & 0x3F) - 32
                dr_dg = ((byte2 >> 4) & 0x0F) - 8
                db_dg = (byte2 & 0x0F) - 8
                px = (
                    (px[0] + dg + dr_dg) & 0xFF,
                    (px[1] + dg) & 0xFF,
                    (px[2] + dg + db_dg) & 0xFF,
                    px[3],
                )
            elif tag == QOI_OP_RUN:
                run = (byte & 0x3F) + 1
                for _ in range(run):
                    if written >= pixel_count:
                        raise ValueError("QOI run exceeds expected pixel count")
                    out[dst:dst + 4] = bytes(px)
                    dst += 4
                    written += 1
                index[qoi_color_hash(px)] = px
                continue
            else:
                raise ValueError("Unsupported QOI opcode")

        out[dst:dst + 4] = bytes(px)
        dst += 4
        written += 1
        index[qoi_color_hash(px)] = px

    return width, height, bytes(out)


def png_chunk(chunk_type: bytes, payload: bytes) -> bytes:
    crc = zlib.crc32(chunk_type)
    crc = zlib.crc32(payload, crc)
    return (
        struct.pack(">I", len(payload))
        + chunk_type
        + payload
        + struct.pack(">I", crc & 0xFFFFFFFF)
    )


def write_png(path: pathlib.Path, width: int, height: int, rgba: bytes) -> None:
    if len(rgba) != width * height * 4:
        raise ValueError("RGBA payload length does not match image dimensions")

    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)
        start = y * stride
        raw.extend(rgba[start:start + stride])

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    compressed = zlib.compress(bytes(raw), level=9)

    png = bytearray(b"\x89PNG\r\n\x1a\n")
    png.extend(png_chunk(b"IHDR", ihdr))
    png.extend(png_chunk(b"IDAT", compressed))
    png.extend(png_chunk(b"IEND", b""))
    path.write_bytes(png)


def composite_rgba(base: bytearray, layer: bytes) -> None:
    for i in range(0, len(base), 4):
        sr = layer[i]
        sg = layer[i + 1]
        sb = layer[i + 2]
        sa = layer[i + 3]
        if sa == 0:
            continue

        dr = base[i]
        dg = base[i + 1]
        db = base[i + 2]
        da = base[i + 3]

        src_a = sa / 255.0
        dst_a = da / 255.0
        out_a = src_a + dst_a * (1.0 - src_a)

        if out_a <= 0:
            base[i:i + 4] = b"\x00\x00\x00\x00"
            continue

        out_r = int(round((sr * src_a + dr * dst_a * (1.0 - src_a)) / out_a))
        out_g = int(round((sg * src_a + dg * dst_a * (1.0 - src_a)) / out_a))
        out_b = int(round((sb * src_a + db * dst_a * (1.0 - src_a)) / out_a))
        out_alpha = int(round(out_a * 255.0))

        base[i] = max(0, min(255, out_r))
        base[i + 1] = max(0, min(255, out_g))
        base[i + 2] = max(0, min(255, out_b))
        base[i + 3] = max(0, min(255, out_alpha))


def ensure_output_dir(bundle_path: pathlib.Path, out_arg: str | None) -> pathlib.Path:
    if out_arg:
        out_dir = pathlib.Path(out_arg)
    else:
        out_dir = bundle_path.with_suffix("")
        out_dir = out_dir.parent / f"{out_dir.name}_extracted"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def main() -> int:
    args = parse_args()
    bundle_path = pathlib.Path(args.bundle)
    if not bundle_path.is_file():
        print(f"Bundle file not found: {bundle_path}", file=sys.stderr)
        return 1

    try:
        bundle_data = bundle_path.read_bytes()
        layers, thumbnail = parse_snapshot_bundle(bundle_data)
    except Exception as exc:
        print(f"Failed to read bundle: {exc}", file=sys.stderr)
        return 1

    out_dir = ensure_output_dir(bundle_path, args.out)

    if thumbnail:
        (out_dir / "thumbnail.jpg").write_bytes(thumbnail)

    if not layers:
        print(f"No layers found. Output written to: {out_dir}")
        return 0

    decoded_layers: list[tuple[int, int, bytes]] = []
    for index, layer_data in enumerate(layers):
        try:
            width, height, rgba = qoi_decode(layer_data)
        except Exception as exc:
            print(f"Failed to decode layer {index}: {exc}", file=sys.stderr)
            return 1

        write_png(out_dir / f"layer_{index:02d}.png", width, height, rgba)
        decoded_layers.append((width, height, rgba))

    if not args.no_composite:
        width, height, _ = decoded_layers[0]
        composite = bytearray(width * height * 4)
        for layer_width, layer_height, rgba in decoded_layers:
            if layer_width != width or layer_height != height:
                print("Layer dimensions do not match; skipping composite", file=sys.stderr)
                break
            composite_rgba(composite, rgba)
        else:
            write_png(out_dir / "composite.png", width, height, bytes(composite))

    print(f"Extracted {len(decoded_layers)} layer(s) to: {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
