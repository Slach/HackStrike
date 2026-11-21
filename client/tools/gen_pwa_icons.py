#!/usr/bin/env python3
"""Генератор PWA-иконок HACKSTRIKE (ГДД §15.37).

Чистый stdlib: пишем PNG вручную (zlib), без Pillow — чтобы иконки можно
было воспроизвести одной командой без node/python-зависимостей. Блочный
зелёный «H» на тёмном фоне, палитра — из index.html (:root): --cy #37ff9b,
фон #020e08 (панель, сплющенная в solid).

Использование: python3 gen_pwa_icons.py [выходной-каталог]
Пишет icon-192.png, icon-512.png, apple-touch-icon.png (180).
"""

import struct
import sys
import zlib
from pathlib import Path

# 24-клеточная сетка: блочный H целиком в maskable-safe зоне (центр 80%).
GRID = 24
H_CELLS = []  # (x, y) — клетки буквы H
for y in range(5, 19):          # левая и правая стойки
    H_CELLS += [(5, y), (6, y), (15, y), (16, y), (17, y), (18, y)]
for x in range(5, 19):          # перекладина
    H_CELLS += [(x, 10), (x, 11), (x, 12), (x, 13)]

BG = (2, 14, 8)      # --panel rgba(2,14,8,.88) → solid
FG = (55, 255, 155)  # --cy


def render(size: int) -> bytes:
    """PNG-байты иконки `size`×`size`: фон + блочный H."""
    cell = size // GRID
    pad = (size - cell * GRID) // 2  # симметричный остаток по краям
    px = bytearray()
    for row in range(size):
        px.append(0)  # filter: none
        gy = (row - pad) // cell if row >= pad else -1
        for col in range(size):
            gx = (col - pad) // cell if col >= pad else -1
            px += bytes(FG if (gx, gy) in H_CELLS else BG)
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    chunk = lambda tag, data: struct.pack(">I", len(data)) + tag + data + \
        struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(px), 9))
            + chunk(b"IEND", b""))


def main() -> None:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "public" / "pwa")
    out.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon-192.png", 192), ("icon-512.png", 512), ("apple-touch-icon.png", 180)):
        (out / name).write_bytes(render(size))
        print(f"{out / name}  {size}x{size}")


if __name__ == "__main__":
    main()
