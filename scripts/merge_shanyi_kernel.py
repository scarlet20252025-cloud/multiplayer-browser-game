#!/usr/bin/env python3
"""合并闪翼双星正传的代码包与资源包（原创工具）

背景
----
4399 发行版把正传拆成两个 SWF：
- core_3.swf：1.83 MB，3 个 DoABC（988 个 AS3 类）+ 21 个 DefineSprite，ID 1..21
- core_4.swf：3.13 MB，1 个 DefineSprite(30534) + 内部 2176 个定义，ID 1..30534

两者都在顶层声明文档类 `fw`，但 core_4 的 `fw` 只有 468 字节，是资源包的壳。
直接拼接会发生 character ID 冲突（core_4 内部大量使用 1..21）。

做法
----
保留 core_3 原样；把 core_4 的所有定义类 tag 重编号（+OFFSET）后追加到顶层，
并同步改写 PlaceObject/PlaceObject2/PlaceObject3 里的 characterId 引用。
丢弃 core_4 的 DoABC / SymbolClass / ShowFrame / End 等控制 tag，避免文档类冲突。

用法
----
    python scripts/merge_shanyi_kernel.py core_3.swf core_4.swf -o merged.swf

输出为未压缩 FWS，便于后续再压缩或用 FFDec 检查。
"""
import argparse
import struct
import sys
import zlib

# 前两字节是 characterId 的定义类 tag
DEF_TAGS = {2, 6, 14, 20, 21, 22, 32, 35, 36, 39, 46, 48, 75, 83, 84, 87, 90, 91}
# 从资源包丢弃的控制 tag：文档类、帧、背景、元数据、场景标签
DROP_FROM_ASSET = {0, 1, 9, 56, 65, 69, 76, 77, 82, 86}


def split_tags(buf):
    """把一段 tag 流切成 [(code, data)]。"""
    out = []
    p = 0
    while p < len(buf) - 1:
        header = struct.unpack('<H', buf[p:p + 2])[0]
        p += 2
        code = header >> 6
        length = header & 0x3F
        if length == 0x3F:
            length = struct.unpack('<I', buf[p:p + 4])[0]
            p += 4
        out.append((code, buf[p:p + length]))
        p += length
    return out


def join_tag(code, data):
    if len(data) < 0x3F:
        return struct.pack('<H', (code << 6) | len(data)) + data
    return struct.pack('<H', (code << 6) | 0x3F) + struct.pack('<I', len(data)) + data


def parse_swf(path):
    raw = open(path, 'rb').read()
    sig = raw[:3]
    if sig == b'CWS':
        body = zlib.decompress(raw[8:])
    elif sig == b'FWS':
        body = raw[8:]
    else:
        raise SystemExit('不支持的签名 %r（ZWS 需先转成 FWS）' % sig)
    nbits = body[0] >> 3
    rect_len = (5 + nbits * 4 + 7) // 8
    rect = body[:rect_len]
    frame = body[rect_len:rect_len + 4]
    tags = split_tags(body[rect_len + 4:])
    return {'version': raw[3], 'rect': rect, 'frame': frame, 'tags': tags}


def fix_place_object_v1(data, offset):
    """PlaceObject(4): CharacterId(UI16) + Depth(UI16) + Matrix。"""
    if len(data) < 4:
        return data
    cid = struct.unpack('<H', data[:2])[0]
    return struct.pack('<H', cid + offset) + data[2:]


def fix_place_object2(data, offset):
    """PlaceObject2(26): Flags(UI8) + Depth(UI16) + [CharacterId] + ..."""
    if len(data) < 3:
        return data
    flags = data[0]
    head = data[:3]
    rest = data[3:]
    # bit1 = HasCharacter
    if flags & 0x02 and len(rest) >= 2:
        cid = struct.unpack('<H', rest[:2])[0]
        return head + struct.pack('<H', cid + offset) + rest[2:]
    return data


def fix_place_object3(data, offset):
    """PlaceObject3(70): Flags1 + Flags2 + Depth + [ClassName] + [CharacterId] + ..."""
    if len(data) < 4:
        return data
    flags1, flags2 = data[0], data[1]
    out = bytearray(data[:4])          # Flags1 + Flags2 + Depth
    p = 4
    if flags2 & 0x08:                  # HasClassName
        end = data.index(b'\x00', p)
        out += data[p:end + 1]
        p = end + 1
    if flags1 & 0x02 and p + 2 <= len(data):   # HasCharacter
        cid = struct.unpack('<H', data[p:p + 2])[0]
        out += struct.pack('<H', cid + offset)
        p += 2
    out += data[p:]
    return bytes(out)


def renumber(tags, offset):
    """递归重编号：定义 ID、PlaceObject 引用、DefineSprite 内部流。"""
    out = []
    for code, data in tags:
        if code in DEF_TAGS and len(data) >= 2:
            cid = struct.unpack('<H', data[:2])[0]
            data = struct.pack('<H', cid + offset) + data[2:]
        if code == 39 and len(data) >= 4:      # DefineSprite: id + frameCount + inner
            inner = split_tags(data[4:])
            data = data[:4] + b''.join(join_tag(c, d) for c, d in renumber(inner, offset))
        elif code == 4:
            data = fix_place_object_v1(data, offset)
        elif code == 26:
            data = fix_place_object2(data, offset)
        elif code == 70:
            data = fix_place_object3(data, offset)
        out.append((code, data))
    return out


def rewrite_symbol_class(tags, class_name):
    """把文档类（TagId 0）改成指定类名，其余映射保持不变。"""
    out = []
    for code, data in tags:
        if code == 76 and len(data) >= 2:
            count = struct.unpack('<H', data[:2])[0]
            p = 2
            items = []
            for _ in range(count):
                cid = struct.unpack('<H', data[p:p + 2])[0]
                p += 2
                end = data.index(b'\x00', p)
                items.append((cid, data[p:end].decode('utf-8', 'replace')))
                p = end + 1
            rebuilt = struct.pack('<H', count)
            for cid, name in items:
                use = class_name if cid == 0 else name
                rebuilt += struct.pack('<H', cid) + use.encode('utf-8') + b'\x00'
            data = rebuilt
        out.append((code, data))
    return out


def build(swf, extra_tags):
    payload = swf['rect'] + swf['frame']
    for code, data in extra_tags:
        payload += join_tag(code, data)
    payload += struct.pack('<H', 0)          # End
    total = 8 + len(payload)
    return b'FWS' + bytes([swf['version']]) + struct.pack('<I', total) + payload


def main():
    ap = argparse.ArgumentParser(description='合并闪翼正传代码包与资源包')
    ap.add_argument('kernel', help='core_3.swf（代码包）')
    ap.add_argument('assets', help='core_4.swf（资源包）')
    ap.add_argument('-o', '--output', required=True)
    ap.add_argument('--offset', type=int, default=1000,
                    help='资源包 ID 的偏移量，默认 1000')
    ap.add_argument('--document-class', default=None,
                    help='把文档类改成指定类名（例如 Main）；默认保留原 fw')
    args = ap.parse_args()

    kernel = parse_swf(args.kernel)
    assets = parse_swf(args.assets)

    # 去掉代码包里仅供展示的 End，稍后统一补
    base = [(c, d) for c, d in kernel['tags'] if c != 0]
    if args.document_class:
        base = rewrite_symbol_class(base, args.document_class)
    kept_asset = [(c, d) for c, d in assets['tags'] if c not in DROP_FROM_ASSET]

    renumbered = renumber(kept_asset, args.offset)
    merged_tags = base + renumbered

    out = build(kernel, merged_tags)
    open(args.output, 'wb').write(out)

    print('代码包 %d 个 tag，资源包保留 %d 个（丢弃 %d 个控制 tag）'
          % (len(base), len(kept_asset), len(assets['tags']) - len(kept_asset)))
    print('ID 偏移 +%d，合并后 %d 个 tag，输出 %d 字节 -> %s'
          % (args.offset, len(merged_tags), len(out), args.output))


if __name__ == '__main__':
    sys.exit(main())
