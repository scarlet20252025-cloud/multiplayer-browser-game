"""Tests use tiny original fixtures, never bundled commercial game maps."""
import hashlib
import importlib.util
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts' / 'audit_fireboy.py'
SPEC = importlib.util.spec_from_file_location('audit_fireboy', SCRIPT)
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)


def fixture(extra_factory='', tile='0', duplicate=False):
    # Coordinates and maps here are deliberately invented test data.
    a = f'''if(param2 == 1) {{
        LevelArray = new Array(new Array(1,{tile},1),new Array(1,_loc6_,1));
        CreateGround(LevelArray);
        StartPosFire = new b2Vec2(1,2);
        StartPosWater = new b2Vec2(3,4);
        CreateFinish(new b2Vec2(5,6),new b2Vec2(7,8));
        CreateMovingBox(new b2Vec2(2,3),new b2Vec2(0.5,0.5));
        {extra_factory}
    }}'''
    return '''public var m_timeStep:Number = 1 / 26;
    public var m_iterations:int = 50;
    _loc4_ = new b2Vec2(0,26);
    _loc6_ = "bd"; _loc7_ = "rd"; _loc8_ = "gr";
    if(param1 == "adventure") {''' + a + (a if duplicate else '') + '''}
    else if(param1 == "test") {
       LevelArray = new Array(new Array(1,0,1),new Array(1,1,1));
       StartPosFire = new b2Vec2(1,1);
       StartPosWater = new b2Vec2(2,1);
       CreateFinish(new b2Vec2(1,0),new b2Vec2(2,0));
    }
    '''


class LiteralTests(unittest.TestCase):
    def test_nested_data_and_vector(self):
        result = audit.LiteralParser('new Array(new Array(-1,0,1), _loc7_, true, new b2Vec2(2.5,-3))').parse()
        self.assertEqual(result, [[-1,0,1], 'rd', True, {'x':2.5,'y':-3}])

    def test_rejects_execution_and_unknown_constructors(self):
        for expr in ['Math.random()', '__import__("os")', 'new Evil(1,2)',
                     'new Array(1,2); run()', 'new Array(1,2).pop()', 'unknown']:
            with self.subTest(expr=expr), self.assertRaises(ValueError):
                audit.LiteralParser(expr).parse()

    def test_rejects_ambiguous_array_length_constructor(self):
        with self.assertRaises(ValueError):
            audit.LiteralParser('new Array(3)').parse()

    def test_rejects_malformed_data(self):
        for expr in ['new Array(1,2', 'new Array(1,,2)', 'new b2Vec2(true,2)', '']:
            with self.subTest(expr=expr), self.assertRaises(ValueError):
                audit.LiteralParser(expr).parse()

    def test_string_does_not_execute(self):
        self.assertEqual(audit.LiteralParser('"new Evil(1,2)"').parse(), 'new Evil(1,2)')


class ExtractTests(unittest.TestCase):
    def run_extract(self, text, include_test=False):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / 'level.as'
            p.write_text(text, encoding='utf-8')
            (Path(d)/'Game.as').write_text('[SWF(width="1",frameRate="25")]', encoding='utf-8')
            return audit.extract(p, include_test)

    def test_layout_provenance_and_test_map_exclusion(self):
        text = fixture()
        result = self.run_extract(text)
        self.assertEqual(len(result['levels']), 1)
        self.assertEqual(result['provenance']['excludedTestLevels'], 1)
        self.assertEqual(result['provenance']['parsedLevelBlocks'], 2)
        self.assertEqual(result['sourceSha256'], hashlib.sha256(text.encode()).hexdigest())
        level = result['levels'][0]
        self.assertEqual((level['width'], level['height']), (3,2))
        self.assertEqual(level['spawns']['water'], {'x':3,'y':4})
        self.assertEqual(level['exits']['fire'], {'x':5,'y':6})
        self.assertEqual(level['tiles'][1][1], 'bd')
        self.assertEqual(level['unsupported'], [])
        finish_line = next(i for i, line in enumerate(text.splitlines(), 1) if 'CreateFinish' in line)
        self.assertEqual(level['factories'][0]['sourceLine'], finish_line)
        self.assertEqual(result['gameParameters']['physicsTimeStep'], 1/26)
        self.assertEqual(result['gameParameters']['stageFps'], 25)

    def test_include_developer_map(self):
        result = self.run_extract(fixture(), True)
        self.assertEqual([x['id'] for x in result['levels']], ['adventure-1', 'test-0'])

    def test_unknown_factory_and_expression_are_reported(self):
        result = self.run_extract(fixture('CreateUnknownThing(new b2Vec2(1,2), Math.random());'))
        notes = result['levels'][0]['unsupported']
        self.assertIn('factory-expression', {x['kind'] for x in notes})
        self.assertIn('factory-name', {x['kind'] for x in notes})

    def test_unknown_tile_is_not_assumed_to_be_a_wall(self):
        result = self.run_extract(fixture(tile='987'))
        self.assertEqual(result['levels'][0]['tiles'][0][1], 987)
        self.assertIn({'kind':'tile-code','value':'987'}, result['levels'][0]['unsupported'])

    def test_duplicate_levels_fail(self):
        with self.assertRaises(ValueError):
            self.run_extract(fixture(duplicate=True))

    def test_nonrectangular_matrix_fails(self):
        text = fixture().replace('new Array(1,_loc6_,1)', 'new Array(1,_loc6_)')
        with self.assertRaises(ValueError):
            self.run_extract(text)

    def test_empty_matrix_fails(self):
        text = fixture().replace('new Array(new Array(1,0,1),new Array(1,_loc6_,1))', 'new Array()')
        with self.assertRaises(ValueError):
            self.run_extract(text)

    def test_unrecognized_source_fails(self):
        with self.assertRaises(ValueError):
            self.run_extract('package { public class unrelated {} }')


if __name__ == '__main__':
    unittest.main()
