#!/usr/bin/env python3
"""用 FFDec 导出的 shape/*.svg 作为形状几何来源（比手写 SWF 边记录可靠）。

读取 <id>.svg 里第一条 path 的 d，支持 M/L/H/V/Q/C/Z（含相对指令），
再把外层 <g transform="matrix(a,b,c,d,e,f)"> 与 svg 的 viewBox 偏移应用上去，
输出像素坐标多边形。

用法：
    python scripts/rea_shanyi_svg_shapes.py --dir <shape目录> --ids 79,80 --output out.json
"""
import argparse
import json
import re
import xml.etree.ElementTree as ET
from pathlib import Path

TOKEN = re.compile(r'([MLHVCQZmlhvcqz])|(-?\d*\.?\d+(?:e-?\d+)?)')


def parse_path(d):
    """返回子路径列表，每个是 [[x,y],...]；曲线按 8 段折线化。"""
    tokens = [(m.group(1), m.group(2)) for m in TOKEN.finditer(d)]
    paths = []
    current = []
    x = y = 0.0
    start = (0.0, 0.0)
    command = None
    index = 0
    values = []

    def flush():
        nonlocal current
        if len(current) >= 3:
            paths.append(current)
        current = []

    def take(n):
        nonlocal index
        out = [float(tokens[index + i][1]) for i in range(n)]
        index += n
        return out

    while index < len(tokens):
        kind, value = tokens[index]
        if kind:
            command = kind
            index += 1
            values = []
        if command is None:
            index += 1
            continue
        relative = command.islower()
        upper = command.upper()
        if upper == 'Z':
            flush()
            x, y = start
            continue
        if upper == 'M':
            px, py = take(2)
            if relative:
                px, py = x + px, y + py
            flush()
            x, y = px, py
            start = (x, y)
            current = [[x, y]]
            command = 'l' if relative else 'L'
        elif upper == 'L':
            px, py = take(2)
            if relative:
                px, py = x + px, y + py
            x, y = px, py
            if not current:
                current = [[x, y]]
            else:
                current.append([x, y])
        elif upper == 'H':
            (px,) = take(1)
            x = x + px if relative else px
            if not current:
                current = [[x, y]]
            else:
                current.append([x, y])
        elif upper == 'V':
            (py,) = take(1)
            y = y + py if relative else py
            if not current:
                current = [[x, y]]
            else:
                current.append([x, y])
        elif upper == 'Q':
            cx, cy, ax, ay = take(4)
            if relative:
                cx, cy, ax, ay = x + cx, y + cy, x + ax, y + ay
            x0, y0 = x, y
            for step in range(1, 9):
                t = step / 8
                current.append([
                    round((1 - t) ** 2 * x0 + 2 * (1 - t) * t * cx + t * t * ax, 2),
                    round((1 - t) ** 2 * y0 + 2 * (1 - t) * t * cy + t * t * ay, 2),
                ])
            x, y = ax, ay
        elif upper == 'C':
            c1x, c1y, c2x, c2y, ax, ay = take(6)
            if relative:
                c1x, c1y, c2x, c2y, ax, ay = (x + c1x, y + c1y, x + c2x, y + c2y, x + ax, y + ay)
            x0, y0 = x, y
            for step in range(1, 11):
                t = step / 10
                mt = 1 - t
                current.append([
                    round(mt ** 3 * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t ** 3 * ax, 2),
                    round(mt ** 3 * y0 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t ** 3 * ay, 2),
                ])
            x, y = ax, ay
        else:
            index += 1
    flush()
    return paths


def load_shape(path):
    root = ET.parse(path).getroot()
    transform = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    group = root.find('{http://www.w3.org/2000/svg}g')
    if group is not None and group.get('transform'):
        m = re.search(r'matrix\(([^)]+)\)', group.get('transform'))
        if m:
            transform = tuple(float(part) for part in m.group(1).split(','))
    a, b, c, d, e, f = transform
    polygons = []
    for element in root.iter('{http://www.w3.org/2000/svg}path'):
        data = element.get('d')
        if not data:
            continue
        for points in parse_path(data):
            transformed = [[round(a * px + c * py + e, 2), round(b * px + d * py + f, 2)] for px, py in points]
            xs = [p[0] for p in transformed]
            ys = [p[1] for p in transformed]
            area = 0.0
            for i in range(len(transformed)):
                x1, y1 = transformed[i]
                x2, y2 = transformed[(i + 1) % len(transformed)]
                area += x1 * y2 - x2 * y1
            polygons.append({
                'points': transformed,
                'areaPx': round(abs(area) / 2, 1),
                'boundsPx': {'xMin': min(xs), 'xMax': max(xs), 'yMin': min(ys), 'yMax': max(ys)},
            })
    return {'width': float(re.sub('px', '', root.get('width', '0')) or 0),
            'height': float(re.sub('px', '', root.get('height', '0')) or 0),
            'polygons': polygons}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--dir', required=True)
    parser.add_argument('--ids', default='')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    directory = Path(args.dir)
    if args.ids:
        ids = [int(x) for x in args.ids.split(',') if x.strip()]
    else:
        ids = sorted(int(p.stem) for p in directory.glob('*.svg') if p.stem.isdigit())
    shapes = {}
    for shape_id in ids:
        file = directory / f'{shape_id}.svg'
        if not file.exists():
            continue
        try:
            shapes[shape_id] = load_shape(file)
        except Exception as exc:
            shapes[shape_id] = {'error': str(exc)}
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(shapes, ensure_ascii=False) + '\n', encoding='utf-8')
    ok = sum(1 for v in shapes.values() if v.get('polygons'))
    print(json.dumps({'requested': len(ids), 'withPolygons': ok}))


if __name__ == '__main__':
    main()
