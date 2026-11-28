#!/usr/bin/env python3
"""把 Level1 所有层（背景/地形/箱子/门/CPS）按世界矩阵合成一张 SVG，用于和基准图比对。

用法：python scripts/rea_shanyi_layers.py --level local/rea/level1.json \
        --shape-dir <core-decompiled/shape> --svg local/rea/layers.svg
"""
import argparse, json, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
from rea_shanyi_svg_shapes import load_shape

PALETTE = {'BG2': '#243447', 'Ground': '#4f8f4f', '箱子': '#c08a45',
           '传送门_光': '#5aa9ff', 'CPS': '#b0b0b0'}


def walk(entries, top=''):
    for entry in entries:
        yield top, entry
        yield from walk(entry.get('children') or [], top or (entry.get('targetName') or ''))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--level', required=True)
    ap.add_argument('--shape-dir', required=True)
    ap.add_argument('--svg', required=True)
    args = ap.parse_args()
    level = json.loads(Path(args.level).read_text(encoding='utf-8'))
    shape_dir = Path(args.shape_dir)
    paths, missing, used = [], 0, set()
    for top, entry in walk(level['objects']):
        if entry.get('targetKind') != 'other':
            continue
        cid, matrix = entry.get('characterId'), entry.get('worldMatrix')
        if not cid or not matrix:
            continue
        file = shape_dir / f'{cid}.svg'
        if not file.exists():
            missing += 1
            continue
        try:
            shape = load_shape(file)
        except Exception:
            missing += 1
            continue
        a, b, c, d, tx, ty = matrix
        for poly in shape.get('polygons', []):
            pts = [(a * (x * 20) + c * (y * 20) + tx,
                    b * (x * 20) + d * (y * 20) + ty) for x, y in poly['points']]
            pts = [(round(x / 20, 1), round(y / 20, 1)) for x, y in pts]
            if len(pts) >= 3:
                paths.append((top, cid, pts))
                used.add(cid)
    if not paths:
        raise SystemExit('no layers composed')
    xs = [p[0] for _, _, pts in paths for p in pts]
    ys = [p[1] for _, _, pts in paths for p in pts]
    x0, y0 = min(xs), min(ys)
    w, h = max(xs) - x0, max(ys) - y0
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0:.0f} {y0:.0f} {w:.0f} {h:.0f}" width="1400">',
             f'<rect x="{x0:.0f}" y="{y0:.0f}" width="{w:.0f}" height="{h:.0f}" fill="#0b0f14"/>']
    for top, _, pts in paths:
        color = PALETTE.get(top, '#8a8fa3')
        d = 'M' + ' L'.join(f'{x},{y}' for x, y in pts) + ' Z'
        parts.append(f'<path d="{d}" fill="{color}" fill-opacity=".6" stroke="{color}" stroke-width=".5"/>')
    parts.append('</svg>')
    Path(args.svg).parent.mkdir(parents=True, exist_ok=True)
    Path(args.svg).write_text('\n'.join(parts), encoding='utf-8')
    print(json.dumps({'paths': len(paths), 'shapes': len(used), 'missing': missing,
                      'layers': sorted({t for t, _, _ in paths}),
                      'bboxPx': [round(x0), round(y0), round(w), round(h)]}))


if __name__ == '__main__':
    main()
