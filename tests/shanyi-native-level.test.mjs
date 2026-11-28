import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHero, stepHero, DT} from '../adapters/shanyi-native/sim.mjs';

const level = JSON.parse(readFileSync(new URL('../public/shanyi-native/level-1.json', import.meta.url), 'utf8'));
const solids = level.solids;
const idle = {left: false, right: false, jump: false};

function run(hero, input, ticks) {
  for (let i = 0; i < ticks; i++) stepHero(hero, solids, input, DT);
  return hero;
}

test('导出的关卡包含地面条带和箱子', () => {
  assert.ok(level.solids.length > 50, 'should have many ground strips');
  assert.ok(level.solids.some(r => r.layer === 'ground'));
  assert.ok(level.width > 1500);
});

test('从空中落下会停在地面上，不会穿到关卡底部', () => {
  const hero = createHero(level.origin[0] + 120, -200);
  run(hero, idle, 240);
  assert.equal(hero.onGround, true);
  assert.ok(hero.y > -50, 'should land inside the level, not fall through');
});

test('按住右能在关卡里持续前进并停在某个地貌上', () => {
  const hero = createHero(level.origin[0] + 40, -120);
  run(hero, idle, 120);
  const startX = hero.x;
  run(hero, {...idle, right: true}, 600);
  assert.ok(hero.x > startX + 150, 'should travel right along the ground');
  assert.ok(Number.isFinite(hero.y));
});
