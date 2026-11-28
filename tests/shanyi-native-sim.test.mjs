import test from 'node:test';
import assert from 'node:assert/strict';
import {createHero, stepHero, HERO, DT} from '../adapters/shanyi-native/sim.mjs';

const solids = [
  {x: 0, y: 400, w: 600, h: 40},      // 地面
  {x: 300, y: 300, w: 60, h: 20},     // 平台
  {x: 600, y: 380, w: 20, h: 60},     // 右侧墙
];

const idle = {left: false, right: false, jump: false};
const run = overrides => ({...idle, ...overrides});

function simulate(hero, input, ticks, heroStep = stepHero) {
  for (let i = 0; i < ticks; i++) heroStep(hero, solids, input, DT);
  return hero;
}

test('人物会落到地面上并停住', () => {
  const hero = createHero(100, 200);
  simulate(hero, idle, 120);
  assert.equal(hero.onGround, true);
  assert.ok(Math.abs(hero.y + HERO.height - 400) < 1, '脚应贴在地面 y=400');
  assert.equal(hero.vy, 0);
});

test('按右能持续加速到上限，松手会摩擦停下', () => {
  const hero = createHero(100, 300);
  simulate(hero, run({right: true}), 60);
  assert.ok(hero.x > 110, '一秒内应明显右移');
  assert.ok(hero.vx <= HERO.runSpeed + 1e-6);
  const speed = hero.vx;
  assert.ok(speed > HERO.runSpeed * 0.8);
  simulate(hero, idle, 30);
  assert.equal(hero.vx, 0, '松手后地面摩擦应把速度归零');
});

test('跳跃离地、到顶后回落，且只跳一次', () => {
  const hero = createHero(100, 300);
  simulate(hero, idle, 90);
  const groundY = hero.y;
  hero.jumpHeld = false;
  simulate(hero, run({jump: true}), 6);
  assert.ok(hero.vy < 0, '按下跳跃后应有向上速度');
  assert.ok(hero.y < groundY, '应离开地面');
  simulate(hero, idle, 90);
  assert.equal(hero.onGround, true, '最终应落回地面');
});

test('二段跳：空中再按一次能再抬升，第三次无效', () => {
  const hero = createHero(100, 300);
  simulate(hero, idle, 90);
  hero.jumpHeld = false;
  simulate(hero, run({jump: true}), 4);
  simulate(hero, idle, 6);
  const beforeDouble = hero.y;
  hero.jumpHeld = false;
  simulate(hero, run({jump: true}), 4);
  assert.ok(hero.y < beforeDouble, '二段跳应继续上升');
  hero.vy = 0;
  hero.jumpHeld = false;
  simulate(hero, run({jump: true}), 2);
  assert.ok(hero.vy >= 0, '第三段跳不应再给向上速度');
});

test('落地后跳跃次数会重置', () => {
  const hero = createHero(100, 300);
  simulate(hero, idle, 90);
  assert.equal(hero.jumps, 0);
  assert.equal(hero.onGround, true);
});

test('水平移动会被平台侧面挡住', () => {
  const hero = createHero(400, 400 - HERO.height);
  simulate(hero, run({right: true}), 240);
  assert.ok(hero.x + HERO.width <= 600 + 1, '应停在地面右端的墙前');
});

test('不会穿过地面（60Hz 下不隧穿）', () => {
  const hero = createHero(100, 300);
  hero.vy = 5000;
  simulate(hero, idle, 10);
  assert.ok(hero.y + HERO.height <= 401);
});
