import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BEACON,COLUMNS,HEIGHT,HULL_RADIUS,MAX_PLAYERS,MIN_PLAYERS,MODES,MOVE_SPEED,PULSE_CHARGE_SECONDS,ROWS,SHELL_BOUNCES,SHELL_SPEED,
  SEEKER_ARM_SECONDS,SHELL_LIFETIME,SPAWNS,SUPPLIES,TICK_RATE,TURN_SPEED,WIDTH,
  arenaFor,cellCenter} from '../public/tank-arena/rules.mjs';
import {advanceArena, createArena, neutralInput, normalizeInput, setArenaAvailability} from '../server/tank-arena-sim.mjs';
import {pathsFrom} from './tank-arena-paths.mjs';

const interval=1/TICK_RATE;
const noInput=[neutralInput(),neutralInput()];
const fireInput=[{...neutralInput(),fire:true},neutralInput()];
const stepUntil=(arena,until,ticks=200)=>{
  let outcome=null;
  for(let tick=0;tick<ticks&&!until();tick++)outcome=advanceArena(arena,noInput,interval);
  return outcome;
};

function lineUp(arena){
  Object.assign(arena.tanks[0],cellCenter((arena.columns-1)/2,1,arena.tanks.length),{hull:Math.PI/2,shotWait:0});
  Object.assign(arena.tanks[1],cellCenter((arena.columns-1)/2,3,arena.tanks.length));
}

test('a ricochet keeps its speed and can destroy its own tank',()=>{
  const arena=createArena(0);
  arena.tanks[0].hull=Math.PI;
  advanceArena(arena,fireInput,interval);
  assert.equal(arena.tanks[0].armor,1);
  stepUntil(arena,()=>arena.shots[0]?.ricochets,40);
  assert(arena.shots[0].bounces<SHELL_BOUNCES);
  assert(Math.abs(Math.hypot(arena.shots[0].vx,arena.shots[0].vy)-SHELL_SPEED)<0.001);
  assert.deepEqual(stepUntil(arena,()=>!arena.tanks[0].armor),{winner:null,reason:'self-destruction'});
  assert.equal(arena.blasts[0].seat,0);
});

test('the first hit breaks a picked-up shield and an unshielded tank dies in one hit',()=>{
  const arena=createArena(0);
  lineUp(arena);
  arena.pickups=[{...arena.tanks[1],kind:'shield'}];
  advanceArena(arena,fireInput,interval);
  assert.equal(arena.tanks[1].shield,true);
  assert.equal(stepUntil(arena,()=>!arena.tanks[1].shield),null);
  assert.equal(arena.tanks[1].armor,1);
  assert.deepEqual(arena.blasts,[]);
  advanceArena(arena,fireInput,interval);
  const outcome=stepUntil(arena,()=>!arena.tanks[1].armor);
  assert.deepEqual(outcome,{winner:0,reason:'armor'});
  assert.deepEqual(arena.blasts,[{id:1,seat:1,owner:0,...cellCenter(4,3),hull:arena.tanks[1].hull}]);
});

test('neutral steering turns in place and throttle moves along the hull in either direction',()=>{
  const arena=createArena(0),tank=arena.tanks[0];
  const start={x:tank.x,y:tank.y};
  const step=input=>advanceArena(arena,[{...neutralInput(),...input},neutralInput()],interval);
  step({turn:-1});
  assert.deepEqual({x:tank.x,y:tank.y},start);
  assert(Math.abs(tank.hull+TURN_SPEED*interval)<1e-6);
  step({drive:1});
  assert(tank.x>start.x&&tank.y<start.y);
  assert(Math.abs(Math.hypot(tank.x-start.x,tank.y-start.y)-MOVE_SPEED*interval)<1e-6);
  step({drive:-1});
  assert(Math.hypot(tank.x-start.x,tank.y-start.y)<1e-6);
  step({turn:1});
  assert(Math.abs(tank.hull)<1e-6);
});

test('shells follow the current hull even if an old client submits an aim field',()=>{
  const arena=createArena(12);
  const fire=normalizeInput({...neutralInput(),turn:1,fire:true,aim:Math.PI});
  assert(!Object.hasOwn(fire,'aim'));
  advanceArena(arena,[fire,neutralInput()],interval);
  const shot=arena.shots[0];
  assert(shot.vx>0&&shot.vy>0);
  assert(Math.abs(Math.atan2(shot.vy,shot.vx)-arena.tanks[0].hull)<1e-6);
});

test('generated mazes have cover, multiple routes, and mirrored paths to the beacon',()=>{
  const layouts=new Set();
  for(let seed=0;seed<50;seed++){
    const maze=arenaFor(seed);
    layouts.add(JSON.stringify(maze.walls));
    assert(maze.walls.length>=16);
    const [first,second]=SPAWNS.map(spawn=>pathsFrom(seed,spawn));
    assert.equal(first.size,COLUMNS*ROWS);
    assert.equal(second.size,COLUMNS*ROWS);
    assert.equal(first.get('4,2').length,second.get('4,2').length);
    const wallAt=new Set(maze.walls.map(wall=>JSON.stringify(wall)));
    for(const {x,y,w,h} of maze.walls)assert(wallAt.has(JSON.stringify({x:WIDTH-x-w,y:HEIGHT-y-h,w,h})));
  }
  assert(layouts.size>=45);
});

test('every arena size has interconnected cells, loops, and separated spawn points',()=>{
  let lastArea=0,lastCover=0;
  for(let players=MIN_PLAYERS;players<=MAX_PLAYERS;players++){
    let cover=0;
    for(let seed=0;seed<16;seed++){
      const {width,height,columns,rows,spawns,walls}=arenaFor(seed,players);
      assert.equal(spawns.length,players);
      const byDistance=(one,two)=>Math.hypot(one.x-two.x,one.y-two.y);
      assert(spawns.every((point,index)=>spawns.slice(index+1).every(other=>byDistance(point,other)>4*HULL_RADIUS)));
      const isWall=(x,y)=>walls.some(wall=>x>=wall.x&&x<=wall.x+wall.w&&y>=wall.y&&y<=wall.y+wall.h);
      const queue=[[0,0]],visited=new Set(['0,0']);
      let routes=0;
      for(const [col,row] of queue){
        const from=cellCenter(col,row,players);
        assert(!isWall(from.x,from.y));
        for(const [nextCol,nextRow] of [[col+1,row],[col-1,row],[col,row+1],[col,row-1]]){
          if(nextCol<0||nextCol>=columns||nextRow<0||nextRow>=rows)continue;
          const to=cellCenter(nextCol,nextRow,players);
          if(isWall((from.x+to.x)/2,(from.y+to.y)/2))continue;
          if(nextCol>col||nextRow>row)routes++;
          const key=[nextCol,nextRow].join(',');
          if(visited.has(key))continue;
          visited.add(key);queue.push([nextCol,nextRow]);
        }
      }
      assert.equal(visited.size,rows*columns);
      assert(routes>rows*columns+1);
      assert(width*height>lastArea);
      cover+=walls.length;
    }
    const {width,height}=arenaFor(0,players);
    lastArea=width*height;
    assert(cover>lastCover);
    lastCover=cover;
  }
});

test('normal shells survive until their extended lifetime in an open corridor',()=>{
  const arena=createArena(29);
  Object.assign(arena.tanks[0],cellCenter(4,0),{hull:Math.PI/2});
  advanceArena(arena,fireInput,interval);
  Object.assign(arena.tanks[0],cellCenter(3,0));
  for(let tick=0;tick<(SHELL_LIFETIME-.5)*TICK_RATE;tick++)advanceArena(arena,noInput,interval);
  assert.equal(arena.shots.length,1);
  assert(arena.shots[0].bounces<SHELL_BOUNCES);
  for(let tick=0;tick<TICK_RATE;tick++)advanceArena(arena,noInput,interval);
  assert.equal(arena.shots.length,0);
});

test('each two-player crate selects a safe separate cell and the first batch can contain every kind',()=>{
  const positions=new Set(),firstKinds=new Set();
  let mirrored=0;
  for(let index=0;index<160;index++){
    const arena=createArena(Math.imul(index,0x9e3779b1));
    arena.supplyWait=0;
    advanceArena(arena,noInput,interval);
    const [first,second]=arena.pickups;
    assert.notEqual(first.kind,second.kind);
    firstKinds.add(first.kind);firstKinds.add(second.kind);
    positions.add(`${first.x},${first.y}`);
    if(first.x+second.x===arena.width&&first.y+second.y===arena.height)mirrored++;
    assert(Math.hypot(second.x-first.x,second.y-first.y)>28);
    for(const point of arena.pickups){
      assert(arena.tanks.every(tank=>Math.hypot(point.x-tank.x,point.y-tank.y)>HULL_RADIUS+14));
      for(const {x,y,w,h} of arena.walls){
        const wallX=Math.max(x,Math.min(point.x,x+w)),wallY=Math.max(y,Math.min(point.y,y+h));
        assert(Math.hypot(point.x-wallX,point.y-wallY)>=14);
      }
    }
  }
  assert.deepEqual(firstKinds,new Set(Object.keys(SUPPLIES)));
  assert(positions.size>20);
  assert(mirrored<20);
});

test('restarting a short small round can keep dealing a shuffled cycle without repeating kinds',()=>{
  const bag=[],kinds=[];
  for(let round=0;kinds.length<Object.keys(SUPPLIES).length;round++){
    const arena=createArena(round,2,'beacon',bag);
    arena.supplyWait=0;
    advanceArena(arena,noInput,interval);
    kinds.push(...arena.pickups.map(pickup=>pickup.kind));
  }
  assert.deepEqual([...kinds].sort(),Object.keys(SUPPLIES).sort());
});

test('a crate cannot overlap another crate, a tank, or a wall in its selected cell',()=>{
  const arena=createArena(52);
  const [occupied,wall,otherCrate]=arena.supplyPoints;
  arena.walls=[{x:wall.x-8,y:wall.y-8,w:16,h:16}];
  Object.assign(arena.tanks[0],occupied);
  arena.pickups=[{...otherCrate,kind:'shield',id:99}];
  arena.supplyWait=0;
  advanceArena(arena,noInput,interval);
  const fresh=arena.pickups.filter(pickup=>pickup.id!==99);
  assert.equal(fresh.length,2);
  for(const point of fresh){
    assert(Math.hypot(point.x-occupied.x,point.y-occupied.y)>HULL_RADIUS+14);
    assert(Math.hypot(point.x-otherCrate.x,point.y-otherCrate.y)>28);
    assert(Math.hypot(point.x-wall.x,point.y-wall.y)>20);
    assert(!arena.supplyPoints.some(cell=>cell.x===point.x&&cell.y===point.y));
  }
});

test('collecting scatter applies one spread shot',()=>{
  const arena=createArena(52);
  const [first]=arena.tanks;
  Object.assign(first,cellCenter(4,1),{hull:Math.PI/2});
  arena.pickups=[{...first,kind:'scatter'}];
  advanceArena(arena,fireInput,interval);
  assert.equal(arena.shots.length,5);
  assert(arena.shots.every(shot=>shot.kind==='scatter'));
  assert.equal(new Set(arena.shots.map(shot=>shot.vx)).size,5);
  assert.equal(first.weapon,null);
});

test('the penetration cannon locks the hull while charging and during its two-second wall-piercing beam',()=>{
  const arena=createArena(0,4,'deathmatch');
  arena.walls=[{x:250,y:0,w:14,h:arena.height},{x:620,y:0,w:14,h:arena.height}];
  const [shooter,shielded,entrant,outside]=arena.tanks;
  Object.assign(shooter,{x:80,y:300,hull:0,weapon:'pulse'});
  Object.assign(shielded,{x:960,y:340,shield:true});
  Object.assign(entrant,{x:530,y:370});
  Object.assign(outside,{x:750,y:360});
  const moving=[{drive:1,turn:1,fire:false},neutralInput()];
  advanceArena(arena,[{...moving[0],fire:true},moving[1]],interval);
  assert.equal(shooter.pulseCharge,PULSE_CHARGE_SECONDS);
  const chargeTicks=Math.round(PULSE_CHARGE_SECONDS*TICK_RATE);
  for(let tick=1;tick<chargeTicks;tick++)advanceArena(arena,moving,interval);
  assert.equal(arena.shots.length,0);
  assert.deepEqual([shooter.x,shooter.y,shooter.hull],[80,300,0]);
  advanceArena(arena,moving,interval);
  assert.equal(shooter.pulseCharge,0);
  const [beam]=arena.shots;
  assert.equal(beam.kind,'pulse');
  assert.equal(beam.width,64);
  assert.deepEqual(beam.path,[{x:103,y:300},{x:arena.width,y:300}]);
  assert.equal(shielded.armor,1);
  assert.equal(shielded.shield,false);
  assert.equal(entrant.armor,1);
  for(let tick=0;tick<12;tick++)advanceArena(arena,moving,interval);
  entrant.y=330;
  advanceArena(arena,noInput,interval);
  assert.equal(entrant.armor,0);
  assert.equal(shielded.armor,1);
  for(let tick=14;tick<119;tick++)advanceArena(arena,noInput,interval);
  assert.equal(arena.shots[0],beam);
  assert.equal(shielded.armor,0);
  assert.equal(outside.armor,1);
  assert.equal(shooter.armor,1);
  advanceArena(arena,moving,interval);
  assert.equal(arena.shots.length,0);
  assert.deepEqual([shooter.x,shooter.y,shooter.hull],[80,300,0]);
  outside.y=300;
  advanceArena(arena,moving,interval);
  assert(shooter.x>80&&shooter.hull>0);
  assert.equal(outside.armor,1);
});

test('destroying a charging tank interrupts the penetration cannon',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[];
  const [charging,attacker]=arena.tanks;
  Object.assign(charging,{x:220,y:300,hull:0,weapon:'pulse'});
  Object.assign(attacker,{x:330,y:300,hull:Math.PI});
  advanceArena(arena,[fireInput[0],fireInput[0]],interval);
  assert(charging.pulseCharge>0);
  stepUntil(arena,()=>!charging.armor,40);
  assert.equal(charging.armor,0);
  assert.equal(charging.pulseCharge,0);
  for(let tick=0;tick<25;tick++)advanceArena(arena,noInput,interval);
  assert.equal(arena.shots.some(shot=>shot.kind==='pulse'),false);
});

test('a deployed mine triggers after arming when another tank steps into range',()=>{
  const arena=createArena(0);
  const [first,second]=arena.tanks;
  Object.assign(first,cellCenter(4,1),{weapon:'mine'});
  advanceArena(arena,fireInput,interval);
  assert.equal(arena.mines[0].armed,false);
  Object.assign(first,cellCenter(4,0));
  Object.assign(second,{x:arena.mines[0].x+5,y:arena.mines[0].y});
  assert.deepEqual(stepUntil(arena,()=>!second.armor),{winner:0,reason:'armor'});
});

test('gatling spins up, fires only while held, and retains its ammunition upon release',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[];
  const [first,second]=arena.tanks;
  Object.assign(first,{x:240,y:300,hull:0});
  Object.assign(second,{x:650,y:500});
  arena.pickups=[{...first,kind:'burst'}];
  for(let tick=0;tick<12;tick++)advanceArena(arena,fireInput,interval);
  assert.equal(arena.shots.length,0);
  assert.equal(first.weapon,'burst');
  assert.equal(first.gatlingAmmo,24);
  for(let tick=0;tick<32;tick++)advanceArena(arena,fireInput,interval);
  const loaded=first.gatlingAmmo;
  const fired=arena.nextShot;
  assert(loaded<21&&loaded>0);
  assert.equal(fired,24-loaded);
  assert(arena.shots.every(shot=>shot.kind==='burst'));
  for(let tick=0;tick<35;tick++)advanceArena(arena,noInput,interval);
  assert.equal(arena.nextShot,fired);
  assert.equal(first.gatlingAmmo,loaded);
  assert.equal(first.gatlingSpin,0);
  for(let tick=0;tick<240&&first.weapon;tick++)advanceArena(arena,fireInput,interval);
  assert.equal(first.weapon,null);
  assert.equal(arena.nextShot,24);
});

test('double barrel alternates real projectile origins and keeps its remaining ammunition',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[];
  const [first,second]=arena.tanks;
  Object.assign(first,{x:240,y:300,hull:0});
  Object.assign(second,{x:650,y:500});
  arena.pickups=[{...first,kind:'double'}];
  advanceArena(arena,fireInput,interval);
  assert.equal(arena.shots[0].y,293);
  assert.equal(first.doubleSide,1);
  assert.equal(first.doubleAmmo,7);
  for(let tick=0;tick<20&&arena.nextShot<2;tick++)advanceArena(arena,fireInput,interval);
  assert.equal(arena.shots[1].y,307);
  assert.equal(first.doubleSide,-1);
  assert.equal(first.doubleAmmo,6);
  assert.equal(first.weapon,'double');
});

test('speed and trajectory upgrades can coexist without unequipping the weapon',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[];
  const [first,second]=arena.tanks;
  Object.assign(first,{x:240,y:300,hull:0,weapon:'beam'});
  Object.assign(second,{x:650,y:500});
  arena.pickups=[{...first,kind:'boost'},{...first,kind:'aimer'}];
  advanceArena(arena,[{drive:1,turn:0,fire:false},neutralInput()],interval);
  assert(first.boostRemaining>6&&first.aimerRemaining>11);
  assert(Math.abs(first.x-240-MOVE_SPEED*1.3*interval)<.001);
  assert.equal(first.weapon,'beam');
});

test('the missile coasts briefly, then homes on a visible opponent even across a long corridor',()=>{
  const duel=walls=>{
    const arena=createArena(0,2,'deathmatch');
    arena.walls=walls;
    const [first,second]=arena.tanks;
    Object.assign(first,{x:240,y:300,hull:0,weapon:'seeker'});
    Object.assign(second,{x:900,y:250});
    advanceArena(arena,fireInput,interval);
    return arena;
  };
  const clear=duel([]);
  for(let tick=0;tick<SEEKER_ARM_SECONDS*TICK_RATE-2;tick++)advanceArena(clear,noInput,interval);
  assert.equal(clear.shots[0].target,null);
  assert.equal(clear.shots[0].vy,0);
  advanceArena(clear,noInput,interval);
  assert.equal(clear.shots[0].target,1);
  assert(clear.shots[0].vy<0);
  assert.deepEqual(stepUntil(clear,()=>!clear.tanks[1].armor),null);
  assert.equal(clear.kills[0],1);

  const blocked=duel([{x:865,y:170,w:14,h:200}]);
  for(let tick=0;tick<125;tick++)advanceArena(blocked,noInput,interval);
  assert.equal(blocked.shots[0].target,null);
  assert.equal(blocked.shots[0].vy,0);
  stepUntil(blocked,()=>blocked.shots[0]?.ricochets>0,30);
  assert(blocked.shots[0].vx<0);
  assert.equal(blocked.tanks[1].armor,1);
});

test('the missile can bounce freely before its tracker has armed',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[{x:330,y:150,w:14,h:300}];
  const [first,second]=arena.tanks;
  Object.assign(first,{x:240,y:300,hull:0,weapon:'seeker'});
  Object.assign(second,{x:780,y:300});
  advanceArena(arena,fireInput,interval);
  first.y-=120;
  stepUntil(arena,()=>arena.shots[0]?.ricochets>0,75);
  const [shot]=arena.shots;
  assert.equal(shot.ricochets,1);
  assert(shot.vx<0&&shot.arm>0);
  assert(Math.abs(Math.hypot(shot.vx,shot.vy)-248)<.001);
  assert.equal(shot.target,null);
});

test('the seeker retains a visible target, then switches immediately when it is blocked or unavailable',()=>{
  const arena=createArena(0,4,'deathmatch');
  arena.walls=[];
  const [shooter,first,second,third]=arena.tanks;
  Object.assign(shooter,{x:240,y:300,hull:0,weapon:'seeker'});
  Object.assign(first,{x:630,y:300});
  Object.assign(second,{x:690,y:374});
  Object.assign(third,{x:750,y:140});
  advanceArena(arena,fireInput,interval);
  const [shot]=arena.shots;
  stepUntil(arena,()=>shot.target===1);
  assert.equal(shot.target,1);

  Object.assign(second,{x:shot.x+110,y:shot.y+60});
  advanceArena(arena,noInput,interval);
  assert.equal(shot.target,1,'a closer tank should not steal a valid lock');

  arena.walls=[{x:shot.x+65,y:shot.y-20,w:14,h:40}];
  advanceArena(arena,noInput,interval);
  assert.equal(shot.target,2,'a visible tank takes over when the target is occluded');

  setArenaAvailability(arena,2,false);
  advanceArena(arena,noInput,interval);
  assert.equal(shot.target,3,'disconnecting the target immediately advances to the next visible tank');

  third.armor=0;
  setArenaAvailability(arena,2,true);
  arena.walls=[];
  advanceArena(arena,noInput,interval);
  assert.equal(shot.target,2,'destroying the target immediately advances to another living tank');
});

test('the seeker remembers an occluded target while bouncing and homes again when the shot clears',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[];
  const [shooter,opponent]=arena.tanks;
  Object.assign(shooter,{x:240,y:300,hull:0,weapon:'seeker'});
  Object.assign(opponent,{x:650,y:300});
  advanceArena(arena,fireInput,interval);
  const [shot]=arena.shots;
  stepUntil(arena,()=>shot.target===1);
  assert.equal(shot.target,1);

  arena.walls=[{x:shot.x+26,y:shot.y-45,w:14,h:90}];
  stepUntil(arena,()=>shot.ricochets>0,30);
  assert.equal(shot.ricochets,1);
  assert.equal(shot.target,1);
  assert(shot.vx<0);

  Object.assign(opponent,{x:shot.x-55,y:shot.y-105});
  advanceArena(arena,noInput,interval);
  assert.equal(shot.target,1);
  assert(shot.vy<0);

  setArenaAvailability(arena,1,false);
  advanceArena(arena,noInput,interval);
  assert.equal(shot.target,null,'a rocket must not target its own shooter after a bounce');
});

test('detonating a mine broadcasts its blast and shrapnel without charging a shield twice',()=>{
  const arena=createArena(0,3,'deathmatch');
  arena.walls=[];
  const [first,trigger,alongShard]=arena.tanks;
  Object.assign(first,{x:300,y:330,hull:0,weapon:'mine'});
  Object.assign(trigger,{x:700,y:300,shield:true});
  Object.assign(alongShard,{x:690,y:415});
  advanceArena(arena,fireInput,interval);
  const mine=arena.mines[0];
  assert.deepEqual(arena.effects,[]);
  first.x=110;
  Object.assign(trigger,{x:325,y:330});
  stepUntil(arena,()=>arena.effects.length>0);
  assert.deepEqual(arena.effects,[{kind:'mine',id:mine.id,x:300,y:330,owner:0}]);
  assert.equal(arena.mines.length,0);
  assert.equal(arena.shots.length,16);
  assert(arena.shots.every(shot=>shot.kind==='mineShard'));
  assert.equal(trigger.shield,false);
  const viable=arena.shots.find(shot=>Math.hypot(shot.vx,shot.vy)*shot.life>72);
  const speed=Math.hypot(viable.vx,viable.vy);
  Object.assign(alongShard,{x:300+viable.vx/speed*68,y:330+viable.vy/speed*68});
  stepUntil(arena,()=>!alongShard.armor,30);
  assert.equal(alongShard.armor,0);
  assert.equal(trigger.armor,1);
  assert.equal(arena.kills[0],1);
});

test('tanks already on a new mine must leave its range and step back in to trigger it',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[];
  const [first,second]=arena.tanks;
  Object.assign(first,{x:300,y:330,hull:0,weapon:'mine'});
  Object.assign(second,{x:340,y:330});
  advanceArena(arena,fireInput,interval);
  for(let tick=0;tick<60;tick++)advanceArena(arena,noInput,interval);
  assert.equal(arena.mines[0].armed,true);
  assert.deepEqual(arena.effects,[]);
  assert.equal(first.armor,1);
  assert.equal(second.armor,1);
  first.x=130;
  advanceArena(arena,noInput,interval);
  assert.equal(arena.mines.length,1);
  first.x=300;
  advanceArena(arena,noInput,interval);
  assert.equal(arena.mines.length,0);
  assert.equal(arena.effects[0].kind,'mine');
  assert.equal(first.armor,0);
  assert.equal(second.armor,0);
});

test('cluster shell bounces off walls, and then detonates when it encounters its shooter',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[{x:0,y:0,w:16,h:600}];
  const [first]=arena.tanks;
  Object.assign(first,{x:100,y:300,hull:Math.PI,weapon:'cluster'});
  advanceArena(arena,fireInput,interval);
  assert.equal(arena.shots[0].kind,'cluster');
  stepUntil(arena,()=>arena.shots[0]?.ricochets>0);
  assert.equal(arena.shots.length,1);
  assert.equal(arena.shots[0].kind,'cluster');
  assert.deepEqual(arena.effects,[]);
  stepUntil(arena,()=>arena.effects.length>0);
  assert.equal(arena.shots.length,30);
  assert(arena.shots.every(shot=>shot.kind==='fragment'&&shot.ricochets===0&&shot.bounces===0));
  assert.equal(first.armor,0);
  assert.deepEqual(arena.kills,[0,0]);
});

test('a fragment shell locks primary fire until the next trigger press detonates it',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[];
  const [first,second]=arena.tanks;
  Object.assign(first,{x:240,y:300,hull:0,weapon:'cluster'});
  Object.assign(second,{x:740,y:500});
  advanceArena(arena,fireInput,interval);
  for(let tick=0;tick<30;tick++)advanceArena(arena,fireInput,interval);
  assert.deepEqual(arena.shots.map(shot=>shot.kind),['cluster']);
  advanceArena(arena,noInput,interval);
  advanceArena(arena,fireInput,interval);
  assert(!arena.shots.some(shot=>shot.kind==='cluster'));
  assert.equal(arena.effects[0].kind,'cluster');
  const fragments=arena.shots.filter(shot=>shot.kind==='fragment');
  assert.equal(fragments.length,30);
  assert(new Set(fragments.map(shot=>Math.round(Math.hypot(shot.vx,shot.vy)))).size>17);
  assert(new Set(fragments.map(shot=>Math.round(shot.life*100))).size>15);
  assert(fragments.some(shot=>shot.life>.75&&Math.hypot(shot.vx,shot.vy)*shot.life>175));
  advanceArena(arena,fireInput,interval);
  assert(arena.shots.some(shot=>shot.kind==='shell'));
});

test('a cluster shell that never hits a tank detonates after its fuse, not at the wall',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[{x:0,y:0,w:16,h:600},{x:600,y:0,w:16,h:600}];
  const [first,second]=arena.tanks;
  Object.assign(first,{x:120,y:300,hull:Math.PI,weapon:'cluster'});
  Object.assign(second,{x:480,y:480});
  advanceArena(arena,fireInput,interval);
  first.y-=120;
  for(let tick=0;tick<350;tick++)advanceArena(arena,noInput,interval);
  assert.equal(arena.effects.length,0);
  assert(arena.shots[0].ricochets>=2);
  stepUntil(arena,()=>arena.effects.length>0,14);
  assert.equal(arena.effects[0].kind,'cluster');
  assert.equal(arena.shots.length,30);
  const closeToWall=arena.shots.find(shot=>shot.vx<0);
  closeToWall.x=21;closeToWall.vx=-280;
  advanceArena(arena,noInput,interval);
  assert(!arena.shots.includes(closeToWall));
});

test('a guided projectile temporarily takes turning input and leaves tank throttle available',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[];
  const [first,second]=arena.tanks;
  Object.assign(first,{x:240,y:300,hull:0,weapon:'guide'});
  Object.assign(second,{x:680,y:100});
  advanceArena(arena,fireInput,interval);
  const guide=arena.shots[0];
  assert.equal(guide.kind,'guide');
  const input=[{drive:1,turn:1,fire:true},neutralInput()];
  advanceArena(arena,input,interval);
  const initialHeading=Math.atan2(guide.vy,guide.vx);
  assert(initialHeading>0&&initialHeading<.01);
  for(let tick=0;tick<29;tick++)advanceArena(arena,input,interval);
  const heading=Math.atan2(guide.vy,guide.vx);
  assert(heading>.65&&heading<1.16);
  assert.equal(first.hull,0);
  assert.equal(first.y,300);
  assert(first.x>300);
  assert.equal(arena.shots.length,1);
  advanceArena(arena,noInput,interval);
  assert(Math.atan2(guide.vy,guide.vx)>heading);
  stepUntil(arena,()=>!arena.shots.length,500);
  advanceArena(arena,[{drive:0,turn:-1,fire:false},neutralInput()],interval);
  assert(first.hull<0);
});

test('a remote missile survives a wall and gains a fixed impulse in the reflected direction',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[{x:400,y:200,w:16,h:200}];
  const [first,second]=arena.tanks;
  Object.assign(first,{x:280,y:300,hull:0,weapon:'guide'});
  Object.assign(second,{x:700,y:510});
  advanceArena(arena,fireInput,interval);
  first.y-=100;
  const [shot]=arena.shots;
  stepUntil(arena,()=>shot.ricochets>0,80);
  assert.equal(arena.shots[0],shot);
  assert(shot.vx<0);
  assert(Math.abs(Math.hypot(shot.vx,shot.vy)-208)<.001);
  const heading=Math.atan2(shot.vy,shot.vx);
  advanceArena(arena,[{drive:0,turn:-1,fire:false},neutralInput()],interval);
  assert(Math.abs(Math.atan2(Math.sin(Math.atan2(shot.vy,shot.vx)-heading),
    Math.cos(Math.atan2(shot.vy,shot.vx)-heading)))<.01);
});

test('deathmatch excludes a self kill, respawns away from other tanks, and ends on the tenth opponent kill',()=>{
  const arena=createArena(34,3,'deathmatch');
  lineUp(arena);
  const deathSite={x:arena.tanks[1].x,y:arena.tanks[1].y};
  advanceArena(arena,fireInput,interval);
  assert.equal(stepUntil(arena,()=>!arena.tanks[1].armor),null);
  assert.deepEqual(arena.kills,[1,0,0]);
  assert.equal(arena.tanks[1].respawnRemaining,2);
  for(let tick=0;tick<60;tick++)advanceArena(arena,noInput,interval);
  assert.equal(arena.tanks[1].armor,0);
  assert.equal(stepUntil(arena,()=>arena.tanks[1].armor>0,70),null);
  const respawn=arena.tanks[1];
  assert.equal(respawn.respawnRemaining,null);
  assert(respawn.spawnGrace>0);
  for(const other of [deathSite,arena.tanks[0],arena.tanks[2]])
    assert(Math.hypot(respawn.x-other.x,respawn.y-other.y)>2*HULL_RADIUS);

  Object.assign(arena.tanks[0],cellCenter(0,2,3),{hull:Math.PI,shotWait:0});
  advanceArena(arena,fireInput,interval);
  assert.equal(stepUntil(arena,()=>!arena.tanks[0].armor,40),null);
  assert.deepEqual(arena.kills,[1,0,0]);
  stepUntil(arena,()=>arena.tanks[0].armor>0);

  lineUp(arena);
  arena.kills[0]=MODES.deathmatch.scoreToWin-1;
  advanceArena(arena,fireInput,interval);
  assert.deepEqual(stepUntil(arena,()=>!arena.tanks[1].armor),{winner:0,reason:'kills'});
  assert.deepEqual(arena.kills,[10,0,0]);
  assert.equal(arena.remaining,null);
});

test('an elimination round continues past its first casualty and awards its final survivor',()=>{
  const arena=createArena(7,3,'elimination');
  lineUp(arena);
  advanceArena(arena,fireInput,interval);
  assert.equal(stepUntil(arena,()=>!arena.tanks[1].armor),null);
  assert.equal(arena.tanks[1].respawnRemaining,null);
  Object.assign(arena.tanks[2],arena.tanks[1]);
  arena.tanks[2].armor=1;
  arena.tanks[0].shotWait=0;
  advanceArena(arena,fireInput,interval);
  assert.deepEqual(stepUntil(arena,()=>!arena.tanks[2].armor),{winner:0,reason:'armor'});
});

test('a last opponent self-destructing ends an elimination round without awarding a point',()=>{
  const arena=createArena(0,2,'elimination');
  arena.tanks[0].hull=Math.PI;
  advanceArena(arena,fireInput,interval);
  assert.deepEqual(stepUntil(arena,()=>!arena.tanks[0].armor),{winner:null,reason:'self-destruction'});
  assert.deepEqual(arena.blasts.map(({seat,owner})=>[seat,owner]),[[0,0]]);
  assert.equal(arena.tanks[1].armor,1);
});

test('disconnected tanks leave the battlefield and reappear at a free cell if their old position is occupied',()=>{
  const arena=createArena(7,3,'elimination');
  lineUp(arena);
  const [first,absent,other]=arena.tanks;
  setArenaAvailability(arena,1,false);
  advanceArena(arena,fireInput,interval);
  for(let tick=0;tick<40;tick++)assert.equal(advanceArena(arena,noInput,interval),null);
  assert.equal(absent.armor,1);
  assert.equal(arena.shots.length,1);
  Object.assign(other,{x:absent.x,y:absent.y});
  setArenaAvailability(arena,1,true);
  assert(Math.hypot(absent.x-other.x,absent.y-other.y)>2*HULL_RADIUS);
  assert(absent.spawnGrace>0);

  arena.shots=[];
  setArenaAvailability(arena,1,false);
  lineUp(arena);
  Object.assign(other,{x:absent.x,y:absent.y});
  first.shotWait=0;
  advanceArena(arena,fireInput,interval);
  assert.deepEqual(stepUntil(arena,()=>!other.armor),{winner:0,reason:'armor'});
});

test('holding fire shoots standard shells on the 300 ms cooldown',()=>{
  const arena=createArena(0,2,'deathmatch');
  Object.assign(arena.tanks[0],cellCenter(4,1),{hull:Math.PI/2});
  for(let tick=0;tick<18;tick++)advanceArena(arena,fireInput,interval);
  assert.equal(arena.nextShot,1);
  advanceArena(arena,fireInput,interval);
  assert.equal(arena.nextShot,2);
  for(let tick=0;tick<17;tick++)advanceArena(arena,fireInput,interval);
  assert.equal(arena.nextShot,2);
  advanceArena(arena,fireInput,interval);
  assert.equal(arena.nextShot,3);
});

test('settling still allows pickups and damage with the scored outcome frozen',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[];
  const [first,second]=arena.tanks;
  Object.assign(first,{x:240,y:300,hull:0});
  Object.assign(second,{x:400,y:300});
  arena.kills[0]=9;
  arena.pickups.push({id:1,kind:'shield',x:first.x,y:first.y});
  function step(inputs){
    assert.equal(advanceArena(arena,inputs,interval,{scoringLocked:true}),null);
  }
  step(fireInput);
  assert.equal(first.shield,true);
  assert.equal(arena.pickups.length,0);
  for(let tick=0;tick<40&&second.armor;tick++)step(noInput);
  assert.equal(second.armor,0);
  assert.equal(arena.blasts.at(-1).seat,1);
  assert.deepEqual(arena.kills,[9,0]);
  assert.equal(arena.winningKill,null);
  for(let tick=0;tick<125&&!arena.tanks[1].armor;tick++)step(noInput);
  assert.equal(arena.tanks[1].armor,1);
});

test('relay points accrue only under exclusive control and the beacon moves to a distant open cell',()=>{
  const arena=createArena(11,3,'relay');
  const [first,second]=arena.tanks;
  const original={x:arena.beacon.x,y:arena.beacon.y};
  Object.assign(first,original);
  Object.assign(second,{x:original.x+24,y:original.y});
  for(let tick=0;tick<60;tick++)assert.equal(advanceArena(arena,noInput,interval),null);
  assert.deepEqual(arena.relayScore,[0,0,0]);
  assert.deepEqual(arena.capture,[0,0,0]);
  Object.assign(second,arena.spawns[1]);
  for(let tick=0;tick<30;tick++)advanceArena(arena,noInput,interval);
  Object.assign(second,{x:original.x+24,y:original.y});
  for(let tick=0;tick<30;tick++)advanceArena(arena,noInput,interval);
  assert.equal(arena.relayScore[0],0);
  Object.assign(second,arena.spawns[1]);
  for(let tick=0;tick<30;tick++)advanceArena(arena,noInput,interval);
  assert.equal(arena.relayScore[0],1);
  Object.assign(first,arena.spawns[0]);
  assert.equal(stepUntil(arena,()=>arena.beacon.x!==original.x||arena.beacon.y!==original.y,470),null);
  assert(Math.hypot(arena.beacon.x-original.x,arena.beacon.y-original.y)>=.31*Math.min(arena.width,arena.height));
  assert(arena.cells.some(point=>point.x===arena.beacon.x&&point.y===arena.beacon.y));
  assert(arena.tanks.every(tank=>Math.hypot(arena.beacon.x-tank.x,arena.beacon.y-tank.y)>=arena.beacon.radius+HULL_RADIUS));
  assert.equal(arena.beaconMoveRemaining,10);

  Object.assign(first,{x:arena.beacon.x,y:arena.beacon.y});
  arena.relayScore[0]=MODES.relay.scoreToWin-1;
  let outcome;
  for(let tick=0;tick<61&&!outcome;tick++)outcome=advanceArena(arena,noInput,interval);
  assert.deepEqual(outcome,{winner:0,reason:'relay'});
  assert.deepEqual(arena.relayScore,[20,0,0]);
});

test('a contested beacon stays neutral and an unopposed tank captures it',()=>{
  const arena=createArena(1);
  Object.assign(arena.tanks[0],{x:BEACON.x-23,y:BEACON.y});
  Object.assign(arena.tanks[1],{x:BEACON.x+23,y:BEACON.y});
  for(let tick=0;tick<300;tick++)assert.equal(advanceArena(arena,noInput,interval),null);
  assert.deepEqual(arena.capture,[0,0]);
  arena.tanks[1].x=BEACON.x+BEACON.radius+40;
  let outcome;
  for(let tick=0;tick<300&&!outcome;tick++)outcome=advanceArena(arena,noInput,interval);
  assert.deepEqual(outcome,{winner:0,reason:'beacon'});
});

test('all modes have no global timeout for an idle match',()=>{
  for(const mode of Object.keys(MODES)){
    const arena=createArena(4,2,mode);
    for(let step=0;step<10;step++)assert.equal(advanceArena(arena,noInput,15),null);
    assert.equal(arena.remaining,null);
  }
});

test('the arena accepts only bounded movement, steering and fire input',()=>{
  assert.deepEqual(normalizeInput(neutralInput()),neutralInput());
  assert.equal(normalizeInput({...neutralInput(),drive:2}),null);
  assert.equal(normalizeInput({...neutralInput(),turn:-2}),null);
  assert.equal(normalizeInput({...neutralInput(),fire:'true'}),null);
});
