#!/usr/bin/env python3
"""把 Level1 的摆放对象与形状多边形合成一张关卡几何图（SVG）。

输入：
  --level  rea_shanyi.py 导出的 level JSON（含每个对象的 worldTwips）
  --shapes rea_shanyi_shapes.py 导出的多边形 JSON
输出：SVG（像素坐标），可选 PNG 由调用方渲染。
"""
import argparse
import json
from pathlib import Path

COLORS = {
    'Ground': '#4f8f4f', '箱子': '#c08a45', '传送门_光': '#5aa9ff',
    'CPS': '#b0b0b0', 'BG2': '#1b2436',
}


def walk(entries, top=''):
    for entry in entries:
        yield top, entry
        children = entry.get('children') or []
        yield from walk(children, top or (entry.get('targetName') or ''))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--level', required=True)
    parser.add_argument('--shapes', default=None)
    parser.add_argument('--svg-shapes', default=None)
    parser.add_argument('--svg', required=True)
    parser.add_argument('--only', default='Ground')
    args = parser.parse_args()

    level = json.loads(Path(args.level).read_text(encoding='utf-8'))
    polygons = {}
    if args.shapes:
        shapes = json.loads(Path(args.shapes).read_text(encoding='utf-8'))
        for item in shapes['items']:
            polygons.setdefault(item['shapeId'], []).append(item)
    svg_shapes = {}
    if args.svg_shapes:
        raw = json.loads(Path(args.svg_shapes).read_text(encoding='utf-8'))
        svg_shapes = {int(k): v for k, v in raw.items()}

    only = set(filter(None, args.only.split(',')))
    paths = []
    for top, entry in walk(level['objects']):
        if entry.get('targetKind') != 'other':
            continue
        if only and top not in only:
            continue
        cid = entry.get('characterId')
        matrix = entry.get('worldMatrix') or [1, 0, 0, 1, 0, 0]
        a, b, c, d, tx, ty = matrix
        source = None
        if cid in svg_shapes:
            source = [p['points'] for p in svg_shapes[cid].get('polygons', [])]
        elif cid in polygons:
            source = [[[x, y] for x, y in poly['pointsTwips']] for poly in polygons[cid]]
        if not source:
            continue
        for points in source:
            # SVG 是像素；矩阵是 twips。先换成 twips，套矩阵，再换回像素。
            pts = []
            for x, y in points:
                wx = a * (x * 20) + c * (y * 20) + tx
                wy = b * (x * 20) + d * (y * 20) + ty
                pts.append([round(wx / 20, 1), round(wy / 20, 1)])
            if len(pts) < 3:
                continue
            dpath = 'M' + ' L'.join(f'{x},{y}' for x, y in pts) + ' Z'
            paths.append((top, dpath))

    all_pts = []
    for _, d in paths:
        for pair in d[1:-2].split(' L'):
            x, y = pair.split(',')
            all_pts.append((float(x), float(y)))
    if not all_pts:
        raise SystemExit('no polygons selected; check --only and shape coverage')
    xs = [p[0] for p in all_pts]
    ys = [p[1] for p in all_pts]
    x0, x1 = min(xs), max(xs)
    y0, y1 = min(ys), max(ys)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.0f} {y0:.0f} '
             f'{x1 - x0:.0f} {y1 - y0:.0f}" width="1400">',
             f'<rect x="{x0:.0f}" y="{y0:.0f}" width="{x1 - x0:.0f}" height="{y1 - y0:.0f}" fill="#0b0f14"/>']
    for top, d in paths:
        color = COLORS.get(top, '#8a8fa3')
        parts.append(f'<path d="{d}" fill="{color}" fill-opacity=".65" stroke="{color}" stroke-width="1"/>')
    parts.append('</svg>')
    Path(args.svg).parent.mkdir(parents=True, exist_ok=True)
    Path(args.svg).write_text('\n'.join(parts), encoding='utf-8')
    print(json.dumps({'paths': len(paths), 'viewBoxPx': [round(x0), round(y0), round(x1 - x0), round(y1 - y0)]}))


if __name__ == '__main__':
    main()
