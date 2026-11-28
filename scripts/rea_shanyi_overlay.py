#!/usr/bin/env python3
"""把 Level1 的层合成结果和 FFDec 基准图对齐，输出覆盖率，并把可碰撞对象写进关卡数据。

做三件事：
1. 按层（Ground / 箱子 / 传送门_光）统计包围盒；
2. 把 Ground 层按比例缩放到基准图坐标系，算「覆盖了基准图多少不透明像素」；
3. 生成 public/shanyi-native/level-1.json 的碰撞矩形（地形 + 箱子 + 门框）。
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from rea_shanyi_svg_shapes import load_shape

SOLID_LAYERS = {'Ground', '箱子', '传送门_光'}

PALETTE = {'Ground': '#4f8f4f', '箱子': '#c08a45', '传送门_光': '#5aa9ff',
           'BG2': '#243447', 'CPS': '#b0b0b0'}


def walk(entries, top=''):
    for entry in entries:
        yield top, entry
        yield from walk(entry.get('children') or [], top or (entry.get('targetName') or ''))


def collect(level, shape_dir, wanted=None):
    shapes, boxes = {}, {}
    for top, entry in walk(level['objects']):
        if entry.get('targetKind') != 'other':
            continue
        if wanted and top not in wanted:
            continue
        cid, matrix = entry.get('characterId'), entry.get('worldMatrix')
        if not cid or not matrix:
            continue
        if cid not in shapes:
            file = shape_dir / f'{cid}.svg'
            if not file.exists():
                continue
            try:
                shapes[cid] = load_shape(file)
            except Exception:
                continue
        shape = shapes[cid]
        if not shape:
            continue
        a, b, c, d, tx, ty = matrix
        for poly in shape.get('polygons', []):
            pts = [(a * (x * 20) + c * (y * 20) + tx,
                    b * (x * 20) + d * (y * 20) + ty) for x, y in poly['points']]
            pts = [(x / 20, y / 20) for x, y in pts]
            if len(pts) < 3:
                continue
            xs = [p[0] for p in pts]
            ys = [p[1] for p in pts]
            box = (min(xs), min(ys), max(xs), max(ys))
            boxes.setdefault(top, []).append((box, pts))
    return boxes


def bbox_of(items):
    xs0 = min(b[0][0] for b in items)
    ys0 = min(b[0][1] for b in items)
    xs1 = max(b[0][2] for b in items)
    ys1 = max(b[0][3] for b in items)
    return xs0, ys0, xs1, ys1


def svg_for(items, path, x0, y0, x1, y1):
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{x0} {y0} {x1 - x0} {y1 - y0}" '
             f'width="{x1 - x0}" height="{y1 - y0}">',
             f'<rect x="{x0}" y="{y0}" width="{x1 - x0}" height="{y1 - y0}" fill="none"/>']
    for _, pts in items:
        d = 'M' + ' L'.join(f'{x:.1f},{y:.1f}' for x, y in pts) + ' Z'
        parts.append(f'<path d="{d}" fill="#fff"/>')
    parts.append('</svg>')
    Path(path).write_text('\n'.join(parts), encoding='utf-8')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--level', required=True)
    ap.add_argument('--shape-dir', required=True)
    ap.add_argument('--reference', required=True)
    ap.add_argument('--out-json', required=True)
    ap.add_argument('--out-svg', required=True)
    ap.add_argument('--out-mask')
    args = ap.parse_args()

    level = json.loads(Path(args.level).read_text(encoding='utf-8'))
    shape_dir = Path(args.shape_dir)
    boxes = collect(level, shape_dir)
    report = {}
    for top, items in boxes.items():
        x0, y0, x1, y1 = bbox_of(items)
        report[top] = {'paths': len(items), 'bbox': [round(x0), round(y0), round(x1 - x0), round(y1 - y0)]}

    ground = boxes.get('Ground') or []
    if not ground:
        raise SystemExit('no Ground layer collected')
    gx0, gy0, gx1, gy1 = bbox_of(ground)
    svg_for(ground, args.out_svg, gx0, gy0, gx1, gy1)

    # 碰撞矩形：地形 + 箱子 + 门框，按 AABB 输出（多边形碰撞留给下一阶段）
    solids = []
    for top in ('Ground', '箱子', '传送门_光'):
        for (x0, y0, x1, y1), _pts in boxes.get(top, []):
            w, h = x1 - x0, y1 - y0
            if w >= 4 and h >= 4:
                solids.append({'x': round(x0, 1), 'y': round(y0, 1),
                               'w': round(w, 1), 'h': round(h, 1), 'layer': top})
    uniq = {(s['x'], s['y'], s['w'], s['h']): s for s in solids}
    data = {'name': 'Level1', 'source': 'rea', 'width': round(gx1 - gx0),
            'height': round(gy1 - gy0), 'solids': list(uniq.values())}
    Path(args.out_json).write_text(json.dumps(data, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')

    # 覆盖率：把 Ground 掩码缩放到基准图内容区
    coverage = None
    try:
        from PIL import Image
        ref = Image.open(args.reference).convert('RGBA')
        content = ref.getbbox()
        mask = Image.new('L', ref.size, 0)
        # 用几何包围盒近似掩码（多边形精确栅格化留给渲染阶段）
        scale = (content[2] - content[0]) / (gx1 - gx0)
        w = (gx1 - gx0) * scale
        h = (gy1 - gy0) * scale
        from PIL import ImageDraw
        draw = ImageDraw.Draw(mask)
        for (x0, y0, x1, y1), _pts in ground:
            draw.rectangle([content[0] + (x0 - gx0) * scale,
                            content[1] + (y0 - gy0) * scale,
                            content[0] + (x1 - gx0) * scale,
                            content[1] + (y1 - gy0) * scale], fill=255)
        alpha = ref.getchannel('A')
        opaque = sum(1 for v in alpha.getdata() if v > 8)
        covered = 0
        for v, a in zip(mask.getdata(), alpha.getdata()):
            if v > 0 and a > 8:
                covered += 1
        coverage = {'referenceOpaque': opaque, 'groundCovered': covered,
                    'groundCoverage': round(covered / opaque, 3),
                    'groundBboxPx': [round(gx0), round(gy0), round(gx1 - gx0), round(gy1 - gy0)],
                    'referenceContent': list(content)}
        if args.out_mask:
            mask.save(args.out_mask)
    except ImportError:
        coverage = {'error': 'PIL not installed'}

    print(json.dumps({'layers': report, 'solids': len(data['solids']), 'coverage': coverage},
                     ensure_ascii=False))


if __name__ == '__main__':
    main()
