import test from 'node:test';
import assert from 'node:assert/strict';
import {createHero, stepHero, HERO, DT} from '../adapters/shanyi-native/sim.mjs';

const ground = [{x: 0, y: 400, w: 800, h: 40}];
const wall = [{x: 600, y: 300, w: 20, h: 100}];
const idle = {left: false, right: false, jump: false};
const run = over => ({...idle, ...over});

test('向右走会推动箱子', () => {
  const hero = createHero(100, 400 - HERO.height);
  const box = {x: 180, y: 400 - 40, w: 40, h: 40};
  for (let i = 0; i < 120; i++) stepHero(hero, ground, run({right: true}), DT, [box]);
  assert.ok(box.x > 200, '箱子应被推动，实际 ' + box.x);
  assert.ok(hero.x + HERO.width <= box.x + 1, '英雄应贴在箱子左侧');
});

test('箱子顶到墙后英雄被挡住', () => {
  const hero = createHero(500, 400 - HERO.height);
  const box = {x: 540, y: 400 - 40, w: 40, h: 40};
  for (let i = 0; i < 240; i++) stepHero(hero, [...ground, ...wall], run({right: true}), DT, [box]);
  assert.ok(box.x + box.w <= 600 + 1, '箱子不能穿墙');
  assert.ok(hero.x + HERO.width <= box.x + 1, '英雄不能穿箱');
});
