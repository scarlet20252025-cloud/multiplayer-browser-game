#!/usr/bin/env python3
"""SWF 包头与标签结构检查（原创工具）

用途：对原游戏 SWF 做只读的二进制结构核查，补齐 audit_archive.py 只扫文本时
缺少的二进制证据。它不反编译、不执行、不修改文件。

回答的问题：
- 压缩签名（FWS 未压缩 / CWS zlib / ZWS LZMA）
- SWF version、声明长度与实际字节是否一致（差值为 0 才说明 zlib 流完整）
- 舞台尺寸、声明帧率、总帧数
- AVM 类型：依据 FileAttributes 标签的 ActionScript3 标志与 DoABC 标签判定，
  而不是用 SWF version 推断
- 资源是否内嵌：统计图形/音频/字体定义标签
- 是否存在壳特征：DefineBinaryData 占比极高而图形标签约等于 0

用法：
    python scripts/inspect_swf.py <文件或目录> [--output report.json]

输出为 JSON；对目录会递归处理其中的 .swf。
"""
import argparse
import hashlib
import json
import os
import struct
import sys
import zlib

TAG_NAMES = {
    0: 'End', 1: 'ShowFrame', 2: 'DefineShape', 4: 'PlaceObject', 5: 'RemoveObject',
    6: 'DefineBits', 9: 'SetBackgroundColor', 10: 'DefineFont', 11: 'DefineText',
    12: 'DoAction', 14: 'DefineSound', 15: 'StartSound', 18: 'SoundStreamHead',
    19: 'SoundStreamBlock', 20: 'DefineBitsLossless', 21: 'DefineBitsJPEG2',
    22: 'DefineShape2', 26: 'PlaceObject2', 28: 'RemoveObject2', 32: 'DefineShape3',
    34: 'DefineButton2', 35: 'DefineBitsJPEG3', 36: 'DefineBitsLossless2',
    37: 'DefineEditText', 39: 'DefineSprite', 43: 'FrameLabel', 45: 'SoundStreamHead2',
    46: 'DefineMorphShape', 48: 'DefineFont2', 56: 'ExportAssets', 57: 'ImportAssets',
    58: 'EnableDebugger', 59: 'DoInitAction', 60: 'DefineVideoStream', 61: 'VideoFrame',
    65: 'ScriptLimits', 69: 'FileAttributes', 70: 'PlaceObject3', 71: 'ImportAssets2',
    73: 'DefineFontAlignZones', 75: 'DefineFont3', 76: 'SymbolClass', 77: 'Metadata',
    78: 'DefineScalingGrid', 82: 'DoABC', 83: 'DefineShape4', 86: 'DefineSceneAndFrameLabelData',
    87: 'DefineBinaryData', 88: 'DefineFontName', 90: 'DefineBitsJPEG4', 91: 'DefineFont4',
}

GRAPHIC_TAGS = {2, 6, 20, 21, 22, 32, 35, 36, 83, 46, 84}
AUDIO_TAGS = {14}
FONT_TAGS = {10, 48, 75, 91, 88}


def read_body(data):
    """返回 (解压后的 body, 说明)。ZWS 仅记录不支持，不做解码。"""
    sig = data[:3]
    if sig == b'FWS':
        return data[8:], 'uncompressed'
    if sig == b'CWS':
        try:
            return zlib.decompress(data[8:]), 'zlib'
        except zlib.error as exc:
            return None, 'zlib-error: %s' % exc
    if sig == b'ZWS':
        return None, 'lzma-unsupported'
    return None, 'not-a-swf'


def parse_rect(body):
    """按位解析舞台矩形，返回 (xmin, xmax, ymin, ymax) 与占用字节。"""
    if not body:
        return None, 0
    nbits = body[0] >> 3
    total_bits = 5 + nbits * 4
    nbytes = (total_bits + 7) // 8

    class BitReader:
        def __init__(self, buf):
            self.buf = buf
            self.pos = 0

        def bits(self, count):
            value = 0
            for _ in range(count):
                byte = self.buf[self.pos >> 3]
                value = (value << 1) | ((byte >> (7 - (self.pos & 7))) & 1)
                self.pos += 1
            return value

    reader = BitReader(body)
    reader.bits(5)
    values = [reader.bits(nbits) for _ in range(4)]
    return values, nbytes


def walk_tags(body, offset):
    """遍历标签，返回 (统计计数器, 若干关键信息)。不递归 sprite 时用于顶层概览。"""
    counts = {}
    order = []
    file_attributes_flags = None
    has_do_abc = False
    has_do_action = False
    pos = offset
    while pos < len(body) - 1:
        header = struct.unpack('<H', body[pos:pos + 2])[0]
        pos += 2
        code = header >> 6
        length = header & 0x3F
        if length == 0x3F:
            length = struct.unpack('<I', body[pos:pos + 4])[0]
            pos += 4
        name = TAG_NAMES.get(code, 'Tag%d' % code)
        counts[name] = counts.get(name, 0) + 1
        if not order or order[-1] != name:
            order.append(name)
        if code == 69 and length >= 4:
            file_attributes_flags = struct.unpack('<I', body[pos:pos + 4])[0]
        elif code == 82:
            has_do_abc = True
        elif code == 12:
            has_do_action = True
        pos += length
    return counts, order, file_attributes_flags, has_do_abc, has_do_action


def inspect(path):
    with open(path, 'rb') as fh:
        data = fh.read()
    info = {
        'path': os.path.basename(path),
        'bytes': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
        'signature': data[:3].decode('latin1') if len(data) >= 3 else None,
        'swfVersion': data[3] if len(data) >= 4 else None,
    }
    if len(data) < 8:
        info['error'] = 'file too small'
        return info
    info['declaredLength'] = struct.unpack('<I', data[4:8])[0]

    body, note = read_body(data)
    info['compression'] = note
    if body is None:
        info['error'] = note
        return info

    info['decompressedBytes'] = len(body) + 8
    info['lengthMatchesDeclared'] = (len(body) + 8) == info['declaredLength']

    rect, rect_bytes = parse_rect(body)
    if rect:
        # SWF 的 rect 顺序是 xmin/xmax/ymin/ymax，单位 twips（1/20 px）
        width = (rect[1] - rect[0]) / 20.0
        height = (rect[3] - rect[2]) / 20.0
        info['stage'] = {'width': width, 'height': height, 'twips': rect}
    frame_offset = rect_bytes
    if len(body) >= frame_offset + 4:
        # SWF 的 FrameRate 是 8.8 定点数，低字节为小数部分、高字节为整数部分。
        fraction = body[frame_offset]
        integer = body[frame_offset + 1]
        info['frameRate'] = round(integer + fraction / 256.0, 3)
        info['frameCount'] = struct.unpack('<H', body[frame_offset + 2:frame_offset + 4])[0]

    counts, order, fa_flags, has_abc, has_action = walk_tags(body, frame_offset + 4)
    info['tagCounts'] = counts
    info['topLevelTagOrder'] = order[:40]
    info['fileAttributes'] = {'raw': fa_flags, 'as3Flag': bool(fa_flags & 8) if fa_flags is not None else None}
    info['hasDoABC'] = has_abc
    info['hasDoAction'] = has_action
    if has_abc:
        info['avmType'] = 'AVM2 (DoABC 存在)'
    elif has_action:
        info['avmType'] = 'AVM1 (仅 DoAction，无 DoABC)'
    elif fa_flags is not None and (fa_flags & 8):
        info['avmType'] = 'AVM2 (FileAttributes 声明 AS3，但未找到 DoABC)'
    else:
        info['avmType'] = 'unknown (无 DoABC / DoAction / AS3 标志)'

    graphics = sum(counts.get(TAG_NAMES[t], 0) for t in GRAPHIC_TAGS if t in TAG_NAMES)
    audio = sum(counts.get(TAG_NAMES[t], 0) for t in AUDIO_TAGS if t in TAG_NAMES)
    fonts = sum(counts.get(TAG_NAMES[t], 0) for t in FONT_TAGS if t in TAG_NAMES)
    binary = counts.get('DefineBinaryData', 0)
    info['embedded'] = {'graphics': graphics, 'audio': audio, 'fonts': fonts, 'binaryData': binary}
    # 壳特征：二进制数据很多、顶层几乎没有图形/音频
    info['looksLikeWrapper'] = bool(binary >= 2 and graphics == 0 and audio == 0)
    return info


def main():
    parser = argparse.ArgumentParser(description='SWF 包头与标签结构检查（只读）')
    parser.add_argument('target', help='SWF 文件或包含 SWF 的目录')
    parser.add_argument('--output', help='输出 JSON 路径；省略则打印到标准输出')
    args = parser.parse_args()

    target = os.path.abspath(args.target)
    files = []
    if os.path.isdir(target):
        for dirpath, dirnames, filenames in os.walk(target):
            dirnames[:] = sorted(dirnames)
            for name in sorted(filenames):
                if name.lower().endswith('.swf'):
                    files.append(os.path.join(dirpath, name))
    else:
        files = [target]

    if not files:
        print('未找到 .swf 文件: %s' % target, file=sys.stderr)
        return 1

    results = [inspect(f) for f in files]
    payload = {
        'analysisType': 'swf-header-static-only',
        'root': target,
        'count': len(results),
        'files': results,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.output:
        with open(args.output, 'w', encoding='utf-8') as fh:
            fh.write(text + '\n')
        print('已写入 %s（%d 个 SWF）' % (args.output, len(results)))
    else:
        print(text)
    return 0


if __name__ == '__main__':
    sys.exit(main())
