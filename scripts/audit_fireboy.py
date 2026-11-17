#!/usr/bin/env python3
"""Read data literals from the supplied FBWG1 decompilation; never execute AS3.

Generated level data remains third-party input and is not a runnable game.
"""
from __future__ import annotations

import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import re


TOKEN = re.compile(r'\s*(?:(-?(?:\d+(?:\.\d*)?|\.\d+))|("(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z_0-9]*)|([(),]))')
CONSTANTS = {"_loc6_": "bd", "_loc7_": "rd", "_loc8_": "gr", "true": True, "false": False}
KNOWN_FACTORIES = {'CreateFinish', 'CreateSlidePlatform', 'CreateLever', 'CreatePusher',
                   'CreateMovingBox', 'CreateBall', 'CreatePulley', 'CreateHangingPlatform',
                   'CreateRotPlatform', 'CreateWind', 'CreateJumper', 'CreatRoman'}

# These are manually checked semantics from CreateGround, not HTML5 Tiled GIDs.
# Shapes for pools include sensors AND solid geometry; the labels are not a
# replacement for the original Box2D fixture definitions.
GROUND_SEMANTICS = {
    '0': {'kind': 'empty', 'evidence': 'CreateGround: no matching creation branch'},
    '1': {'kind': 'solid-square', 'evidence': 'CreateGround: == 1; SetAsOrientedBox'},
    '-1': {'kind': 'solid-triangle', 'vertices': [[-.5,.5],[-.5,-.5],[.5,.5]],
           'evidence': 'CreateGround: == -1; vertices[0..2].Set'},
    '-2': {'kind': 'solid-triangle', 'vertices': [[-.5,.5],[.5,-.5],[.5,.5]],
           'evidence': 'CreateGround: == -2; vertices[0..2].Set'},
    '-3': {'kind': 'solid-triangle', 'vertices': [[-.5,-.5],[.5,-.5],[.5,.5]],
           'evidence': 'CreateGround: == -3; vertices[0..2].Set'},
    '-4': {'kind': 'solid-triangle', 'vertices': [[-.5,-.5],[.5,-.5],[-.5,.5]],
           'evidence': 'CreateGround: == -4; vertices[0..2].Set'},
    'bd': {'kind': 'blue-diamond', 'evidence': 'CreateGround: == "bd"; BlueDiamond'},
    'rd': {'kind': 'red-diamond', 'evidence': 'CreateGround: == "rd"; RedDiamond'},
    'gr': {'kind': 'shared-diamond', 'evidence': 'CreateGround: == "gr"; SilverDiamond'},
}
for _family, _base in [('water', 5), ('fire', 6), ('black', 7)]:
    for _code, _part in [(_base, 'middle'), (_base*10+1, 'left-end'), (_base*10+2, 'right-end')]:
        GROUND_SEMANTICS[str(_code)] = {
            'kind': 'pool', 'hazard': _family, 'part': _part,
            'evidence': f'CreateGround: == {_code}; userData = "{_family}"; sensor plus solid fixtures',
        }


class LiteralParser:
    def __init__(self, text: str):
        self.tokens: list[tuple[str, str]] = []
        pos = 0
        while text[pos:].strip():
            match = TOKEN.match(text, pos)
            if match is None:
                raise ValueError(f"Unsupported AS3 expression near {text[pos:pos+40]!r}")
            kind = next(i for i, val in enumerate(match.groups()) if val is not None)
            self.tokens.append((('number', 'string', 'identifier', 'punctuation')[kind], match.group(kind+1)))
            pos = match.end()
        self.pos = 0

    def pop(self, expected=None):
        if self.pos >= len(self.tokens):
            raise ValueError("Unexpected end of data expression")
        tok = self.tokens[self.pos]
        self.pos += 1
        if expected is not None and tok[1] != expected:
            raise ValueError(f"Expected {expected!r}, got {tok!r}")
        return tok

    def value(self):
        kind, token = self.pop()
        if kind == 'number':
            return float(token) if '.' in token else int(token)
        if kind == 'string':
            return json.loads(token)
        if kind == 'identifier' and token in CONSTANTS:
            return CONSTANTS[token]
        if token == 'new':
            _, constructor = self.pop()
            if constructor not in ('Array', 'b2Vec2'):
                raise ValueError(f"Constructor not allowed: {constructor}")
            self.pop('(')
            args = []
            if self.pos < len(self.tokens) and self.tokens[self.pos][1] != ')':
                while True:
                    args.append(self.value())
                    if self.pos >= len(self.tokens):
                        raise ValueError('Unclosed constructor arguments')
                    if self.tokens[self.pos][1] != ',':
                        break
                    self.pop(',')
            self.pop(')')
            if constructor == 'Array':
                if len(args) == 1 and type(args[0]) in (int, float):
                    raise ValueError('Single numeric Array argument is an AS3 length constructor, not a data list')
                return args
            if len(args) != 2 or not all(type(x) in (int, float) for x in args):
                raise ValueError('Invalid b2Vec2 literal')
            return {'x': args[0], 'y': args[1]}
        raise ValueError(f"Identifier not allowed: {token}")

    def parse(self):
        value = self.value()
        if self.pos != len(self.tokens):
            raise ValueError('Extra tokens after data literal')
        return value


def block(text: str, brace: int):
    depth = 0
    quoted = False
    escaped = False
    for i in range(brace, len(text)):
        c = text[i]
        if quoted:
            if escaped:
                escaped = False
            elif c == '\\':
                escaped = True
            elif c == '"':
                quoted = False
            continue
        if c == '"':
            quoted = True
        elif c == '{':
            depth += 1
        elif c == '}':
            depth -= 1
            if depth == 0:
                return text[brace+1:i], i+1
    raise ValueError('Unclosed source block')


def extract(source: Path, include_test: bool = False):
    raw = source.read_bytes()
    text = raw.decode('utf-8-sig')
    const_matches = dict(re.findall(r'(_loc[678]_)\s*=\s*"([a-z]+)";', text))
    if const_matches != {k: CONSTANTS[k] for k in ('_loc6_', '_loc7_', '_loc8_')}:
        raise ValueError(f'Unexpected tile symbol bindings: {const_matches}')
    results = []
    excluded_test_levels = 0
    parsed_blocks = 0
    for mode_match in re.finditer(r'(?:else\s+)?if\(param1 == "(puzzle|speed|adventure|test)"\)\s*\{', text):
        mode = mode_match.group(1)
        brace = text.index('{', mode_match.start())
        body, _ = block(text, brace)
        level_blocks = []
        if mode == 'test':
            level_blocks.append((0, body, brace))
        else:
            for m in re.finditer(r'if\(param2 == (\d+)\)\s*\{', body):
                local_brace = body.index('{', m.start())
                level_body, _ = block(body, local_brace)
                level_blocks.append((int(m.group(1)), level_body, brace+1+local_brace))
        for number, level_body, location in level_blocks:
            parsed_blocks += 1
            unsupported = []
            matrix = re.search(r'LevelArray\s*=\s*(new Array\(.*?);', level_body, re.S)
            if matrix is None:
                raise ValueError(f'Missing matrix in {mode}:{number}')
            tiles = LiteralParser(matrix.group(1)).parse()
            if not isinstance(tiles, list) or not tiles or not all(isinstance(row, list) for row in tiles):
                raise ValueError(f'Expected a nonempty matrix in {mode}:{number}')
            widths = {len(row) for row in tiles}
            if len(widths) != 1 or 0 in widths:
                raise ValueError(f'Nonrectangular level {mode}:{number}: {widths}')
            starts = {}
            for name, expr in re.findall(r'StartPos(Fire|Water)\s*=\s*(new b2Vec2\([^;]+);', level_body):
                starts[name.lower()] = LiteralParser(expr).parse()
            if set(starts) != {'fire', 'water'}:
                raise ValueError(f'Missing spawn in {mode}:{number}')
            recipes = []
            for call in re.finditer(r'\b(Create[A-Za-z]+|CreatRoman)\(([^;]+)\);', level_body):
                name, args = call.groups()
                if name == 'CreateGround':
                    continue
                recipe = {'factory': name, 'sourceLine': text.count('\n', 0, location+1+call.start())+1}
                try:
                    recipe['arguments'] = LiteralParser('new Array('+args+')').parse()
                except ValueError as exc:
                    recipe['unsupported'] = str(exc)
                    recipe['rawArguments'] = args
                    unsupported.append({'kind': 'factory-expression', 'factory': name, 'reason': str(exc)})
                if name not in KNOWN_FACTORIES:
                    recipe['unsupportedFactory'] = True
                    unsupported.append({'kind': 'factory-name', 'factory': name})
                recipes.append(recipe)
            values = {str(value) for row in tiles for value in row}
            for value in sorted(values - set(GROUND_SEMANTICS)):
                unsupported.append({'kind': 'tile-code', 'value': value})
            finishes = [f.get('arguments') for f in recipes if f['factory'] == 'CreateFinish']
            if len(finishes) != 1 or not isinstance(finishes[0], list) or len(finishes[0]) != 2:
                unsupported.append({'kind': 'finish-layout', 'reason': 'Expected one CreateFinish with two positions'})
            exits = {'fire': finishes[0][0], 'water': finishes[0][1]} if len(finishes) == 1 and isinstance(finishes[0], list) and len(finishes[0]) == 2 else None
            if mode == 'test' and not include_test:
                excluded_test_levels += 1
                continue
            results.append({'id': f'{mode}-{number}', 'mode': mode, 'number': number,
                            'sourceLine': text.count('\n', 0, location)+1,
                            'width': next(iter(widths)), 'height': len(tiles),
                            'spawns': starts, 'exits': exits, 'tiles': tiles, 'factories': recipes,
                            'unsupported': unsupported})
    ids = [x['id'] for x in results]
    if len(ids) != len(set(ids)):
        raise ValueError('Duplicate level identifiers')
    if not results:
        raise ValueError('No supported level blocks were found')
    timestep = re.search(r'm_timeStep:Number\s*=\s*(\d+)\s*/\s*(\d+)\s*;', text)
    iterations = re.search(r'm_iterations:int\s*=\s*(\d+)\s*;', text)
    gravity = re.search(r'_loc4_\s*=\s*new b2Vec2\(([-\d.]+),([-\d.]+)\);', text)
    game_path = source.parent/'Game.as'
    game_text = game_path.read_text(encoding='utf-8-sig') if game_path.exists() else ''
    fps = re.search(r'frameRate="(\d+)"', game_text)
    return {'format': 'fbwg1-as3-data-probe-v1', 'sourceSha256': hashlib.sha256(raw).hexdigest(),
            'sourceFile': source.name, 'status': 'extracted-data-only-not-a-game-runtime',
            'provenance': {'sourceEncoding': 'utf-8', 'parser': 'restricted literals; no AS3 execution',
                           'parsedLevelBlocks': parsed_blocks, 'excludedTestLevels': excluded_test_levels,
                           'gameSourceSha256': hashlib.sha256(game_path.read_bytes()).hexdigest() if game_path.exists() else None},
            'gameParameters': {'stageFps': int(fps.group(1)) if fps else None,
                               'physicsTimeStep': int(timestep.group(1))/int(timestep.group(2)) if timestep else None,
                               'physicsTimeStepFraction': {'numerator': int(timestep.group(1)), 'denominator': int(timestep.group(2))} if timestep else None,
                               'physicsIterations': int(iterations.group(1)) if iterations else None,
                               'gravity': {'x': float(gravity.group(1)), 'y': float(gravity.group(2))} if gravity else None,
                               'pixelsPerPhysicsUnit': 20 if 'GetPosition().x * 20' in text else None},
            'coordinateNotes': {'tiles': 'Row-major matrix; indices are not rendered pixels',
                                'spawns': 'AS3 StartPosFire / StartPosWater vectors, in physics units',
                                'exits': 'CreateFinish input vectors, not final Box2D body centers; original factory adds 0.66 to y',
                                'factories': 'Unmodified constructor arguments; factories themselves are not executed'},
            'groundSemantics': GROUND_SEMANTICS,
            'limitations': ['Not a Flash compiler or a game runtime',
                            'Factory argument extraction does not implement Box2D fixtures or mechanics',
                            'HTML5 Tiled GIDs are not interpreted',
                            'Ground semantics were audited for the supplied FBWG1 source; review other revisions'],
            'levels': results}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--include-test', action='store_true', help='Include the separate developer test map')
    args = parser.parse_args()
    result = extract(args.source, args.include_test)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'output': str(args.output), 'levels': len(result['levels']),
                      'modes': dict(Counter(x['mode'] for x in result['levels'])),
                      'dimensions': sorted({(x['width'], x['height']) for x in result['levels']}),
                      'excludedTestLevels': result['provenance']['excludedTestLevels'],
                      'factoryCalls': sum(len(x['factories']) for x in result['levels']),
                      'unsupported': sum(len(x['unsupported']) for x in result['levels']),
                      'sourceSha256': result['sourceSha256']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
