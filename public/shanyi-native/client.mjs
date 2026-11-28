/**
 * 原生渲染客户端：只读关卡 JSON + 本地模拟，不依赖 SWF/Ruffle。
 * 这一版是「能看能走」的验证壳：两个角色、地形、箱子、相机跟随。
 */
import {createHero, stepHero, DT, HERO} from '/adapters/shanyi-native/sim.mjs';

const canvas = document.getElementById('stage');
const ctx = canvas.getContext('2d');
const level = await fetch('./level-1.json').then(r => r.json());
const solids = level.solids.filter(s => s.layer === 'ground');
const boxes = level.solids.filter(s => s.layer === 'box').map(s => ({...s}));

const originX = level.origin?.[0] ?? 0;
const spawn = {x: originX + 120, y: -120};
const players = [
  {hero: createHero(spawn.x, spawn.y), keys: {left: 'KeyA', right: 'KeyD', jump: 'KeyW'}, color: '#ff7a59', name: 'P1'},
  {hero: createHero(spawn.x + 40, spawn.y), keys: {left: 'ArrowLeft', right: 'ArrowRight', jump: 'ArrowUp'}, color: '#59b4ff', name: 'P2'},
];

const held = new Set();
addEventListener('keydown', e => { held.add(e.code); if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) e.preventDefault(); });
addEventListener('keyup', e => held.delete(e.code));
addEventListener('blur', () => held.clear());

let camera = {x: spawn.x - 480, y: 0};
let last = performance.now();
let acc = 0;

function frame(now) {
  const dtReal = Math.min(0.1, (now - last) / 1000);
  last = now;
  acc += dtReal;
  while (acc >= DT) {
    for (const p of players) {
      const input = {
        left: held.has(p.keys.left),
        right: held.has(p.keys.right),
        jump: held.has(p.keys.jump),
      };
      stepHero(p.hero, solids, input, DT, boxes);
    }
    acc -= DT;
  }
  const focus = players[0].hero;
  camera.x += (focus.x - 480 - camera.x) * Math.min(1, dtReal * 6);
  draw();
  requestAnimationFrame(frame);
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const scale = 1;
  ctx.save();
  ctx.translate(-Math.round(camera.x) * scale, 0);
  // 地形条带
  for (const s of solids) {
    ctx.fillStyle = '#2f5d3a';
    ctx.fillRect(s.x * scale, s.y * scale + 120, s.w * scale, s.h * scale);
  }
  // 箱子
  for (const b of boxes) {
    ctx.fillStyle = '#b07a3c';
    ctx.fillRect(b.x * scale, b.y * scale + 120, b.w * scale, b.h * scale);
  }
  // 角色
  for (const p of players) {
    const h = p.hero;
    ctx.fillStyle = p.color;
    ctx.fillRect(h.x * scale, h.y * scale + 120, h.w * scale, h.h * scale);
    ctx.fillStyle = 'rgba(0,0,0,.5)';
    ctx.fillRect(h.x * scale, h.y * scale + 120, h.w * scale, 3);
  }
  ctx.restore();
  ctx.fillStyle = '#9fb0c3';
  ctx.font = '12px monospace';
  ctx.fillText(`P1 x=${players[0].hero.x.toFixed(0)} y=${players[0].hero.y.toFixed(0)} onGround=${players[0].hero.onGround}`, 12, canvas.height - 12);
}

requestAnimationFrame(frame);
window.__native = {players, level, boxes};
