#!/usr/bin/env python3
"""Inject AVM1 action bytes into a specific frame's DoAction tag.

The original Bomb It SWF keeps all menus on the main timeline. FFDec's
`-replace` does not accept main-timeline script names, so we edit the
DoAction tag payload directly: append actions just before ActionEnd.

Usage:
  python tools/swf-actions.py inspect game.swf
  python tools/swf-actions.py append game.swf out.swf 3 skip-menu
"""
import struct
import sys
import zlib

# ---- AVM1 action builders -------------------------------------------------

def push_string(value):
    data = value.encode('utf-8') + b'\x00'
    payload = bytes([0x00]) + data
    return bytes([0x96]) + struct.pack('<H', len(payload)) + payload

def push_int(value):
    payload = bytes([0x07]) + struct.pack('<I', value & 0xFFFFFFFF)
    return bytes([0x96]) + struct.pack('<H', len(payload)) + payload

def push_bool(value):
    payload = bytes([0x05, 1 if value else 0])
    return bytes([0x96]) + struct.pack('<H', len(payload)) + payload

SET_VARIABLE = b'\x1d'

def goto_frame2(from_stack=True, stop=True):
    flags = (0x01 if from_stack else 0) | (0x02 if stop else 0)
    return bytes([0x9F, 0x01, flags])

ACTION_END = b'\x00'

def action_block(kind):
    """Return the action bytes appended to a frame's DoAction tag."""
    if kind == 'skip-menu':
        # totalPlayer = 2; varHard = "normal"; gotoAndStop("select");
        return (
            push_string('normal') + push_string('varHard') + SET_VARIABLE +
            push_int(2) + push_string('totalPlayer') + SET_VARIABLE +
            push_string('select') + goto_frame2()
        )
    if kind == 'enter-game':
        # gotoAndStop("game");
        return push_string('game') + goto_frame2()
    raise SystemExit('unknown block: ' + kind)

# ---- SWF parsing ----------------------------------------------------------

def read_swf(path):
    raw = open(path, 'rb').read()
    signature = raw[:3]
    version = raw[3]
    file_length = struct.unpack('<I', raw[4:8])[0]
    if signature == b'CWS':
        body = zlib.decompress(raw[8:])
    elif signature == b'FWS':
        body = raw[8:]
    else:
        raise SystemExit('unsupported SWF signature: ' + repr(signature))
    return signature, version, file_length, body

def rect_size(body):
    nbits = body[0] >> 3
    return 1 + (nbits * 4 + 7) // 8

def split_tags(body):
    """Return (prefix, [ (start, code, header_len, length, payload_start, payload) ])."""
    offset = rect_size(body) + 4  # RECT + frameRate + frameCount
    prefix = body[:offset]
    tags = []
    i = offset
    while i + 2 <= len(body):
        code_len = struct.unpack('<H', body[i:i + 2])[0]
        i += 2
        code = code_len >> 6
        length = code_len & 0x3F
        header = 2
        if length == 0x3F:
            length = struct.unpack('<I', body[i:i + 4])[0]
            i += 4
            header = 6
        payload_start = i
        payload = body[i:i + length]
        tags.append((i - header, code, header, length, payload_start, payload))
        i += length
        if code == 0:
            break
    return prefix, tags, i

def rebuild(body, prefix, tags, offset_end):
    out = bytearray(prefix)
    for (start, code, header, length, payload_start, payload) in tags:
        new_len = len(payload)
        if new_len >= 0x3F:
            out += struct.pack('<H', (code << 6) | 0x3F)
            out += struct.pack('<I', new_len)
        else:
            out += struct.pack('<H', (code << 6) | new_len)
        out += payload
    out += body[offset_end:]
    return bytes(out)

def inspect(path):
    _, _, _, body = read_swf(path)
    prefix, tags, _ = split_tags(body)
    frame = 1
    for (start, code, header, length, payload_start, payload) in tags:
        name = {
            1: 'ShowFrame', 12: 'DoAction', 26: 'PlaceObject2', 39: 'DefineSprite',
            43: 'FrameLabel', 56: 'ExportAssets', 59: 'DoInitAction',
        }.get(code, str(code))
        if code == 43:
            label = payload[1:].split(b'\x00')[0].decode('latin1', 'replace')
            print(f'tag@frame {frame}: FrameLabel {label!r}')
        elif code == 12:
            print(f'tag@frame {frame}: DoAction len={length}')
        if code == 1:
            frame += 1
    return frame

def append(path, out_path, frame_target, kind):
    signature, version, _, body = read_swf(path)
    prefix, tags, offset_end = split_tags(body)
    frame = 1
    injected = False
    new_tags = []
    for tag in tags:
        (start, code, header, length, payload_start, payload) = tag
        payload = bytearray(payload)
        if code == 12 and frame == frame_target and not injected:
            if not payload.endswith(b'\x00'):
                raise SystemExit('DoAction does not end with ActionEnd')
            payload = payload[:-1] + action_block(kind) + b'\x00'
            injected = True
        new_tags.append((start, code, header, len(payload), payload_start, bytes(payload)))
        if code == 1:
            frame += 1
    if not injected:
        raise SystemExit(f'frame {frame_target} has no DoAction tag')
    new_body = rebuild(body, prefix, [(s, c, h, len(p), ps, p) for (s, c, h, l, ps, p) in new_tags], offset_end)
    # Rebuild as CWS.
    out = bytearray(b'CWS' + bytes([version]) + b'\x00\x00\x00\x00')
    out += zlib.compress(new_body, 9)
    struct.pack_into('<I', out, 4, len(out))
    open(out_path, 'wb').write(bytes(out))
    print(f'wrote {out_path}: frame {frame_target} += {kind}, size {len(out)}')

if __name__ == '__main__':
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    command = sys.argv[1]
    if command == 'inspect':
        inspect(sys.argv[2])
    elif command == 'append':
        append(sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5])
    else:
        raise SystemExit('unknown command: ' + command)
