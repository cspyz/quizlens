# -*- coding: utf-8 -*-
"""
生成扩展图标 icons/icon{16,48,128}.png（纯标准库，不依赖 Pillow）。
图案：蓝紫渐变圆角方块 + 白色摊开的书本（中间留书脊缝）。
4 倍超采样后降采样，边缘自带抗锯齿。
用法：python tools/make_icons.py
"""
import os, struct, zlib, sys

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extension", "icons")
SS = 4  # 超采样倍数

TOP = (37, 99, 235)     # #2563eb
BOTTOM = (79, 70, 229)  # #4f46e5
WHITE = (255, 255, 255)
BG_RADIUS = 0.22        # 圆角半径（相对边长）
BOOK = (0.20, 0.26, 0.80, 0.74)   # 书本外框 x0,y0,x1,y1
BOOK_RADIUS = 0.055
SPINE = 0.028           # 书脊半宽


def inside_round_rect(x, y, x0, y0, x1, y1, r):
    if not (x0 <= x <= x1 and y0 <= y <= y1):
        return False
    cx = min(max(x, x0 + r), x1 - r)
    cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r


def pixel(fx, fy):
    """返回该采样点的 RGBA（0~255），坐标为 0~1 归一化"""
    if not inside_round_rect(fx, fy, 0.0, 0.0, 1.0, 1.0, BG_RADIUS):
        return (0, 0, 0, 0)
    r, g, b = [int(TOP[i] + (BOTTOM[i] - TOP[i]) * fy) for i in range(3)]
    bx0, by0, bx1, by1 = BOOK
    if inside_round_rect(fx, fy, bx0, by0, bx1, by1, BOOK_RADIUS) and abs(fx - 0.5) > SPINE:
        return (WHITE[0], WHITE[1], WHITE[2], 255)
    return (r, g, b, 255)


def render(size):
    n = size * SS
    buf = bytearray(n * n * 4)
    acc = None
    for py in range(size):
        for px in range(size):
            rs = gs = bs = as_ = 0
            for sy in range(SS):
                for sx in range(SS):
                    fx = (px * SS + sx + 0.5) / n
                    fy = (py * SS + sy + 0.5) / n
                    r, g, b, a = pixel(fx, fy)
                    rs += r * a; gs += g * a; bs += b * a; as_ += a
            k = SS * SS
            if as_ == 0:
                out = (0, 0, 0, 0)
            else:
                out = (rs // as_, gs // as_, bs // as_, as_ // k)
            i = (py * size + px) * 4
            buf[i:i + 4] = bytes(out)
    return bytes(buf)


def write_png(path, size, rgba):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xffffffff)
    raw = b"".join(b"\x00" + rgba[y * size * 4:(y + 1) * size * 4] for y in range(size))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 48, 128):
        rgba = render(size)
        path = os.path.join(OUT, "icon%d.png" % size)
        write_png(path, size, rgba)
        print("%-28s %dx%d  %5d bytes" % (path, size, size, os.path.getsize(path)))


if __name__ == "__main__":
    main()
