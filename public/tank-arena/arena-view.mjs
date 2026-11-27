import {COLORS, MIN_PLAYERS, PULSE_CHARGE_SECONDS, SUPPLIES, arenaFor, randomFrom} from './rules.mjs';
import {laserPath, shellAimPath} from './laser-path.mjs';

const TAU = Math.PI * 2;
const TRACK_LIFETIME = 2400;
const TRACK_SPACING = 8;
const TREAD_PITCH = 5;
const EXHAUST_LIFETIME = 420;
const BEAM_COLOR = SUPPLIES.beam?.color ?? '#f88fc8';
const PROJECTILES = Object.freeze({
  shell: {trail: 10, width: 2.5, radius: 3.8},
  pulse: {trail: 24, width: 4, radius: 4},
  scatter: {trail: 8, width: 2, radius: 2.8},
  burst: {trail: 15, width: 2, radius: 3.2},
  cluster: {trail: 12, width: 3.4},
  guide: {color: '#7ed5ff'},
});
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mix = (a, b, t) => a + (b - a) * t;
const turnDelta = (from, to) => Math.atan2(Math.sin(to - from), Math.cos(to - from));
const colorFor = seat => COLORS[seat] ?? '#fff5dd';
const tankPaint = [
  ['#087d7d', '#28b994', '#a4edd5', '#135864'],
  ['#bb431d', '#f17a29', '#ffbf65', '#843322'],
  ['#6540ad', '#9c71de', '#d4bbff', '#513675'],
  ['#a5366b', '#e867a1', '#ffc0d9', '#773353'],
  ['#176cac', '#46a1e4', '#b3e4ff', '#1b4f76'],
  ['#557b24', '#91b73d', '#e2ef87', '#3c561b'],
];
const isRocket = kind => kind === 'seeker' || kind === 'guide';
const isPulseCannon = shot => shot.kind === 'pulse' && shot.path?.length === 2 &&
  shot.width > 0 && Number.isFinite(shot.lifeRemaining);

function circle(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
}

function star(ctx, x, y, radius) {
  ctx.beginPath();
  for (let tip = 0; tip < 10; tip++) {
    const a = tip * Math.PI / 5 - Math.PI / 2;
    const r = tip % 2 ? radius * .53 : radius;
    const point = [x + Math.cos(a) * r, y + Math.sin(a) * r];
    if (tip === 0) ctx.moveTo(...point);
    else ctx.lineTo(...point);
  }
  ctx.closePath();
}

function paintWalls(ctx, {walls, width, height}) {
  const solid = new Path2D();
  for (const {x, y, w, h} of walls) solid.rect(x, y, w, h);

  // Only trace edges that border open floor, including at elbows and T junctions.
  const xs = [...new Set(walls.flatMap(({x, w}) => [x, x + w]))].sort((a, b) => a - b);
  const ys = [...new Set(walls.flatMap(({y, h}) => [y, y + h]))].sort((a, b) => a - b);
  const occupied = ys.slice(0, -1).map((y, row) => xs.slice(0, -1).map((x, col) => {
    const cx = (x + xs[col + 1]) / 2;
    const cy = (y + ys[row + 1]) / 2;
    return walls.some(wall => cx > wall.x && cx < wall.x + wall.w &&
      cy > wall.y && cy < wall.y + wall.h);
  }));
  const passages = new Path2D();
  const light = new Path2D();
  const dark = new Path2D();
  const segment = (path, x1, y1, x2, y2) => {
    path.moveTo(x1, y1);
    path.lineTo(x2, y2);
  };
  for (let row = 0; row < occupied.length; row++) {
    for (let col = 0; col < occupied[row].length; col++) {
      const [x, right] = [xs[col], xs[col + 1]];
      const [y, bottom] = [ys[row], ys[row + 1]];
      if (!occupied[row][col]) {
        passages.rect(x, y, right - x, bottom - y);
        continue;
      }
      if (!occupied[row - 1]?.[col]) segment(light, x, y, right, y);
      if (!occupied[row][col - 1]) segment(light, x, y, x, bottom);
      if (!occupied[row + 1]?.[col]) segment(dark, x, bottom, right, bottom);
      if (!occupied[row][col + 1]) segment(dark, right, y, right, bottom);
    }
  }

  ctx.save();
  ctx.translate(1, 3);
  ctx.shadowColor = '#78474699';
  ctx.shadowBlur = 5;
  ctx.fillStyle = '#65415745';
  ctx.fill(solid);
  ctx.restore();

  const surface = ctx.createLinearGradient(0, 0, width, height);
  surface.addColorStop(0, '#83e0d8');
  surface.addColorStop(.58, '#55bcba');
  surface.addColorStop(1, '#379897');
  ctx.fillStyle = surface;
  ctx.fill(solid);

  ctx.save();
  ctx.clip(solid);
  ctx.lineCap = 'round';
  ctx.lineWidth = 6;
  ctx.strokeStyle = '#246482';
  ctx.stroke(dark);
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#d7fff0';
  ctx.stroke(light);

  for (const {x, y, w, h} of walls) {
    const horizontal = w >= h;
    const length = horizontal ? w : h;
    const thickness = Math.min(w, h);
    if (length < 43 || thickness > 26) continue;
    ctx.save();
    ctx.translate(horizontal ? x : x + w, y);
    if (!horizontal) ctx.rotate(Math.PI / 2);
    const count = Math.max(1, Math.floor(length / 39));
    const stride = length / count;
    for (let block = 1; block < count; block++) {
      const at = block * stride;
      ctx.beginPath();
      ctx.moveTo(at, 2);
      ctx.lineTo(at + 1.5, thickness - 2);
      ctx.lineWidth = 1.3;
      ctx.strokeStyle = '#32889a9b';
      ctx.stroke();
      ctx.strokeStyle = '#d7fff294';
      ctx.beginPath();
      ctx.moveTo(at + 1.4, 2);
      ctx.lineTo(at + 2.9, thickness - 3);
      ctx.stroke();
    }
    for (let block = 0; block < count; block += 2) {
      const at = (block + .5) * stride;
      if (at < 18 || at > length - 18) continue;
      star(ctx, at, thickness * .46, Math.min(4.5, thickness * .32));
      ctx.lineJoin = 'round';
      ctx.lineWidth = 1.25;
      ctx.strokeStyle = '#996136';
      ctx.stroke();
      ctx.fillStyle = '#ffd578';
      ctx.fill();
    }
    ctx.restore();
  }
  ctx.restore();
  return passages;
}

function paintFloor(ctx, layout, seed) {
  const {width, height} = layout;
  const floor = ctx.createLinearGradient(0, 0, width, height);
  floor.addColorStop(0, '#e8af92');
  floor.addColorStop(.54, '#f4c09b');
  floor.addColorStop(1, '#d99c87');
  ctx.fillStyle = floor;
  ctx.fillRect(0, 0, width, height);

  const random = randomFrom(seed ^ 0x26f59c1b);
  const tileWidth = 46, tileHeight = 34;
  const shades = ['#ffe1ac38', '#9b584115', '#ffdeb016', '#db897725', '#fede9c25'];
  for (let row = 0; row * tileHeight < height; row++) {
    const y = row * tileHeight;
    for (let x = -(row % 2) * tileWidth / 2; x < width; x += tileWidth) {
      ctx.beginPath();
      ctx.roundRect(x + 1, y + 1, tileWidth - 2, tileHeight - 2, 2);
      ctx.fillStyle = shades[Math.floor(random() * shades.length)];
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#aa6a572e';
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + 2, y + tileHeight - 3);
      ctx.lineTo(x + 2, y + 3);
      ctx.lineTo(x + tileWidth - 4, y + 3);
      ctx.strokeStyle = '#ffe5ba6a';
      ctx.stroke();
      if (random() > .8) {
        ctx.fillStyle = '#fff0ca42';
        ctx.fillRect(x + 6 + random() * 22, y + 7 + random() * 17, 3.5, .9);
      }
    }
  }

  const sun = ctx.createRadialGradient(width * .3, height * .42, 0, width * .3, height * .42, width * .75);
  sun.addColorStop(0, '#fff2c652');
  sun.addColorStop(.7, '#ffe1ce00');
  sun.addColorStop(1, '#93518b25');
  ctx.fillStyle = sun;
  ctx.fillRect(0, 0, width, height);
  return paintWalls(ctx, layout);
}

function label(ctx, value, x, y, color, size = 12) {
  ctx.font = `800 ${size}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111c25';
  ctx.strokeText(value, x, y);
  ctx.fillStyle = color;
  ctx.fillText(value, x, y);
}

function paintBeacon(ctx, {x, y, radius, captureSeconds}, capture, now, relay, moveRemaining) {
  ctx.save();
  circle(ctx, x, y, radius);
  ctx.fillStyle = relay ? '#ffd97b42' : '#fff4bc28';
  ctx.fill();
  ctx.strokeStyle = relay ? '#a9574c' : '#915b63';
  ctx.lineWidth = 2;
  ctx.setLineDash(relay ? [9, 5] : [3, 7]);
  ctx.stroke();
  ctx.setLineDash([]);
  circle(ctx, x, y, relay ? 12 : 19);
  ctx.fillStyle = '#8a4e66';
  ctx.fill();
  ctx.strokeStyle = '#fff0ae';
  ctx.stroke();
  if (relay) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = '#ffdf9b';
    ctx.fillRect(-4, -4, 8, 8);
    ctx.restore();
    if (moveRemaining > 0 && moveRemaining < 3) {
      const start = -Math.PI / 2;
      ctx.beginPath();
      ctx.arc(x, y, radius + 4, start, start + TAU * moveRemaining / 3);
      ctx.strokeStyle = '#ffeac3';
      ctx.stroke();
    }
  } else {
    star(ctx, x, y, 9 + Math.sin(now / 210) * .7);
    ctx.fillStyle = '#ffd67d';
    ctx.fill();
  }

  ctx.lineCap = 'round';
  ctx.lineWidth = 4;
  const spacing = (relay ? 22 : 30) / Math.max(capture.length - 1, 1);
  capture.forEach((held, seat) => {
    if (held <= 0) return;
    const start = -Math.PI / 2;
    ctx.beginPath();
    ctx.arc(x, y, radius - 5 - spacing * seat, start, start + TAU * Math.min(held / captureSeconds, 1));
    ctx.strokeStyle = colorFor(seat);
    ctx.stroke();
  });
  ctx.restore();
}

function paintTrack(ctx, mark, now) {
  const life = 1 - (now - mark.time) / TRACK_LIFETIME;
  ctx.save();
  ctx.translate(mark.x, mark.y);
  ctx.rotate(mark.hull);
  ctx.globalAlpha = .64 * life ** 1.5;
  for (const side of [-11, 11]) {
    ctx.fillStyle = '#674238';
    ctx.beginPath();
    ctx.roundRect(-2.6, side - 3.8, 5.2, 7.6, 1.2);
    ctx.fill();
    ctx.fillStyle = '#e3aa7c';
    ctx.fillRect(-1.5, side - 2.7, 1.25, 5.4);
  }
  ctx.restore();
}

function paintTread(ctx, y, phase, [, middle, light, frame]) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(-18, y, 36, 8.6, 3.5);
  ctx.fillStyle = '#372433';
  ctx.fill();
  ctx.lineWidth = 1.2;
  ctx.strokeStyle = '#2a1928';
  ctx.stroke();
  ctx.clip();
  for (let x = -18 - TREAD_PITCH + phase; x < 18; x += TREAD_PITCH) {
    ctx.fillStyle = '#806675';
    ctx.fillRect(x, y + .55, 2.15, 7.5);
    ctx.fillStyle = '#b09097';
    ctx.fillRect(x, y < 0 ? y + .55 : y + 6.4, 2.15, 1.45);
  }
  const spoke = phase / TREAD_PITCH * Math.PI / 2;
  const spokeX = Math.cos(spoke) * 1.65, spokeY = Math.sin(spoke) * 1.65;
  for (const x of [-12, -4, 4, 12]) {
    circle(ctx, x, y + 4.35, 3);
    ctx.fillStyle = frame;
    ctx.fill();
    circle(ctx, x, y + 4.15, 2.35);
    ctx.fillStyle = middle;
    ctx.fill();
    const hub = y + 4.15;
    ctx.beginPath();
    ctx.moveTo(x - spokeX, hub - spokeY);
    ctx.lineTo(x + spokeX, hub + spokeY);
    ctx.moveTo(x + spokeY, hub - spokeX);
    ctx.lineTo(x - spokeY, hub + spokeX);
    ctx.lineWidth = .75;
    ctx.strokeStyle = light;
    ctx.stroke();
  }
  ctx.fillStyle = '#20182290';
  ctx.fillRect(-18, y + 7.4, 36, 1.3);
  ctx.restore();
}

function paintTurret(ctx, tank, [base, middle, light, frame], now) {
  const {gatlingSpin = 0, gatlingAmmo = 24, doubleSide = -1} = tank;
  const weapon = tank.pulseCharge > 0 || tank.pulseFiring ? 'pulse' : tank.weapon;
  const accent = SUPPLIES[weapon]?.color ?? middle;
  const metal = '#392a3d';
  ctx.fillStyle = metal;

  switch (weapon) {
    case 'beam':
      ctx.fillRect(4, -6, 27, 12);
      ctx.fillRect(25, -7, 9, 14);
      ctx.fillStyle = accent;
      ctx.fillRect(9, -4.5, 21, 2.6);
      ctx.fillRect(9, 1.9, 21, 2.6);
      ctx.fillRect(30, -5.5, 3.5, 11);
      ctx.fillStyle = '#fff0fa';
      ctx.fillRect(31.5, -2.5, 2.6, 5);
      break;
    case 'seeker':
    case 'guide':
      ctx.beginPath();
      ctx.roundRect(1, -6.7, 26, 13.4, [3, 2, 2, 3]);
      ctx.fill();
      ctx.fillStyle = '#829699';
      ctx.fillRect(9, -5.1, 15, 3.2);
      ctx.fillStyle = accent;
      ctx.fillRect(23, -6.7, 3.7, 13.4);
      ctx.save();
      ctx.translate(28, 0);
      paintProjectileHead(ctx, weapon, accent);
      ctx.restore();
      break;
    case 'burst': {
      ctx.fillRect(5, -7.6, 24, 15.2);
      for (let index = 0; index < 3; index++) {
        const rotation = now / 18 + index * TAU / 3;
        const y = mix((index - 1) * 5, Math.sin(rotation) * 5.6, gatlingSpin);
        ctx.fillStyle = '#9aafb4';
        ctx.fillRect(8, y - 1.25, 20, 2.5);
        ctx.fillStyle = accent;
        ctx.fillRect(27, y - 1.7, 4, 3.4);
      }
      ctx.fillStyle = metal;
      ctx.fillRect(17, -8.2, 3, 16.4);
      break;
    }
    case 'scatter':
      for (const angle of [-.27, 0, .27]) {
        ctx.save();
        ctx.translate(3, 0);
        ctx.rotate(angle);
        ctx.fillStyle = metal;
        ctx.fillRect(4, -2.8, 17, 5.6);
        ctx.fillStyle = accent;
        ctx.fillRect(10, -.95, 9, 1.9);
        ctx.fillRect(18.5, -2.3, 4, 4.6);
        ctx.restore();
      }
      break;
    case 'double':
      for (const y of [-4.2, 4.2]) {
        ctx.fillStyle = metal;
        ctx.fillRect(6, y - 2.8, 24, 5.6);
        ctx.fillStyle = Math.sign(y) === doubleSide ? accent : '#9aafb4';
        ctx.fillRect(9, y - 1.35, 20, 2.7);
        ctx.fillRect(27, y - 2.35, 3, 4.7);
      }
      break;
    case 'pulse':
      ctx.beginPath();
      ctx.roundRect(3, -7, 25, 14, 3);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(22, -9.2, 13, 18.4, 3);
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.fillRect(10, -4.8, 12, 2.2);
      ctx.fillRect(10, 2.6, 12, 2.2);
      ctx.fillRect(29, -7, 4.6, 14);
      ctx.fillStyle = '#fff4ff';
      ctx.fillRect(31.4, -5.2, 2.1, 10.4);
      break;
    case 'cluster':
      ctx.beginPath();
      ctx.moveTo(4, -6);
      ctx.lineTo(21, -7.5);
      ctx.lineTo(29, -4.5);
      ctx.lineTo(29, 4.5);
      ctx.lineTo(21, 7.5);
      ctx.lineTo(4, 6);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = accent;
      ctx.fillRect(8, -3, 16, 6);
      for (const x of [12, 16.5, 21]) {
        ctx.fillStyle = metal;
        circle(ctx, x, 0, 1.25);
        ctx.fill();
      }
      break;
    default:
      ctx.beginPath();
      ctx.roundRect(3, -4.8, weapon === 'mine' ? 15 : 23, 9.6, 3);
      ctx.fill();
      ctx.beginPath();
      ctx.roundRect(5, -3.6, weapon === 'mine' ? 11 : 18.8, 7.2, 2);
      ctx.fillStyle = middle;
      ctx.fill();
      ctx.fillStyle = light;
      ctx.fillRect(7, -3, weapon === 'mine' ? 8 : 16, 1.4);
      if (weapon === 'mine') {
        ctx.fillStyle = metal;
        ctx.fillRect(-19, -6.5, 14, 13);
        circle(ctx, -13.5, 0, 5.3);
        ctx.fillStyle = accent;
        ctx.fill();
        circle(ctx, -13.5, 0, 2.15);
        ctx.fillStyle = metal;
        ctx.fill();
      } else {
        ctx.beginPath();
        ctx.roundRect(22, -5, 5, 10, 2);
        ctx.fillStyle = '#563c40';
        ctx.fill();
        ctx.fillStyle = '#ffdaa5';
        ctx.fillRect(22, -4.1, 2.2, 8.2);
        ctx.fillStyle = '#352336';
        ctx.fillRect(26, -2.9, 1.5, 5.8);
      }
  }

  const heavy = weapon === 'beam' || weapon === 'pulse' || weapon === 'cluster' || weapon === 'burst';
  ctx.beginPath();
  ctx.roundRect(-10.5, heavy ? -8 : -7, heavy ? 20 : 19, heavy ? 16 : 14, heavy ? 4 : 7);
  ctx.fillStyle = frame;
  ctx.fill();
  ctx.strokeStyle = '#633f45';
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.roundRect(-9.4, -6.1, 17.7, 11.7, heavy ? 3 : 6);
  ctx.fillStyle = middle;
  ctx.fill();
  ctx.strokeStyle = light;
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.beginPath();
  ctx.ellipse(-4, 0, 3.9, 4.4, 0, 0, TAU);
  ctx.fillStyle = '#594052';
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-3.4, 0, 2.6, 3.2, 0, 0, TAU);
  ctx.fillStyle = '#ffd4a4';
  ctx.fill();
  ctx.fillStyle = '#a16444';
  ctx.fillRect(-5.7, -2.6, 1.5, 5.2);
  ctx.fillStyle = '#39233b';
  ctx.fillRect(-2.5, -1.8, .65, .7);
  ctx.fillRect(-2.5, 1.05, .65, .7);
  ctx.fillStyle = weapon ? accent : '#ffdf84';
  ctx.fillRect(.9, -3.6, 5, 1.3);
  ctx.fillStyle = base;
  ctx.fillRect(1.25, 2.1, 4.5, .85);
  if (weapon === 'burst') {
    ctx.fillStyle = metal;
    ctx.fillRect(-3, 2, 10, 3);
    ctx.fillStyle = accent;
    ctx.fillRect(-3, 2, clamp(gatlingAmmo / 24, 0, 1) * 10, 2);
  }
}

function paintBoostPods(ctx, motion) {
  const color = SUPPLIES.boost?.color ?? '#80e1ff';
  for (const y of [-10, 10]) {
    ctx.fillStyle = '#152832';
    ctx.fillRect(-15, y - 2.75, 11, 5.5);
    ctx.fillStyle = color;
    ctx.fillRect(-13, y - 1.25, 6.5, 2.5);
  }
  if (Math.abs(motion.roll ?? 0) < .14) return;
  const direction = -Math.sign(motion.roll);
  ctx.save();
  ctx.strokeStyle = color;
  ctx.globalAlpha = .48;
  ctx.lineWidth = 1.7;
  ctx.lineCap = 'round';
  ctx.beginPath();
  for (const y of [-10, 10]) {
    ctx.moveTo(17 * direction, y);
    ctx.lineTo((27 + Math.min(7, Math.abs(motion.roll))) * direction, y);
  }
  ctx.stroke();
  ctx.restore();
}

function paintAimerHousing(ctx) {
  ctx.fillStyle = '#172832';
  ctx.fillRect(0, -9, 10, 5);
  ctx.fillStyle = SUPPLIES.aimer?.color ?? '#96efb7';
  ctx.fillRect(2, -7.65, 6, 2.1);
}

function paintCannonCharge(ctx, remaining) {
  const charge = clamp(1 - remaining / PULSE_CHARGE_SECONDS, 0, 1);
  const radius = 6.5 + charge * 12;
  ctx.save();
  ctx.translate(33.5, 0);
  const bloom = ctx.createRadialGradient(0, 0, 1, 0, 0, radius + 5);
  bloom.addColorStop(0, '#fff4ff');
  bloom.addColorStop(.37, '#d8afffc8');
  bloom.addColorStop(1, '#a27bf400');
  ctx.globalAlpha = .42 + .48 * charge;
  circle(ctx, 0, 0, radius + 5);
  ctx.fillStyle = bloom;
  ctx.fill();

  ctx.globalAlpha = .5 + .46 * charge;
  ctx.beginPath();
  ctx.arc(0, 0, radius, -Math.PI / 2, -Math.PI / 2 + TAU * (.18 + .82 * charge));
  ctx.lineCap = 'round';
  ctx.lineWidth = 1.2 + charge * 1.2;
  ctx.strokeStyle = '#f3d8ff';
  ctx.stroke();

  ctx.fillStyle = '#fff4ff';
  circle(ctx, 0, 0, 1.8 + charge * 3.1);
  ctx.fill();
  ctx.restore();
}

function paintTank(ctx, tank, seat, own, motion, now) {
  const {x, y, hull, damage, shield, spawnGrace} = tank;
  const color = colorFor(seat);
  const palette = tankPaint[seat] ?? tankPaint[0];
  const [base, middle, light, frame] = palette;
  ctx.save();
  ctx.translate(x, y);
  if (shield || spawnGrace > 0) {
    const pulse = (1 + Math.sin(now / 165)) / 2;
    circle(ctx, 0, 0, 25 + pulse * 1.5);
    ctx.fillStyle = '#70dbff24';
    ctx.fill();
    ctx.lineWidth = 3.6;
    ctx.strokeStyle = '#327f9d';
    ctx.setLineDash(shield ? [] : [3, 4]);
    ctx.stroke();
    ctx.lineWidth = 1.65;
    ctx.strokeStyle = shield ? '#c1f6ff' : '#fff6d5';
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.rotate(hull);
  ctx.beginPath();
  ctx.ellipse(-1, 2.6, 22, 16, 0, 0, TAU);
  ctx.fillStyle = '#5a30395c';
  ctx.fill();
  ctx.beginPath();
  ctx.roundRect(-16, -13.8, 34, 27.6, 7);
  ctx.fillStyle = frame;
  ctx.fill();
  paintTread(ctx, -15.2, motion.left, palette);
  paintTread(ctx, 6.6, motion.right, palette);
  const coat = ctx.createLinearGradient(0, -10, 3, 12);
  coat.addColorStop(0, light);
  coat.addColorStop(.36, middle);
  coat.addColorStop(1, base);
  ctx.beginPath();
  ctx.moveTo(-15.8, -5.5);
  ctx.quadraticCurveTo(-16, -10.7, -11, -10.7);
  ctx.lineTo(9.7, -10.7);
  ctx.quadraticCurveTo(17.7, -9, 18.6, -4.7);
  ctx.quadraticCurveTo(19.6, 0, 18.6, 4.7);
  ctx.quadraticCurveTo(17.7, 9, 9.7, 10.7);
  ctx.lineTo(-11, 10.7);
  ctx.quadraticCurveTo(-16, 10.7, -15.8, 5.5);
  ctx.closePath();
  ctx.fillStyle = damage > 0 ? '#fff5d8' : coat;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = frame;
  ctx.stroke();
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(-12.4, side * 8.2);
    ctx.bezierCurveTo(-6, side * 8.7, 1, side * 6.1, 8.6, side * 8);
    ctx.lineWidth = 1.85;
    ctx.strokeStyle = '#fff1cf';
    ctx.lineCap = 'round';
    ctx.stroke();
    circle(ctx, 14.4, side * 6, 2.4);
    ctx.fillStyle = '#a95d3d';
    ctx.fill();
    circle(ctx, 14.8, side * 6, 1.75);
    ctx.fillStyle = '#fff0a9';
    ctx.fill();
  }
  paintTurret(ctx, tank, palette, now);
  if (!tank.weapon) {
    star(ctx, 12.5, 0, 3.5);
    ctx.lineWidth = 1.1;
    ctx.strokeStyle = '#936043';
    ctx.stroke();
    ctx.fillStyle = '#ffd05c';
    ctx.fill();
  }
  if (tank.pulseCharge > 0) paintCannonCharge(ctx, tank.pulseCharge);
  if (tank.boostRemaining > 0) paintBoostPods(ctx, motion);
  if (tank.aimerRemaining > 0) paintAimerHousing(ctx);
  ctx.restore();

  if (own) {
    ctx.save();
    ctx.fillStyle = '#fff2cf';
    ctx.beginPath();
    ctx.moveTo(x - 4, y + 26);
    ctx.lineTo(x + 4, y + 26);
    ctx.lineTo(x, y + 21);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#6b3a52';
    ctx.lineWidth = 1.45;
    ctx.stroke();
    ctx.restore();
  }
  label(ctx, 'P' + (seat + 1), x, y - 27, color, 14);
}

function paintMuzzleFlash(ctx, {x, y, hull}, color, opacity) {
  ctx.save();
  ctx.translate(x + Math.cos(hull) * 29, y + Math.sin(hull) * 29);
  ctx.rotate(hull);
  ctx.globalAlpha = opacity;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.ellipse(3, 0, 10, 3.6, 0, 0, TAU);
  ctx.fill();
  ctx.fillStyle = '#fff8db';
  ctx.beginPath();
  ctx.ellipse(1, 0, 5.2, 1.8, 0, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function paintSupply(ctx, {x, y, kind, id}, now) {
  const supply = SUPPLIES[kind];
  if (!supply) return;
  const lift = Math.sin(now / 320 + id) * 2.1;
  const {color, label: name} = supply;
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = '#6b394b52';
  ctx.beginPath();
  ctx.ellipse(2, 13, 16, 6, 0, 0, TAU);
  ctx.fill();
  ctx.translate(0, lift);
  const rim = ctx.createLinearGradient(0, -16, 0, 16);
  rim.addColorStop(0, '#fff0a5');
  rim.addColorStop(.52, '#fabe63');
  rim.addColorStop(1, '#cc6c4f');
  circle(ctx, 0, 0, 15.8);
  ctx.fillStyle = rim;
  ctx.fill();
  ctx.strokeStyle = '#894954';
  ctx.lineWidth = 1.4;
  ctx.stroke();

  const enamel = ctx.createLinearGradient(-7, -12, 7, 12);
  enamel.addColorStop(0, '#fffae7');
  enamel.addColorStop(.77, color);
  enamel.addColorStop(1, color);
  circle(ctx, 0, 0, 11.7);
  ctx.fillStyle = enamel;
  ctx.fill();
  ctx.strokeStyle = '#fff6db';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = '#fffbe2';
  for (const x of [-14, 14]) { circle(ctx, x, -.8, 1.2); ctx.fill(); }
  ctx.strokeStyle = '#fffdf0b3';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(0, 0, 9, Math.PI * 1.03, Math.PI * 1.35);
  ctx.stroke();

  ctx.strokeStyle = '#563345';
  ctx.lineWidth = 1.9;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (kind) {
    case 'shield':
      ctx.moveTo(-6, -6);
      ctx.lineTo(6, -6);
      ctx.lineTo(5, 2);
      ctx.lineTo(0, 7);
      ctx.lineTo(-5, 2);
      ctx.closePath();
      break;
    case 'scatter':
      for (const y of [-5, 0, 5]) {
        ctx.moveTo(-6, y * .35);
        ctx.lineTo(y ? 3.5 : 5.5, y);
        ctx.lineTo(y ? 1 : 3, y - 2);
      }
      break;
    case 'pulse':
      ctx.rect(-7, -4, 5, 8);
      ctx.moveTo(1, -3);
      ctx.lineTo(7, -6);
      ctx.moveTo(1, 0);
      ctx.lineTo(7, 0);
      ctx.moveTo(1, 3);
      ctx.lineTo(7, 6);
      break;
    case 'mine':
      ctx.moveTo(6, 0);
      ctx.arc(0, 0, 6, 0, TAU);
      ctx.moveTo(-2, 0);
      ctx.lineTo(2, 0);
      ctx.moveTo(0, -2);
      ctx.lineTo(0, 2);
      break;
    case 'burst':
      ctx.moveTo(1, 0);
      ctx.arc(-3, 0, 4, 0, TAU);
      ctx.moveTo(4, -3);
      ctx.lineTo(7, -3);
      ctx.moveTo(4, 3);
      ctx.lineTo(7, 3);
      break;
    case 'seeker':
      ctx.moveTo(-6, 6);
      ctx.quadraticCurveTo(-5, -4, 5, -5);
      ctx.moveTo(1, -8);
      ctx.lineTo(6, -5);
      ctx.lineTo(4, 0);
      break;
    case 'cluster':
      for (const [x, y] of [[-4.7, 3.5], [0, -4.8], [4.7, 3.5]]) {
        ctx.moveTo(x, y - 2.6);
        ctx.lineTo(x + 2.5, y + 1.8);
        ctx.lineTo(x - 2.5, y + 1.8);
        ctx.closePath();
      }
      break;
    case 'guide':
      ctx.moveTo(-6, 3);
      ctx.quadraticCurveTo(0, 7, 0, 0);
      ctx.quadraticCurveTo(0, -6, 5, -6);
      ctx.moveTo(2, -8);
      ctx.lineTo(6, -6);
      ctx.lineTo(4, -2);
      break;
    case 'beam':
      ctx.moveTo(-7, 0);
      ctx.lineTo(7, 0);
      ctx.moveTo(-5, -5);
      ctx.lineTo(-2, -5);
      ctx.moveTo(2, 5);
      ctx.lineTo(5, 5);
      break;
    case 'double':
      for (const y of [-4, 4]) {
        ctx.moveTo(-6, y);
        ctx.lineTo(6, y);
        ctx.lineTo(6, y - 2);
      }
      break;
    case 'boost':
      for (const x of [-4, 2]) {
        ctx.moveTo(x, -5);
        ctx.lineTo(x + 4, 0);
        ctx.lineTo(x, 5);
      }
      break;
    case 'aimer':
      ctx.moveTo(2, 0);
      ctx.arc(0, 0, 2, 0, TAU);
      for (let side = 0; side < 4; side++) {
        const angle = side * TAU / 4;
        const dx = Math.cos(angle);
        const dy = Math.sin(angle);
        ctx.moveTo(dx * 4, dy * 4);
        ctx.lineTo(dx * 7, dy * 7);
      }
      break;
  }
  ctx.stroke();

  ctx.font = 'bold 12px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const width = Math.max(28, ctx.measureText(name).width + 11);
  ctx.fillStyle = '#fff0d5';
  ctx.strokeStyle = '#a96c68';
  ctx.lineWidth = .9;
  ctx.beginPath();
  ctx.roundRect(-width / 2, 14.5, width, 16, 7);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#653a4b';
  ctx.fillText(name, 0, 22.5);
  ctx.restore();
}

function paintMine(ctx, mine, now) {
  const radius = 9 + (1 + Math.sin(now / 90 + mine.id)) * 1.1;
  circle(ctx, mine.x, mine.y, radius);
  ctx.fillStyle = '#182429';
  ctx.fill();
  ctx.strokeStyle = SUPPLIES.mine.color;
  ctx.lineWidth = 1.8;
  ctx.stroke();
  circle(ctx, mine.x, mine.y, 3);
  ctx.fillStyle = colorFor(mine.owner);
  ctx.fill();
}

function paintRicochetGuide(ctx, points, color) {
  if (points.length < 2) return;
  ctx.save();
  ctx.setLineDash([7, 6]);
  for (let index = 1; index < points.length; index++) {
    let from = points[index - 1];
    let to = points[index];
    if (from.x > to.x || (from.x === to.x && from.y > to.y)) [from, to] = [to, from];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < .001) continue;
    // Keep the same dash phase if a head-on bounce retraces the line.
    ctx.lineDashOffset = (from.x * dx + from.y * dy) / length;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.strokeStyle = '#59334a';
    ctx.globalAlpha = .58;
    ctx.lineWidth = 3.9;
    ctx.stroke();
    ctx.strokeStyle = color;
    ctx.globalAlpha = .92;
    ctx.lineWidth = 2.1;
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.fillStyle = color;
  for (const point of points.slice(1, -1)) {
    circle(ctx, point.x, point.y, 3.1);
    ctx.fill();
    ctx.strokeStyle = '#704559';
    ctx.lineWidth = 1.1;
    ctx.stroke();
  }
  ctx.restore();
}

function paintReturnArrows(ctx, points) {
  ctx.save();
  ctx.strokeStyle = '#fff5fb';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  for (let index = 2; index < points.length; index++) {
    const from = points[index - 1], to = points[index];
    const dx = to.x - from.x, dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 7) continue;
    const distance = Math.min(length * .57, 16 + index * 10);
    ctx.save();
    ctx.translate(from.x + (dx * distance - dy * 7) / length,
      from.y + (dy * distance + dx * 7) / length);
    ctx.rotate(Math.atan2(dy, dx));
    ctx.beginPath();
    ctx.moveTo(-5, -3.5);
    ctx.lineTo(2, 0);
    ctx.lineTo(-5, 3.5);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function paintBeamImpact(ctx, {point, next, time}, now) {
  const phase = (now - time) / 235;
  ctx.save();
  ctx.translate(point.x, point.y);
  ctx.globalAlpha = Math.max(0, 1 - phase);
  ctx.strokeStyle = BEAM_COLOR;
  ctx.lineWidth = 1.8;
  circle(ctx, 0, 0, 4 + phase * 14);
  ctx.stroke();
  ctx.rotate(Math.atan2(next.y - point.y, next.x - point.x));
  ctx.beginPath();
  for (const y of [-4, 0, 4]) {
    ctx.moveTo(2, y * .35);
    ctx.lineTo(12 + phase * 13, y * (1 + phase));
  }
  ctx.strokeStyle = '#fff2fc';
  ctx.stroke();
  ctx.restore();
}

function paintProjectileHead(ctx, kind, color, radius) {
  ctx.beginPath();
  switch (kind) {
    case 'seeker':
      ctx.moveTo(7, 0);
      ctx.quadraticCurveTo(2, -4, -5, -3);
      ctx.lineTo(-3, 0);
      ctx.lineTo(-5, 3);
      ctx.quadraticCurveTo(2, 4, 7, 0);
      ctx.closePath();
      break;
    case 'cluster':
      ctx.moveTo(6, 0);
      ctx.lineTo(1, -4.5);
      ctx.lineTo(-5, -4.5);
      ctx.lineTo(-7, 0);
      ctx.lineTo(-5, 4.5);
      ctx.lineTo(1, 4.5);
      ctx.closePath();
      break;
    case 'guide':
      ctx.moveTo(6, 0);
      ctx.lineTo(-4, -4.5);
      ctx.lineTo(-2.5, 0);
      ctx.lineTo(-4, 4.5);
      ctx.closePath();
      break;
    default:
      circle(ctx, 0, 0, radius);
  }
  ctx.fillStyle = color;
  ctx.strokeStyle = '#5c3c51';
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.fill();
  if (kind === 'seeker') {
    ctx.fillStyle = '#fff0cd';
    ctx.fillRect(-2, -.65, 5, 1.3);
  } else if (kind === 'cluster') {
    ctx.fillStyle = '#3c3d3e';
    for (const x of [-4, -1, 2]) ctx.fillRect(x, -1.2, 1.5, 2.4);
  } else if (kind !== 'guide') {
    circle(ctx, radius * .23, -radius * .3, radius * .45);
    ctx.fillStyle = '#fff9df';
    ctx.fill();
  }
}

function sliceBeam(points, tail, front) {
  const spans = [];
  let offset = 0;
  for (let index = 1; index < points.length; index++) {
    const from = points[index - 1];
    const to = points[index];
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    const end = offset + distance;
    const startVisible = Math.max(tail, offset);
    const endVisible = Math.min(front, end);
    if (endVisible > startVisible) {
      const a = (startVisible - offset) / distance;
      const b = (endVisible - offset) / distance;
      spans.push({
        x1: mix(from.x, to.x, a), y1: mix(from.y, to.y, a),
        x2: mix(from.x, to.x, b), y2: mix(from.y, to.y, b),
        start: (startVisible - tail) / (front - tail),
        end: (endVisible - tail) / (front - tail),
      });
    }
    if (end >= front) break;
    offset = end;
  }
  return spans;
}

function paintPulseCannon(ctx, shot, previous, t, now) {
  const [start, end] = shot.path;
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const remaining = mix(previous?.lifeRemaining ?? shot.lifeRemaining, shot.lifeRemaining, t);
  const fade = clamp(remaining / .27, 0, 1);
  if (!(length > 0) || !fade) return;

  const surge = clamp((remaining - 1.81) / .19, 0, 1);
  const shimmer = .5 + .5 * Math.sin(now / 95 + shot.id);
  const half = shot.width / 2;
  ctx.save();
  ctx.translate(start.x, start.y);
  ctx.rotate(Math.atan2(dy, dx));

  const field = ctx.createLinearGradient(0, -half, 0, half);
  field.addColorStop(0, '#aa8bf15c');
  field.addColorStop(.16, '#8c62e13c');
  field.addColorStop(.5, '#dcb7ffbb');
  field.addColorStop(.84, '#8c62e13c');
  field.addColorStop(1, '#aa8bf15c');
  ctx.fillStyle = field;
  ctx.globalAlpha = fade * (.74 + surge * .23);
  ctx.fillRect(0, -half, length, shot.width);

  const core = half * (.35 + surge * .19 + shimmer * .035);
  const plasma = ctx.createLinearGradient(0, -core, 0, core);
  plasma.addColorStop(0, '#ba8aff00');
  plasma.addColorStop(.28, '#dbb4ffd8');
  plasma.addColorStop(.5, '#fff4ffff');
  plasma.addColorStop(.72, '#dbb4ffd8');
  plasma.addColorStop(1, '#ba8aff00');
  ctx.fillStyle = plasma;
  ctx.globalAlpha = fade;
  ctx.fillRect(0, -core, length, core * 2);

  ctx.beginPath();
  for (const y of [-half + 2, half - 2]) {
    ctx.moveTo(0, y);
    ctx.lineTo(length, y);
  }
  ctx.setLineDash([18, 11, 4, 11]);
  ctx.lineDashOffset = -(now * .19 % 44);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = '#e9d1ff';
  ctx.globalAlpha = fade * (.34 + shimmer * .15);
  ctx.stroke();

  if (surge > 0) {
    const reach = Math.min(length, half * 3.4);
    const flash = ctx.createLinearGradient(0, 0, reach, 0);
    flash.addColorStop(0, '#fff9ff');
    flash.addColorStop(.24, '#f1caff99');
    flash.addColorStop(1, '#e6b7ff00');
    ctx.fillStyle = flash;
    ctx.globalAlpha = surge * fade;
    ctx.beginPath();
    ctx.moveTo(0, -half * .86);
    ctx.lineTo(reach, -core * .33);
    ctx.lineTo(reach, core * .33);
    ctx.lineTo(0, half * .86);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

function paintBeam(ctx, shot, previous, t, age) {
  const {x, y, vx, vy, path} = shot;
  const points = path ?? [{x, y}, {x: x + vx, y: y + vy}];
  if (points.length < 2) return;
  const length = shot.length ?? points.slice(1).reduce((sum, point, index) =>
    sum + Math.hypot(point.x - points[index].x, point.y - points[index].y), 0);
  const traveling = Number.isFinite(shot.front) && Number.isFinite(shot.tail);
  const front = clamp(traveling ? mix(previous?.front ?? shot.front, shot.front, t) : length, 0, length);
  const tail = clamp(traveling ? mix(previous?.tail ?? shot.tail, shot.tail, t) : 0, 0, length);
  const opacity = traveling ? clamp((length - tail) / 120, 0, 1) : clamp((180 - age) / 115, 0, 1);
  if (!opacity || front <= tail) return;
  const spans = sliceBeam(points, tail, front);
  if (!spans.length) return;

  const intensity = fraction => traveling ? fraction ** .68 : 1;
  const alphaHex = fraction => Math.round(clamp(intensity(fraction), 0, 1) * 255).toString(16).padStart(2, '0');
  ctx.save();
  ctx.lineCap = 'butt';
  for (const span of spans) {
    ctx.beginPath();
    ctx.moveTo(span.x1, span.y1);
    ctx.lineTo(span.x2, span.y2);
    for (const [color, width, strength] of [[BEAM_COLOR, 14, .22], [BEAM_COLOR, 7, .75], ['#fff2fd', 2.2, .98]]) {
      const gradient = ctx.createLinearGradient(span.x1, span.y1, span.x2, span.y2);
      gradient.addColorStop(0, color + alphaHex(span.start));
      gradient.addColorStop(1, color + alphaHex(span.end));
      ctx.strokeStyle = gradient;
      ctx.globalAlpha = opacity * strength;
      ctx.lineWidth = width;
      ctx.stroke();
    }
  }
  ctx.fillStyle = '#fff2fd';
  for (const span of spans.slice(0, -1)) {
    circle(ctx, span.x2, span.y2, 2.6);
    ctx.globalAlpha = opacity * intensity(span.end);
    ctx.fill();
  }
  if (traveling && front < length - 3) {
    const edge = spans.at(-1);
    circle(ctx, edge.x2, edge.y2, 3.1);
    ctx.globalAlpha = opacity;
    ctx.fill();
  }
  ctx.restore();
}

function exhaustColor(target) {
  return Number.isInteger(target) ? colorFor(target) : '#ffad6c';
}

function paintExhaust(ctx, points, now, point) {
  while (points.length && now - points[0].time >= EXHAUST_LIFETIME) points.shift();
  const last = points.at(-1);
  if (point && (!last || last.ricochets !== point.ricochets || last.color !== point.color ||
      Math.hypot(last.x - point.x, last.y - point.y) >= 5)) points.push(point);

  ctx.save();
  ctx.lineCap = 'round';
  for (let index = 1; index <= points.length; index++) {
    const a = points[index - 1];
    const b = points[index] ?? point;
    if (!b || a.ricochets !== b.ricochets) continue;
    const life = 1 - (now - a.time) / EXHAUST_LIFETIME;
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = b.color;
    ctx.globalAlpha = life ** 1.6 * .2;
    ctx.lineWidth = 5 + (1 - life) * 8;
    ctx.stroke();
    ctx.globalAlpha = life ** 2 * .68;
    ctx.lineWidth = 1 + life * 2;
    ctx.stroke();
  }
  ctx.restore();
}

function paintRocketFlame(ctx, color, now, id) {
  const length = 14 + Math.sin(now / 21 + id) * 3;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-4, -3.2);
  ctx.quadraticCurveTo(-11, -4, -length, 0);
  ctx.quadraticCurveTo(-11, 4, -4, 3.2);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#fff7df';
  ctx.beginPath();
  ctx.moveTo(-4, -1.6);
  ctx.quadraticCurveTo(-7, -1.4, -length * .75, 0);
  ctx.quadraticCurveTo(-7, 1.4, -4, 1.6);
  ctx.closePath();
  ctx.fill();
}

function paintShot(ctx, shot, previous, t, now, exhaust) {
  const rebounded = previous && shot.ricochets > previous.ricochets;
  const canBlend = previous && !rebounded;
  const x = canBlend ? mix(previous.x, shot.x, t) : shot.x;
  const y = canBlend ? mix(previous.y, shot.y, t) : shot.y;
  const heading = Math.atan2(shot.vy ?? 0, shot.vx ?? 1);
  const lastHeading = canBlend ? Math.atan2(previous.vy ?? 0, previous.vx ?? 1) : heading;
  const angle = lastHeading + turnDelta(lastHeading, heading) * t;
  const {kind} = shot;
  if (kind === 'fragment' || kind === 'mineShard') {
    const variation = shot.id % 7;
    const size = (kind === 'fragment' ? 9.5 : 8.2) + (variation % 3) * .55;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(shot.id + now * (variation % 2 ? .014 : -.011));
    ctx.globalAlpha = 1;
    ctx.fillStyle = kind === 'fragment' ? SUPPLIES.cluster.color : '#fff1bc';
    ctx.strokeStyle = '#16232c';
    ctx.lineWidth = 1.15;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * .59, size * .56);
    ctx.lineTo(-size * .64, -size * .49);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    return;
  }
  const {trail, width, radius, color: fallbackColor} = PROJECTILES[kind] ?? PROJECTILES.shell;
  const color = SUPPLIES[kind]?.color ?? fallbackColor ?? colorFor(shot.owner);
  if (exhaust) {
    paintExhaust(ctx, exhaust, now, {
      x: x - Math.cos(angle) * 6,
      y: y - Math.sin(angle) * 6,
      time: now,
      ricochets: shot.ricochets,
      color: exhaustColor(shot.target),
    });
  }
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  if (exhaust) {
    paintRocketFlame(ctx, exhaustColor(shot.target), now, shot.id);
  } else {
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    ctx.globalAlpha = .55;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(-trail, 0);
    ctx.lineTo(1, 0);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  paintProjectileHead(ctx, kind, color, radius);
  if (rebounded) {
    star(ctx, 0, 0, 7 + t * 8);
    ctx.globalAlpha = 1 - t;
    ctx.strokeStyle = '#ad624a';
    ctx.stroke();
    ctx.fillStyle = '#fff1a4';
    ctx.fill();
  }
  ctx.restore();
}

function paintTankDebris(ctx, shape, tint) {
  ctx.fillStyle = '#583844';
  if (shape === 0) {
    ctx.beginPath();
    ctx.roundRect(-9, -3.5, 18, 7, 2);
    ctx.fill();
    ctx.fillStyle = '#d99b73';
    for (const x of [-6.5, -3, .5, 4]) ctx.fillRect(x, -2.3, 1.6, 4.6);
  } else if (shape === 1) {
    ctx.fillRect(-9, -3, 18, 6);
    ctx.fillStyle = '#f4b75d';
    ctx.fillRect(-8, -1.1, 16, 2.2);
    ctx.fillRect(5, -2.2, 4, 4.4);
    ctx.fillStyle = '#fff0bd';
    ctx.fillRect(-8, -2.2, 9, 1);
  } else if (shape === 2) {
    ctx.beginPath();
    ctx.moveTo(-7, -3.5);
    ctx.lineTo(3, -5);
    ctx.lineTo(7, -1);
    ctx.lineTo(4, 4.5);
    ctx.lineTo(-5, 3);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = tint;
    ctx.fillRect(-5, -2, 8, 2.5);
    ctx.fillStyle = '#fff0ca';
    ctx.fillRect(-3, -2.5, 5, .8);
  } else if (shape === 3) {
    circle(ctx, 0, 0, 5.4);
    ctx.fill();
    circle(ctx, 0, 0, 2.8);
    ctx.strokeStyle = '#e6af73';
    ctx.lineWidth = 1.6;
    ctx.stroke();
    ctx.fillRect(-1.1, -6.7, 2.2, 3);
    ctx.fillRect(4.2, -.9, 3.1, 1.8);
  } else if (shape === 4) {
    ctx.strokeStyle = '#593544';
    ctx.lineWidth = 4.4;
    ctx.lineJoin = 'bevel';
    ctx.beginPath();
    ctx.moveTo(-8, 2);
    ctx.lineTo(-1, -2);
    ctx.lineTo(2, -2);
    ctx.lineTo(6, 4);
    ctx.stroke();
    ctx.lineWidth = 1.6;
    ctx.strokeStyle = tint;
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.roundRect(-6, -4, 12, 8, 2);
    ctx.fill();
    ctx.fillStyle = '#ffcf83';
    for (let x = -3; x <= 3; x += 3) ctx.fillRect(x, -2.4, 1.2, 4.8);
  }
}

function paintBlast(ctx, blast, now) {
  const mine = blast.kind === 'mine' || blast.kind === 'cluster';
  const elapsed = now - blast.time;
  const age = elapsed / (mine ? 880 : 1290);
  if (age < 0 || age >= 1) return;
  const seat = mine ? blast.owner : blast.seat;
  const tint = mine ? SUPPLIES[blast.kind].color : colorFor(seat);
  const travel = 1 - (1 - Math.min(1, age * (mine ? 1 : 1.24))) ** 3;
  const random = randomFrom((blast.id ?? (blast.x * 273)) ^ (seat * 4163));
  ctx.save();
  ctx.translate(blast.x, blast.y);

  const smoke = clamp((age - .055) / .945, 0, 1);
  const clouds = mine ? 8 : 12;
  for (let index = 0; index < clouds; index++) {
    const angle = index * TAU / clouds + random() * .55;
    const offset = (7 + random() * 30) * travel;
    const radius = (6 + random() * 11) * (1 + smoke * 1.4);
    if (!smoke) continue;
    const x = Math.cos(angle) * offset;
    const y = Math.sin(angle) * offset - smoke * (mine ? 15 : 20 + index % 4 * 4);
    const vapor = ctx.createRadialGradient(x, y, 1, x, y, radius);
    vapor.addColorStop(0, mine ? '#634f4c' : '#523b4d');
    vapor.addColorStop(.43, mine ? '#967356cc' : '#634b5dd9');
    vapor.addColorStop(.73, mine ? '#c296732b' : '#9b687653');
    vapor.addColorStop(1, '#97677e00');
    circle(ctx, x, y, radius);
    ctx.fillStyle = vapor;
    ctx.globalAlpha = Math.sin(Math.PI * Math.sqrt(smoke)) * (mine ? .4 : index < 6 ? .48 : .28);
    ctx.fill();
  }

  const flashAge = elapsed / (mine ? 880 : 1020);
  if (flashAge < .46) {
    const fade = 1 - flashAge / .46;
    const ringRadius = (mine ? 12 : 17) + travel * (mine ? 68 : 92);
    circle(ctx, 0, 0, ringRadius);
    ctx.strokeStyle = mine ? tint : '#fff0ab';
    ctx.lineWidth = .9 + 3 * fade;
    ctx.globalAlpha = fade;
    ctx.stroke();
    if (mine || flashAge < .28) {
      circle(ctx, 0, 0, ringRadius * .72);
      ctx.globalAlpha = fade * .65;
      ctx.lineWidth = 1.4;
      ctx.strokeStyle = '#f78449';
      ctx.stroke();
    }
    const flashRadius = mine ? 51 : 86 + flashAge * 20;
    const flash = ctx.createRadialGradient(0, 0, 2, 0, 0, flashRadius);
    flash.addColorStop(0, '#ffffef');
    flash.addColorStop(.26, mine ? '#f6e395' : '#ffe695');
    flash.addColorStop(.58, mine ? '#f4a25ac9' : '#ff8b4cde');
    flash.addColorStop(1, '#f57c4700');
    circle(ctx, 0, 0, flashRadius);
    ctx.fillStyle = flash;
    ctx.globalAlpha = fade ** 2;
    ctx.fill();
    if (!mine && flashAge < .17) {
      const white = 1 - flashAge / .17;
      ctx.beginPath();
      for (let index = 0; index < 18; index++) {
        const angle = index * TAU / 18 + .1;
        const size = (index % 2 ? 11 : 27 + (index * 11) % 34) * (.8 + travel);
        const x = Math.cos(angle) * size;
        const y = Math.sin(angle) * size;
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = '#fff7cc';
      ctx.globalAlpha = white ** 1.6;
      ctx.fill();
    }
  }

  const chunks = mine ? 7 : 21;
  for (let index = 0; index < chunks; index++) {
    const angle = (index + random() * (mine ? .7 : 1.6)) * TAU / chunks;
    const offset = (20 + random() * (mine ? 45 : 122)) * travel;
    const spin = angle + age * (index % 2 ? 8 : -11) * (mine ? 1 : .7 + random() * .8);
    const scale = (mine ? .65 : .53 + random() * .66) * (1 - age * .61);
    ctx.save();
    ctx.translate(Math.cos(angle) * offset, Math.sin(angle) * offset);
    ctx.rotate(spin);
    ctx.globalAlpha = (1 - age) ** 1.1;
    ctx.scale(scale, scale);
    paintTankDebris(ctx, mine ? 2 : index % 6, tint);
    ctx.restore();
  }

  ctx.lineCap = 'round';
  const sparkCount = mine ? 20 : 32;
  for (let index = 0; index < sparkCount; index++) {
    const angle = index * TAU / sparkCount + random() * .42;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    const tip = 8 + travel * (31 + random() * (mine ? 52 : 115));
    const tail = tip - (5 + random() * 17) * (1 - age * .55);
    ctx.globalAlpha = (1 - age) ** 1.5;
    ctx.strokeStyle = index % 4 === 0 ? tint : index % 2 ? '#ffb54c' : '#fff3b8';
    ctx.lineWidth = index % 3 === 0 ? 3.3 : 1.7;
    ctx.beginPath();
    ctx.moveTo(x * tail, y * tail);
    ctx.lineTo(x * tip, y * tip);
    ctx.stroke();
    if (!mine && index % 6 === 0 && age < .56) {
      star(ctx, x * tip, y * tip, 2.4 + 3.7 * (1 - age));
      ctx.strokeStyle = '#cc6d44';
      ctx.lineWidth = .8;
      ctx.fillStyle = '#fff1ae';
      ctx.fill();
      ctx.stroke();
    }
  }
  ctx.restore();
}

function paintWreck(ctx, {id, x, y, hull, seat}) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Number.isFinite(hull) ? hull : ((id ?? 0) % 12) * TAU / 12);
  ctx.globalAlpha = .83;
  const soot = ctx.createRadialGradient(0, 1, 3, 0, 1, 22);
  soot.addColorStop(0, '#5e394b94');
  soot.addColorStop(.64, '#84514d63');
  soot.addColorStop(1, '#84514d00');
  ctx.fillStyle = soot;
  ctx.beginPath();
  ctx.ellipse(0, 1, 24, 15, 0, 0, TAU);
  ctx.fill();

  // Separate broken pieces leave clear gaps where the tracks and turret came apart.
  for (const [x, y, angle, width] of [[-5, -12, -.18, 17], [10, 12, .37, 11], [-12, 13, -.24, 7]]) {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.fillStyle = '#66454c';
    ctx.beginPath();
    ctx.roundRect(-width / 2, -3.1, width, 6.2, 1.7);
    ctx.fill();
    ctx.fillStyle = '#a47769';
    for (let rung = 2 - width / 2; rung < width / 2; rung += 4) ctx.fillRect(rung, -2, 1.3, 4);
    ctx.restore();
  }

  ctx.beginPath();
  ctx.moveTo(-15, -7);
  ctx.lineTo(-8, -9);
  ctx.lineTo(-5, -7);
  ctx.lineTo(1, -9);
  ctx.lineTo(3, -3);
  ctx.lineTo(11, -5);
  ctx.lineTo(15, -1);
  ctx.lineTo(11, 2);
  ctx.lineTo(14, 5);
  ctx.lineTo(6, 9);
  ctx.lineTo(0, 6);
  ctx.lineTo(-5, 10);
  ctx.lineTo(-14, 6);
  ctx.closePath();
  const brokenEnamel = ctx.createLinearGradient(-12, -8, 12, 9);
  brokenEnamel.addColorStop(0, '#bb836b');
  brokenEnamel.addColorStop(.56, '#8a5d58');
  brokenEnamel.addColorStop(1, '#ab7264');
  ctx.fillStyle = brokenEnamel;
  ctx.strokeStyle = '#67444d';
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.fill();
  ctx.fillStyle = '#68444d';
  ctx.beginPath();
  ctx.moveTo(-8, -2);
  ctx.lineTo(-3, -5);
  ctx.lineTo(4, 2);
  ctx.lineTo(1, 6);
  ctx.lineTo(-4, 5);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = '#e2a680';
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(-13, 2);
  ctx.lineTo(-10, 5);
  ctx.lineTo(-6, 5);
  ctx.moveTo(5, 6);
  ctx.lineTo(10, 5);
  ctx.stroke();
  ctx.fillStyle = tankPaint[seat]?.[1] ?? '#d5a17c';
  ctx.fillRect(-12, -5, 4, 1.5);
  ctx.fillRect(7, 1.5, 3, 1.2);

  ctx.translate(10, -10);
  ctx.rotate(-.42);
  ctx.fillStyle = '#714b50';
  ctx.beginPath();
  ctx.moveTo(-6, -3);
  ctx.lineTo(-2, -5);
  ctx.lineTo(4, -3.8);
  ctx.lineTo(6, -1);
  ctx.lineTo(3.4, 4.2);
  ctx.lineTo(-4, 3.3);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#bb8269';
  ctx.fillRect(-1, -3, 4.4, 2.5);
  ctx.strokeStyle = '#a16f63';
  ctx.beginPath();
  ctx.moveTo(3, -.6);
  ctx.lineTo(9, -.6);
  ctx.lineTo(12, -3.1);
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.restore();
}

function cameraImpulse(blasts, now) {
  let move = null;
  for (const blast of blasts) {
    const age = now - blast.time;
    if (age < 0 || age >= 145) continue;
    const strength = (1 - age / 145) ** 2 * 2.85;
    if (move && move.strength >= strength) continue;
    const wave = age * .081 + (blast.id ?? blast.seat) * .53;
    move = {x: Math.cos(wave) * strength, y: Math.sin(wave * 1.17) * strength * .67, strength};
  }
  return move;
}

export function createArenaView(canvas) {
  const density = clamp(globalThis.devicePixelRatio || 1, 1, 2);
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  const ctx = canvas.getContext('2d');
  const ground = document.createElement('canvas');
  const base = ground.getContext('2d');
  const motion = new Map();
  const beamStarts = new Map();
  const wrecked = new Set();
  let beamImpacts = [];
  const exhaustTrails = new Map();
  let tracks = [];
  let layout;
  let mapKey;
  let passages;
  let hasDrawnWorld = false;
  let transition = null;

  function updateTreads(tank, seat, now) {
    const {x, y, hull} = tank;
    const last = motion.get(seat);
    if (!last || Math.hypot(x - last.x, y - last.y) > 50) {
      const phase = {x, y, hull, distance: 0, left: 0, right: 0};
      motion.set(seat, phase);
      return phase;
    }
    const dx = x - last.x, dy = y - last.y;
    const distance = Math.hypot(dx, dy);
    const roll = dx * Math.cos(hull) + dy * Math.sin(hull);
    const turn = turnDelta(last.hull, hull);
    last.left = ((last.left + roll + turn * 10) % TREAD_PITCH + TREAD_PITCH) % TREAD_PITCH;
    last.right = ((last.right + roll - turn * 10) % TREAD_PITCH + TREAD_PITCH) % TREAD_PITCH;
    for (let offset = TRACK_SPACING - last.distance; offset <= distance; offset += TRACK_SPACING) {
      const at = offset / distance;
      tracks.push({x: last.x + dx * at, y: last.y + dy * at, hull: last.hull + turn * at, time: now});
    }
    last.distance = (last.distance + distance) % TRACK_SPACING;
    Object.assign(last, {x, y, hull, roll});
    return last;
  }

  return function draw(world, previous, progress, seat, blasts = [], now = performance.now(), effects = []) {
    const seed = world?.mapSeed ?? 0;
    const mapPlayers = world?.mapPlayerCount ?? world?.playerCount ?? world?.tanks?.length ?? MIN_PLAYERS;
    const key = mapPlayers + '/' + seed;
    if (key !== mapKey) {
      transition = null;
      if (world && hasDrawnWorld && !reducedMotion?.matches) {
        // The canvas resize below clears the frame, so preserve it at its original aspect ratio first.
        const frame = document.createElement('canvas');
        frame.width = canvas.width;
        frame.height = canvas.height;
        frame.getContext('2d').drawImage(canvas, 0, 0);
        transition = {frame, start: now};
      }
      mapKey = key;
      layout = arenaFor(seed, mapPlayers);
      const {width, height} = layout;
      for (const surface of [canvas, ground]) {
        surface.width = Math.round(width * density);
        surface.height = Math.round(height * density);
      }
      canvas.style.aspectRatio = width + ' / ' + height;
      ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
      base.setTransform(ground.width / width, 0, 0, ground.height / height, 0, 0);
      passages = paintFloor(base, layout, seed);
      tracks = [];
      motion.clear();
      beamStarts.clear();
      beamImpacts = [];
      exhaustTrails.clear();
      wrecked.clear();
    }
    if (world) {
      const wrecks = (world.blasts ?? blasts).filter(blast => {
        if (wrecked.has(blast.id)) return false;
        const seenAt = blasts.find(recent => recent.id === blast.id)?.time;
        return seenAt == null || now - seenAt >= 180;
      });
      if (wrecks.length) {
        base.save();
        base.clip(passages);
        for (const blast of wrecks) {
          paintWreck(base, blast);
          wrecked.add(blast.id);
        }
        base.restore();
      }
    }
    ctx.drawImage(ground, 0, 0, layout.width, layout.height);
    hasDrawnWorld = Boolean(world);
    if (!world) return;
    ctx.save();
    const impulse = reducedMotion?.matches ? null : cameraImpulse(blasts, now);
    if (impulse) {
      ctx.translate(impulse.x, impulse.y);
      ctx.drawImage(ground, 0, 0, layout.width, layout.height);
    }
    const relay = world.mode === 'relay';
    if (world.mode === 'beacon' || (relay && world.beacon)) {
      paintBeacon(ctx, world.beacon ?? layout.beacon, world.capture, now, relay, world.beaconMoveRemaining);
    }
    tracks = tracks.filter(mark => now - mark.time < TRACK_LIFETIME).slice(-360);
    if (tracks.length) {
      ctx.save();
      ctx.clip(passages);
      for (const mark of tracks) paintTrack(ctx, mark, now);
      ctx.restore();
    }
    for (const item of world.pickups) paintSupply(ctx, item, now);
    for (const mine of world.mines ?? []) {
      if (!mine.armed) paintMine(ctx, mine, now);
    }
    const sameMap = previous && previous.mapSeed === seed &&
      (previous.mapPlayerCount ?? previous.playerCount ?? previous.tanks.length) === mapPlayers;
    const previousShots = new Map((sameMap ? previous.shots : []).map(shot => [shot.id, shot]));
    const t = clamp(progress, 0, 1);
    const beamIds = new Set();
    const rocketIds = new Set();
    const muzzleFlashes = new Map();
    // The penetrating cannon stays visible across walls, even when rockets use the corridor clip.
    for (const shot of world.shots) {
      if (isPulseCannon(shot)) paintPulseCannon(ctx, shot, previousShots.get(shot.id), t, now);
    }
    ctx.save();
    if (exhaustTrails.size || world.shots.some(shot => isRocket(shot.kind))) ctx.clip(passages);
    for (const shot of world.shots) {
      if (isPulseCannon(shot)) continue;
      if (shot.kind === 'beam') {
        beamIds.add(shot.id);
        const seen = beamStarts.get(shot.id) ?? {time:now,ricochets:0};
        for (let index = seen.ricochets + 1; index <= shot.ricochets; index++) {
          const point = shot.path?.[index], next = shot.path?.[index + 1];
          if (point && next) beamImpacts.push({point,next,time:now});
        }
        seen.ricochets = shot.ricochets;
        beamStarts.set(shot.id, seen);
        paintBeam(ctx, shot, previousShots.get(shot.id), t, now - seen.time);
      } else {
        let exhaust;
        if (isRocket(shot.kind)) {
          rocketIds.add(shot.id);
          exhaust = exhaustTrails.get(shot.id) ?? [];
          exhaustTrails.set(shot.id, exhaust);
        }
        const old = previousShots.get(shot.id);
        if (sameMap && !old && t < 1 && shot.kind !== 'fragment' && shot.kind !== 'mineShard') {
          muzzleFlashes.set(shot.owner, SUPPLIES[shot.kind]?.color ?? '#ffcc86');
        }
        paintShot(ctx, shot, old, t, now, exhaust);
      }
    }
    for (const id of beamStarts.keys()) {
      if (!beamIds.has(id)) beamStarts.delete(id);
    }
    for (const [id, trail] of exhaustTrails) {
      if (rocketIds.has(id)) continue;
      paintExhaust(ctx, trail, now);
      if (!trail.length) exhaustTrails.delete(id);
    }
    ctx.restore();
    beamImpacts = beamImpacts.filter(impact => now - impact.time < 235);
    for (const impact of beamImpacts) paintBeamImpact(ctx, impact, now);
    world.tanks.forEach((tank, index) => {
      if (!tank.armor) {
        motion.delete(index);
        return;
      }
      const from = sameMap ? previous.tanks[index] : null;
      const visual = from?.armor ? {
        ...tank,
        x: mix(from.x, tank.x, t),
        y: mix(from.y, tank.y, t),
        hull: from.hull + turnDelta(from.hull, tank.hull) * t,
        pulseCharge: tank.pulseCharge > 0 && from.pulseCharge > 0
          ? mix(from.pulseCharge, tank.pulseCharge, t) : tank.pulseCharge,
      } : tank;
      const phase = updateTreads(visual, index, now);
      let laserGuide;
      if (index === seat && !visual.pulseFiring && !(visual.pulseCharge > 0)) {
        if (visual.weapon === 'beam') {
          laserGuide = laserPath(visual, visual.hull, layout.walls);
          paintRicochetGuide(ctx, laserGuide, BEAM_COLOR);
        }
        if (!visual.weapon && visual.aimerRemaining > 0) {
          const points = shellAimPath(visual, visual.hull, layout.walls);
          paintRicochetGuide(ctx, points, SUPPLIES.aimer?.color ?? '#96efb7');
        }
      }
      paintTank(ctx, visual, index, index === seat, phase, now);
      if (laserGuide) paintReturnArrows(ctx, laserGuide);
      if (muzzleFlashes.has(index)) paintMuzzleFlash(ctx, visual, muzzleFlashes.get(index), 1 - t);
    });
    for (const effect of effects) {
      if (effect.kind === 'mine' || effect.kind === 'cluster') paintBlast(ctx, effect, now);
    }
    for (const blast of blasts) paintBlast(ctx, blast, now);
    ctx.restore();
    if (transition) {
      const fade = clamp((now - transition.start) / 580, 0, 1);
      if (fade >= 1 || reducedMotion?.matches) {
        transition = null;
      } else {
        const {frame} = transition;
        const scale = Math.min(layout.width / frame.width, layout.height / frame.height);
        const width = frame.width * scale;
        const height = frame.height * scale;
        ctx.save();
        ctx.globalAlpha = (1 - fade) ** 1.65;
        ctx.drawImage(frame, (layout.width - width) / 2, (layout.height - height) / 2, width, height);
        ctx.restore();
      }
    }
  };
}
