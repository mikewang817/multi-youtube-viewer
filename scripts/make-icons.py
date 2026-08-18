#!/usr/bin/env python3
"""生成扩展图标：深色圆角背景 + 3x3 红色网格，中心格为白色播放三角。
纯标准库实现（zlib 手写 PNG），无第三方依赖。"""

import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'extension', 'icons')

BG = (24, 24, 24, 255)
CELL = (255, 59, 48, 255)      # YouTube 风格红
PLAY = (255, 255, 255, 255)
TRANSPARENT = (0, 0, 0, 0)


def png_chunk(tag, data):
    chunk = tag + data
    return struct.pack('>I', len(data)) + chunk + struct.pack('>I', zlib.crc32(chunk))


def write_png(path, size, pixels):
    raw = b''.join(
        b'\x00' + b''.join(bytes(pixels[y][x]) for x in range(size))
        for y in range(size)
    )
    png = (
        b'\x89PNG\r\n\x1a\n'
        + png_chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
        + png_chunk(b'IDAT', zlib.compress(raw, 9))
        + png_chunk(b'IEND', b'')
    )
    with open(path, 'wb') as f:
        f.write(png)


def make_icon(size):
    px = [[TRANSPARENT for _ in range(size)] for _ in range(size)]
    radius = max(2, size // 8)

    # 圆角深色背景
    for y in range(size):
        for x in range(size):
            inside = True
            for cx, cy in ((radius, radius), (size - 1 - radius, radius),
                           (radius, size - 1 - radius), (size - 1 - radius, size - 1 - radius)):
                if ((x < radius and y < radius and (cx, cy) == (radius, radius)) or
                        (x >= size - radius and y < radius and cx == size - 1 - radius and cy == radius) or
                        (x < radius and y >= size - radius and cx == radius and cy == size - 1 - radius) or
                        (x >= size - radius and y >= size - radius and cx == size - 1 - radius and cy == size - 1 - radius)):
                    if (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2:
                        inside = False
            if inside:
                px[y][x] = BG

    # 3x3 网格
    margin = max(1, round(size * 0.12))
    gap = max(1, round(size * 0.05))
    span = size - 2 * margin
    cell = (span - 2 * gap) / 3.0
    for gy in range(3):
        for gx in range(3):
            x0 = margin + gx * (cell + gap)
            y0 = margin + gy * (cell + gap)
            for y in range(round(y0), round(y0 + cell)):
                for x in range(round(x0), round(x0 + cell)):
                    if 0 <= x < size and 0 <= y < size:
                        px[y][x] = CELL
            # 中心格画白色播放三角
            if gx == 1 and gy == 1:
                tx0, ty0 = x0 + cell * 0.30, y0 + cell * 0.18
                th = cell * 0.64
                tw = cell * 0.52
                for y in range(round(ty0), round(ty0 + th)):
                    frac = 1.0 - abs((y - ty0) / th * 2.0 - 1.0)   # 0..1..0
                    w = tw * frac
                    for x in range(round(tx0), round(tx0 + w) + 1):
                        if 0 <= x < size and 0 <= y < size:
                            px[y][x] = PLAY
    return px


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_DIR, f'icon{size}.png')
        write_png(path, size, make_icon(size))
        print(f'wrote {path}')


if __name__ == '__main__':
    main()
