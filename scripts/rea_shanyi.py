#!/usr/bin/env python3
"""闪翼双星 SWF 深度逆向：把 Level* 的显示列表还原成可编程的坐标表。

只读解析，不改原文件、不执行 ActionScript。回答：
- 每个 class（SymbolClass）绑定到哪个 sprite/shape；
- LevelN 这一个 sprite 里到底摆了哪些对象、各自的角色 ID、矩阵平移（像素）；
- 这些角色 ID 对应哪些类名（用于给占位物命名：地形/尖刺/门/开关…）。

用法：
    python scripts/rea_shanyi.py <swf> --level Level1 --output data/shanyi/level-1.json
"""
import argparse
import json
import struct
import sys
import zlib
from pathlib import Path

TAG_END = 0
TAG_PLACE = 4
TAG_REMOVE1 = 5
TAG_PLACE2 = 26
TAG_REMOVE2 = 28
TAG_SPRITE = 39
TAG_SYMBOL_CLASS = 76
TAG_PLACE3 = 70


class Bits:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def read(self, count):
        value = 0
        for _ in range(count):
            byte = self.data[self.pos >> 3]
            bit = (byte >> (7 - (self.pos & 7))) & 1
            value = (value << 1) | bit
            self.pos += 1
        return value

    def align(self):
        self.pos = (self.pos + 7) & ~7

    @property
    def byte_pos(self):
        return (self.pos + 7) >> 3


def read_uint(data, offset, size):
    return int.from_bytes(data[offset:offset + size], 'little', signed=False)


def read_fixed(bits, nbits):
    raw = bits.read(nbits)
    if nbits and raw & (1 << (nbits - 1)):
        raw -= 1 << nbits
    return raw / 65536.0


def read_matrix(data, offset):
    bits = Bits(data[offset:])
    has_scale = bits.read(1)
    if has_scale:
        nbits = bits.read(5)
        scale_x = read_fixed(bits, nbits)
        scale_y = read_fixed(bits, nbits)
    else:
        scale_x = scale_y = 1.0
    has_rotate = bits.read(1)
    if has_rotate:
        nbits = bits.read(5)
        rot_skew0 = read_fixed(bits, nbits)
        rot_skew1 = read_fixed(bits, nbits)
    else:
        rot_skew0 = rot_skew1 = 0.0
    nbits = bits.read(5)
    tx = read_fixed(bits, nbits)
    ty = read_fixed(bits, nbits)
    bits.align()
    return {
        'scaleX': round(scale_x, 4), 'scaleY': round(scale_y, 4),
        'rotate0': round(rot_skew0, 4), 'rotate1': round(rot_skew1, 4),
        'x': round(tx, 2), 'y': round(ty, 2),
    }, bits.byte_pos


def read_string(data, offset):
    end = data.index(b'\x00', offset)
    return data[offset:end].decode('utf-8', 'replace'), end - offset + 1


def iter_tags(data):
    offset = 0
    while offset + 2 <= len(data):
        code_len = read_uint(data, offset, 2)
        code = code_len >> 6
        length = code_len & 0x3F
        header = 2
        if length == 0x3F:
            length = read_uint(data, offset + 2, 4)
            header = 6
        body = data[offset + header:offset + header + length]
        yield code, body, offset + header
        offset += header + length
        if code == TAG_END:
            break


def parse_place(body, place3=False):
    flags = body[0]
    flags2 = body[1] if place3 else 0
    cursor = 2 if place3 else 1
    depth = read_uint(body, cursor, 2)
    cursor += 2
    has_character = bool(flags & 0x02)
    has_matrix = bool(flags & 0x04)
    has_color = bool(flags & 0x08)
    has_ratio = bool(flags & 0x10)
    has_name = bool(flags & 0x20)
    has_clip_depth = bool(flags & 0x40)
    has_clip_actions = bool(flags & 0x80)
    class_name = None
    if place3 and (flags2 & 0x08):
        class_name, used = read_string(body, cursor)
        cursor += used
    character = read_uint(body, cursor, 2) if has_character else None
    if has_character:
        cursor += 2
    matrix = None
    if has_matrix:
        matrix, used = read_matrix(body, cursor)
        cursor += used
    if has_color:
        bits = Bits(body[cursor:])
        has_add = bits.read(1)
        nbits = bits.read(4)
        for _ in range(4):
            bits.read(nbits)
        if has_add:
            for _ in range(4):
                bits.read(nbits)
        bits.align()
        cursor += bits.byte_pos
    if has_ratio:
        cursor += 2
    name = None
    if has_name:
        name, used = read_string(body, cursor)
        cursor += used
    if has_clip_depth:
        cursor += 2
    return {
        'depth': depth,
        'characterId': character,
        'name': name,
        'className': class_name,
        'matrix': matrix,
        'move': bool(flags & 0x01),
        'clipActions': has_clip_actions,
    }


def parse_swf(path):
    raw = Path(path).read_bytes()
    signature = raw[:3]
    if signature == b'CWS':
        body = zlib.decompress(raw[8:])
    elif signature == b'FWS':
        body = raw[8:]
    else:
        raise SystemExit('unsupported SWF signature ' + repr(signature))
    version = raw[3]
    frame_size_bits = Bits(body)
    nbits = frame_size_bits.read(5)
    for _ in range(4):
        frame_size_bits.read(nbits)
    frame_size_bits.align()
    cursor = frame_size_bits.byte_pos
    frame_rate = read_uint(body, cursor, 2) / 256.0
    frame_count = read_uint(body, cursor + 2, 2)
    tags = body[cursor + 4:]
    return {
        'version': version,
        'frameRate': frame_rate,
        'frameCount': frame_count,
        'tags': tags,
    }


def collect(swf):
    symbols = {}
    sprites = {}
    for code, body, _ in iter_tags(swf['tags']):
        if code == TAG_SYMBOL_CLASS:
            count = read_uint(body, 0, 2)
            cursor = 2
            for _ in range(count):
                char_id = read_uint(body, cursor, 2)
                name, used = read_string(body, cursor + 2)
                symbols[char_id] = name
                cursor += 2 + used
        elif code == TAG_SPRITE:
            sprite_id = read_uint(body, 0, 2)
            frame_count = read_uint(body, 2, 2)
            sprites[sprite_id] = {'frameCount': frame_count, 'body': body[4:]}
    return symbols, sprites


def sprite_placements(body):
    placed = {}
    frames = []
    current = {}
    for code, tag, _ in iter_tags(body):
        if code in (TAG_PLACE, TAG_PLACE2, TAG_PLACE3):
            try:
                entry = parse_place(tag, place3=(code == TAG_PLACE3))
            except Exception as exc:  # 畸形标签只记一笔，不猜
                frames.append({'error': str(exc)})
                continue
            depth = entry['depth']
            if entry['characterId'] is None:
                previous = current.get(depth)
                if previous:
                    entry['characterId'] = previous.get('characterId')
                    entry['className'] = previous.get('className')
                    entry['name'] = entry['name'] or previous.get('name')
            current[depth] = entry
            placed[depth] = entry
        elif code == TAG_REMOVE1:
            depth = read_uint(tag, 0, 2)
            current.pop(depth, None)
        elif code == TAG_REMOVE2:
            depth = read_uint(tag, 0, 2)
            current.pop(depth, None)
    for depth in sorted(current):
        frames.append(current[depth] | {'depth': depth})
    return frames


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('swf')
    parser.add_argument('--level', default='Level1')
    parser.add_argument('--output')
    parser.add_argument('--depth', type=int, default=2)
    args = parser.parse_args()
    swf = parse_swf(args.swf)
    symbols, sprites = collect(swf)
    by_name = {name: char_id for char_id, name in symbols.items()}
    target_id = by_name.get(args.level)
    if target_id is None:
        matches = {name: cid for cid, name in symbols.items() if name.startswith(args.level)}
        raise SystemExit(f'{args.level} not found; candidates: {sorted(matches)[:5]}')
    sprite = sprites.get(target_id)
    if not sprite:
        raise SystemExit(f'{args.level} is not a DefineSprite')
    placements = sprite_placements(sprite['body'])

    def annotate(entries, depth, path, seen):
        for entry in entries:
            cid = entry.get('characterId')
            entry['targetName'] = symbols.get(cid) if cid else None
            entry['targetKind'] = ('sprite' if cid in sprites else 'other') if cid else None
            entry['path'] = path
            entry['level'] = depth
            if cid in sprites and depth < args.depth and cid not in seen:
                child = sprite_placements(sprites[cid]['body'])
                annotate(child, depth + 1, f'{path}/{entry.get("name") or cid}', seen | {cid})
                entry['children'] = child

    annotate(placements, 0, args.level, {target_id})

    def flatten(entries):
        out = []
        for entry in entries:
            out.append(entry)
            out.extend(flatten(entry.get('children') or []))
        return out

    flat = flatten(placements)
    report = {
        'swf': str(Path(args.swf).name),
        'swfVersion': swf['version'],
        'frameRate': swf['frameRate'],
        'frameCount': swf['frameCount'],
        'level': args.level,
        'levelSpriteId': target_id,
        'levelFrameCount': sprite['frameCount'],
        'symbolCount': len(symbols),
        'spriteCount': len(sprites),
        'objectCount': len(flat),
        'topLevelCount': len(placements),
        'objects': placements,
        'symbols': {str(cid): name for cid, name in sorted(symbols.items())},
    }
    text = json.dumps(report, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).parent.mkdir(parents=True, exist_ok=True)
        Path(args.output).write_text(text + '\n', encoding='utf-8')
        print(json.dumps({'level': args.level, 'objects': len(placements),
                          'symbols': len(symbols), 'sprite': target_id}))
    else:
        print(text)


if __name__ == '__main__':
    main()
