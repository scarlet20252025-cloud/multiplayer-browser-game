#!/usr/bin/env python3
"""把 Level1 的 Ground 多边形拆成水平条带矩形（扫描线），供原生模拟做碰撞。

多边形直接做碰撞需要 SAT/扫掠，先按 8px 行高扫描求交，输出矩形集合；
地形本来就是横向平台，条带化后的误差在半个行高以内。
"""
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from rea_shanyi_svg_shapes import load_shape
from rea_shanyi_overlay import walk

STEP = 8.0
LAYERS = {'Ground': 'ground', '箱子': 'box', '传送门_光': 'door'}


def spans_at(points, y):
    xs = []
    for i in range(len(points)):
        x1, y1 = points[i]
        x2, y2 = points[(i + 1) % len(points)]
        if (y1 <= y < y2) or (y2 <= y < y1):
            t = (y - y1) / (y2 - y1)
            xs.append(x1 + t * (x2 - x1))
    xs.sort()
    return [(xs[i], xs[i + 1]) for i in range(0, len(xs) - 1, 2)]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--level', required=True)
    ap.add_argument('--shape-dir', required=True)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    level = json.loads(Path(args.level).read_text(encoding='utf-8'))
    shape_dir = Path(args.shape_dir)
    cache = {}
    rects, bounds = [], [1e9, 1e9, -1e9, -1e9]
    for top, entry in walk(level['objects']):
        kind = LAYERS.get(top)
        if not kind or entry.get('targetKind') != 'other':
            continue
        cid, matrix = entry.get('characterId'), entry.get('worldMatrix')
        if not cid or not matrix:
            continue
        if cid not in cache:
            file = shape_dir / f'{cid}.svg'
            if not file.exists():
                cache[cid] = None
            else:
                try:
                    cache[cid] = load_shape(file)
                except Exception:
                    cache[cid] = None
        shape = cache[cid]
        if not shape:
            continue
        a, b, c, d, tx, ty = matrix
        for poly in shape.get('polygons', []):
            pts = [((a * (x * 20) + c * (y * 20) + tx) / 20,
                    (b * (x * 20) + d * (y * 20) + ty) / 20) for x, y in poly['points']]
            if len(pts) < 3:
                continue
            ys = [p[1] for p in pts]
            y0, y1 = min(ys), max(ys)
            bounds[0] = min(bounds[0], min(p[0] for p in pts))
            bounds[1] = min(bounds[1], y0)
            bounds[2] = max(bounds[2], max(p[0] for p in pts))
            bounds[3] = max(bounds[3], y1)
            y = y0
            while y < y1:
                for xa, xb in spans_at(pts, y + STEP / 2):
                    if xb - xa >= 4:
                        rects.append({'x': round(xa, 1), 'y': round(y, 1),
                                      'w': round(xb - xa, 1), 'h': STEP, 'layer': kind})
                y += STEP
    # 合并同层的连续行（同 x 同宽，纵向相邻）
    merged = []
    rects.sort(key=lambda r: (r['layer'], r['x'], r['w'], r['y']))
    for r in rects:
        last = merged[-1] if merged else None
        if (last and last['layer'] == r['layer'] and abs(last['x'] - r['x']) < 0.6
                and abs(last['w'] - r['w']) < 0.6 and abs(last['y'] + last['h'] - r['y']) < 0.6):
            last['h'] = round(last['h'] + r['h'], 1)
        else:
            merged.append(dict(r))
    data = {'name': 'Level1', 'source': 'rea-scanline',
            'width': round(bounds[2] - bounds[0]), 'height': round(bounds[3] - bounds[1]),
            'origin': [round(bounds[0], 1), round(bounds[1], 1)],
            'solids': merged}
    Path(args.out).write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    print(json.dumps({'rects': len(merged),
                      'byLayer': {k: sum(1 for r in merged if r['layer'] == k) for k in LAYERS.values()},
                      'size': [data['width'], data['height']], 'origin': data['origin']}))


if __name__ == '__main__':
    main()
