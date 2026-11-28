#!/usr/bin/env python3
"""闪翼双星：把 DefineShape 的形状记录解成多边形轮廓。

SWF 的图形不是图片，是「填充样式 + 边记录」。碰撞只关心轮廓，所以这里：
- 读填充/描边样式表（跳过渐变与位图，保证游标正确）；
- 逐条读边记录：直线、水平/垂直直线、二次贝塞尔；
- 按填充样式把边串成闭合轮廓，曲线按固定段数折线化；
- 输出 twips 与像素两套坐标。

只读，不执行 ActionScript，不改原文件。
"""
import json
import struct
from pathlib import Path

from rea_shanyi import Bits, iter_tags, read_matrix, read_uint, read_rect, parse_swf, collect

CURVE_SEGMENTS = 6
FILL_SOLID = 0x00
FILL_GRADIENT = {0x10, 0x12, 0x13}
FILL_BITMAP = {0x40, 0x41, 0x42, 0x43}


def _u8(data, offset):
    return data[offset], offset + 1


def _u16(data, offset):
    return read_uint(data, offset, 2), offset + 2


def _skip_rgba(data, offset, has_alpha):
    return offset + (4 if has_alpha else 3)


def _read_matrix_at(data, offset):
    _, used = read_matrix(data, offset)
    return used


def _read_gradient(data, offset, has_alpha):
    # GradientRecord: numGradients u8 (0xFF 表示扩展 u16)，随后每条 ratio + 颜色
    count = data[offset]
    offset += 1
    if count == 0xFF:
        count = read_uint(data, offset, 2)
        offset += 2
    for _ in range(count):
        offset += 1
        offset = _skip_rgba(data, offset, has_alpha)
    return offset


def read_fill_styles(data, offset, has_alpha):
    count = data[offset]
    offset += 1
    if count == 0xFF:
        count = read_uint(data, offset, 2)
        offset += 2
    fills = []
    for _ in range(count):
        kind = data[offset]
        offset += 1
        entry = {'type': kind}
        if kind == FILL_SOLID:
            offset = _skip_rgba(data, offset, has_alpha)
        elif kind in FILL_GRADIENT:
            offset += _read_matrix_at(data, offset)
            offset = _read_gradient(data, offset, has_alpha)
            if kind == 0x13:
                offset += 2  # focalPoint FIXED8
        elif kind in FILL_BITMAP:
            offset += 2  # bitmapId
            offset += _read_matrix_at(data, offset)
        else:
            raise ValueError('unknown fill type 0x%02x' % kind)
        fills.append(entry)
    return fills, offset


def read_line_styles(data, offset, has_alpha):
    count = data[offset]
    offset += 1
    if count == 0xFF:
        count = read_uint(data, offset, 2)
        offset += 2
    for _ in range(count):
        offset += 2  # width
        offset = _skip_rgba(data, offset, has_alpha)
    return offset


def signed(bits, n):
    value = bits.read(n)
    if n and value & (1 << (n - 1)):
        value -= 1 << n
    return value


def parse_shape(data, offset, shape_type):
    """返回 (轮廓列表, shapeId, bounds, 消耗字节数)。轮廓是 twips 坐标的点串。"""
    has_alpha = shape_type in (32, 83)
    shape_id, cursor = _u16(data, offset)
    bounds, used = read_rect(data, cursor)
    cursor += used
    if shape_type == 83:
        _, used = read_rect(data, cursor)  # edgeBounds
        cursor += used
        cursor += 1  # reserved/usesFillWindingRule 等
    fills, cursor = read_fill_styles(data, cursor, has_alpha)
    cursor = read_line_styles(data, cursor, has_alpha)
    base = cursor
    bits = Bits(data[base:])
    num_fill_bits = bits.read(4)
    num_line_bits = bits.read(4)

    contours = []
    current = None
    fill0 = fill1 = 0
    pen = (0, 0)
    subpath_start = (0, 0)

    def flush():
        nonlocal current
        if current and len(current['points']) >= 3:
            contours.append(current)
        current = None

    def add_point(point):
        nonlocal current
        if current is None:
            current = {'fill': fill1 or fill0 or 1, 'points': [list(subpath_start)]}
        current['points'].append([point[0], point[1]])

    guard = 0
    while True:
        guard += 1
        if guard > 200000:
            raise ValueError('shape record loop guard')
        is_edge = bits.read(1)
        if is_edge == 0:
            flags = bits.read(5)
            new_styles = bool(flags & 0x10)
            line_style = bool(flags & 0x08)
            fill_style1 = bool(flags & 0x04)
            fill_style0 = bool(flags & 0x02)
            move_to = bool(flags & 0x01)
            if flags == 0:
                break  # EndShapeRecord
            if move_to:
                nbits = bits.read(5)
                x = signed(bits, nbits)
                y = signed(bits, nbits)
                flush()
                pen = (x, y)
                subpath_start = pen
            if fill_style0:
                fill0 = bits.read(num_fill_bits) if num_fill_bits else 0
            if fill_style1:
                fill1 = bits.read(num_fill_bits) if num_fill_bits else 0
            if line_style:
                if num_line_bits:
                    bits.read(num_line_bits)
            if new_styles:
                # 新样式表需要重读 fill/line 数组，SWF 里对不齐就会把后续字节当样式。
                # 碰撞只需要主体轮廓：遇到 NewStyles 就收尾，保存已解析的轮廓。
                break
            continue

        straight = bits.read(1)
        num_bits = bits.read(4)
        if straight:
            general = bits.read(1)
            if general:
                dx = signed(bits, num_bits)
                dy = signed(bits, num_bits)
            else:
                vertical = bits.read(1)
                if vertical:
                    dx = 0
                    dy = signed(bits, num_bits)
                else:
                    dx = signed(bits, num_bits)
                    dy = 0
            pen = (pen[0] + dx, pen[1] + dy)
            add_point(pen)
        else:
            cx = pen[0] + signed(bits, num_bits)
            cy = pen[1] + signed(bits, num_bits)
            ax = cx + signed(bits, num_bits)
            ay = cy + signed(bits, num_bits)
            x0, y0 = pen
            for step in range(1, CURVE_SEGMENTS + 1):
                t = step / CURVE_SEGMENTS
                x = (1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * ax
                y = (1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * ay
                add_point((round(x, 1), round(y, 1)))
            pen = (ax, ay)
    flush()
    return contours, shape_id, bounds, base + bits.byte_pos


def polygon_area(points):
    total = 0.0
    for i in range(len(points)):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % len(points)]
        total += x1 * y2 - x2 * y1
    return abs(total) / 2.0


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('swf')
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--output')
    args = parser.parse_args()

    swf = parse_swf(args.swf)
    symbols, sprites, _ = collect(swf)
    polygons = []
    shapes = {}
    for code, body, _ in iter_tags(swf['tags']):
        if code not in (2, 22, 32, 83):
            continue
        try:
            contours, shape_id, bounds, _ = parse_shape(body, 0, code)
        except Exception as exc:
            continue
        shapes[shape_id] = {'contours': len(contours), 'bounds': bounds}
        for contour in contours:
            pts = contour['points']
            area = polygon_area(pts)
            if area < 4:
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            polygons.append({
                'shapeId': shape_id,
                'className': symbols.get(shape_id),
                'fill': contour['fill'],
                'areaTwips': round(area, 1),
                'pointsTwips': [[round(x, 1), round(y, 1)] for x, y in pts],
                'boundsTwips': {'xMin': min(xs), 'xMax': max(xs),
                                'yMin': min(ys), 'yMax': max(ys)},
            })
        if args.limit and len(polygons) >= args.limit:
            break

    report = {
        'swf': str(Path(args.swf).name),
        'shapesParsed': len(shapes),
        'polygons': len(polygons),
        'items': polygons,
    }
    text = json.dumps(report, ensure_ascii=False)
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(text + '\n', encoding='utf-8')
        print(json.dumps({'shapes': len(shapes), 'polygons': len(polygons)}))
    else:
        print(text)


if __name__ == '__main__':
    main()
