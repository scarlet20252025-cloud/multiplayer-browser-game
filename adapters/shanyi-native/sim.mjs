/**
 * 闪翼双星：原生固定步长模拟（第一版，不依赖 SWF）。
 *
 * 这一版只做两名角色的平台物理与地形碰撞，参数取自原版观测值，后面要用
 * 黄金轨迹逐帧校正。设计约束：
 * - 固定 60 Hz，只吃「这一 tick 的输入」，不读 wall clock；
 * - 碰撞体是关卡导出的 AABB 列表；
 * - 跳跃是边沿触发，支持二段跳（原版冰娃能力）。
 */
export const TICK_HZ = 60;
export const DT = 1 / TICK_HZ;

export const HERO = Object.freeze({
  width: 22,
  height: 34,
  runSpeed: 210,
  accel: 2400,
  airAccel: 1500,
  friction: 2600,
  gravity: 1900,
  maxFall: 1200,
  jumpSpeed: 620,
  doubleJumpSpeed: 540,
});

export function createHero(x, y) {
  return {x, y, vx: 0, vy: 0, w: HERO.width, h: HERO.height,
    onGround: false, jumps: 0, facing: 1, jumpHeld: false};
}

const overlaps = (a, b) =>
  a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

function moveAxis(hero, solids, dx, dy) {
  hero.x += dx;
  for (const solid of solids) {
    if (!overlaps(hero, solid)) continue;
    if (dx > 0) hero.x = solid.x - hero.w;
    else if (dx < 0) hero.x = solid.x + solid.w;
    hero.vx = 0;
  }
  hero.y += dy;
  hero.onGround = false;
  for (const solid of solids) {
    if (!overlaps(hero, solid)) continue;
    if (dy > 0) {
      hero.y = solid.y - hero.h;
      hero.vy = 0;
      hero.onGround = true;
      hero.jumps = 0;
    } else if (dy < 0) {
      hero.y = solid.y + solid.h;
      hero.vy = 0;
    }
  }
}

/**
 * 箱子推动：英雄水平挤到箱子时把箱子按重叠量顶开，箱子再和地形求解，
 * 顶不动就反过来把英雄挡回去（贴住箱面）。
 */
export function pushBoxes(hero, boxes, solids, fromX) {
  for (const box of boxes) {
    if (!overlaps(hero, box)) continue;
    const dir = hero.x > fromX ? 1 : hero.x < fromX ? -1 : 0;
    if (!dir) continue;
    const overlap = dir > 0
      ? hero.x + hero.w - box.x
      : box.x + box.w - hero.x;
    if (overlap <= 0) continue;
    const nextX = box.x + dir * overlap;
    const moved = {...box, x: nextX};
    const blocked = solids.some(s => overlaps(moved, s)) || boxes.some(b => b !== box && overlaps(moved, b));
    if (blocked) {
      hero.x = dir > 0 ? box.x - hero.w : box.x + box.w;
      hero.vx = 0;
    } else {
      box.x = nextX;
    }
  }
}

export function stepHero(hero, solids, input, dt = DT, boxes = null) {
  const axis = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (axis) {
    hero.facing = axis;
    const accel = hero.onGround ? HERO.accel : HERO.airAccel;
    hero.vx += axis * accel * dt;
    hero.vx = Math.max(-HERO.runSpeed, Math.min(HERO.runSpeed, hero.vx));
  } else if (hero.onGround) {
    const drop = HERO.friction * dt;
    hero.vx = Math.abs(hero.vx) <= drop ? 0 : hero.vx - Math.sign(hero.vx) * drop;
  }

  const jumpPressed = input.jump && !hero.jumpHeld;
  hero.jumpHeld = Boolean(input.jump);
  if (jumpPressed) {
    if (hero.onGround || hero.jumps === 0) {
      hero.vy = -HERO.jumpSpeed;
      hero.jumps = 1;
      hero.onGround = false;
    } else if (hero.jumps === 1) {
      hero.vy = -HERO.doubleJumpSpeed;
      hero.jumps = 2;
    }
  }

  hero.vy = Math.min(HERO.maxFall, hero.vy + HERO.gravity * dt);
  const beforeX = hero.x;
  moveAxis(hero, solids, hero.vx * dt, 0);
  if (boxes) pushBoxes(hero, boxes, solids, beforeX);
  moveAxis(hero, solids, 0, hero.vy * dt);
  return hero;
}
