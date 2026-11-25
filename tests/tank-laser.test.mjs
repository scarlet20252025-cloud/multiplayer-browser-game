import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LASER_RANGE, LASER_REFLECTIONS, LASER_SPEED, LASER_WAVE_LENGTH, laserPath} from '../public/tank-arena/laser-path.mjs';
import {MAX_PLAYERS, MIN_PLAYERS, TICK_RATE, TURN_SPEED} from '../public/tank-arena/rules.mjs';
import {advanceArena, advanceLaserEffects, createArena, neutralInput} from '../server/tank-arena-sim.mjs';

const interval=1/TICK_RATE;
const box=(width,height)=>[
  {x:0,y:0,w:10,h:height},{x:width-10,y:0,w:10,h:height},
  {x:0,y:0,w:width,h:10},{x:0,y:height-10,w:width,h:10},
];
const pointsLength=path=>path.slice(1).reduce((length,point,index)=>
  length+Math.hypot(point.x-path[index].x,point.y-path[index].y),0);

function assertPoint(point,x,y){
  assert(Math.abs(point.x-x)<.000001);
  assert(Math.abs(point.y-y)<.000001);
}

function advanceUntil(arena,predicate){
  let outcome=null;
  for(let tick=0;tick<140&&!predicate();tick++)outcome=advanceArena(arena,[],interval);
  assert(predicate());
  return outcome;
}

test('the shared laser traces multiple wall surfaces and stays within its total range',()=>{
  const path=laserPath({x:50,y:70},Math.atan2(1,2),box(200,200));
  assert.equal(path.length,LASER_REFLECTIONS+2);
  assertPoint(path[0],50,70);
  assertPoint(path[1],188,139);
  assertPoint(path[2],90,188);
  assertPoint(path[3],12,149);
  assertPoint(path[4],188,61);
  assertPoint(path[5],90,12);
  assert(pointsLength(path)<LASER_RANGE);

  const unobstructed=laserPath({x:50,y:70},0,[]);
  assert.equal(unobstructed.length,2);
  assertPoint(unobstructed[1],50+LASER_RANGE,70);
  assert.equal(pointsLength(unobstructed),LASER_RANGE);
});

test('a laser hitting a wall joint reverses both axes without repeating the same point',()=>{
  const path=laserPath({x:90,y:90},-3*Math.PI/4,box(200,200));
  assert.equal(path.length,LASER_REFLECTIONS+2);
  assertPoint(path[1],12,12);
  assertPoint(path[2],188,188);
  assertPoint(path[3],12,12);
  assertPoint(path[4],188,188);
  assertPoint(path[5],12,12);
  for(let index=1;index<path.length;index++){
    const before=path[index-1],after=path[index];
    assert(Math.hypot(after.x-before.x,after.y-before.y)>100);
  }
  assert.deepEqual(laserPath({x:12,y:12},-3*Math.PI/4,box(200,200)),[{x:12,y:12}]);
});

test('actual spawn positions in generated mazes produce reflected and unobstructed previews',()=>{
  for(let seed=0;seed<30;seed++){
    for(let players=MIN_PLAYERS;players<=MAX_PLAYERS;players++){
      const arena=createArena(seed,players,'deathmatch');
      for(const tank of arena.tanks){
        for(const inputTicks of [-13,-5,0,7,14]){
          const heading=tank.hull+inputTicks*TURN_SPEED*interval;
          const path=laserPath(tank,heading,arena.walls);
          assert(path.length>=3,`No reflected leg on seed ${seed}, ${players} players, angle ${heading}`);
          assert(pointsLength(path)<=LASER_RANGE+.000001);
          for(let leg=1;leg<path.length;leg++){
            const from=path[leg-1],to=path[leg];
            for(let sample=1;sample<8;sample++){
              const x=from.x+(to.x-from.x)*sample/8,y=from.y+(to.y-from.y)*sample/8;
              assert(!arena.walls.some(wall=>x>wall.x&&x<wall.x+wall.w&&y>wall.y&&y<wall.y+wall.h));
            }
          }
        }
      }
    }
  }
});

test('a head-on reflection on a generated two-player map retraces the line and can hit its shooter',()=>{
  const arena=createArena(0,2,'deathmatch');
  const [shooter]=arena.tanks;
  shooter.weapon='beam';
  const preview=laserPath(shooter,shooter.hull,arena.walls);
  assert(preview.length>=3);
  const [origin,wall,returnEnd]=preview;
  assertPoint(origin,shooter.x,shooter.y);
  assert(preview.every(point=>Math.abs(point.y-origin.y)<.000001));
  assert((wall.x-origin.x)*(returnEnd.x-wall.x)<0);
  advanceArena(arena,[{...neutralInput(),fire:true}],interval);
  const [beam]=arena.shots;
  assert.deepEqual(beam.path,preview);
  advanceUntil(arena,()=>!shooter.armor);
  assert(beam.ricochets>=1);
  assert.deepEqual(arena.blasts.map(({owner,seat})=>[owner,seat]),[[0,0]]);
});

test('after actual driving and steering the reflected leg is angled and the fired path matches it',()=>{
  const arena=createArena(31,2,'deathmatch');
  const [shooter]=arena.tanks;
  for(let tick=0;tick<11;tick++)advanceArena(arena,[{drive:1,turn:1,fire:false}],interval);
  const preview=laserPath(shooter,shooter.hull,arena.walls);
  assert(preview.length>=3);
  const [a,b,c]=preview;
  const cross=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x);
  assert(Math.abs(cross)>.3*Math.hypot(b.x-a.x,b.y-a.y)*Math.hypot(c.x-b.x,c.y-b.y));
  shooter.weapon='beam';
  advanceArena(arena,[{...neutralInput(),fire:true}],interval);
  const [beam]=arena.shots;
  assert.deepEqual(beam.path,preview);
  advanceUntil(arena,()=>beam.ricochets>=1);
  assert(beam.front>Math.hypot(b.x-a.x,b.y-a.y));
});

test('a traveling laser hits only as its front arrives and a reflected pass cannot hit a shield target twice',()=>{
  const arena=createArena(0,4,'deathmatch');
  arena.walls=[...box(500,200),{x:330,y:10,w:14,h:180}];
  const [shooter,shielded,exposed,protectedTank]=arena.tanks;
  Object.assign(shooter,{x:120,y:100,hull:0,weapon:'beam'});
  Object.assign(shielded,{x:195,y:100,shield:true});
  Object.assign(exposed,{x:267,y:100});
  Object.assign(protectedTank,{x:400,y:100});
  const preview=laserPath(shooter,shooter.hull,arena.walls);

  advanceArena(arena,[{...neutralInput(),fire:true}],interval);
  const [beam]=arena.shots;
  assert.equal(beam.kind,'beam');
  assert.deepEqual(beam.path,preview);
  assert.equal(beam.front,LASER_SPEED*interval);
  assert.equal(beam.tail,0);
  assert.equal(beam.length,pointsLength(preview));
  assertPoint(preview[1],328,100);
  assert.equal(shielded.shield,true);
  assert.equal(exposed.armor,1);
  assert.equal(shooter.armor,1);

  advanceUntil(arena,()=>!shielded.shield);
  assert.equal(shielded.armor,1);
  assert.equal(exposed.armor,1);
  advanceUntil(arena,()=>!exposed.armor);
  assert.equal(exposed.armor,0);
  assert.equal(shooter.armor,1);
  advanceUntil(arena,()=>!shooter.armor);
  assert(beam.ricochets>0);
  assert(Math.abs(beam.front-beam.tail-LASER_WAVE_LENGTH)<.000001);
  assert.equal(shooter.armor,0);
  assert.equal(protectedTank.armor,1);
  assert.deepEqual(arena.blasts.map(blast=>blast.seat),[2,0]);
  assert.deepEqual(arena.kills,[1,0,0,0]);

  advanceUntil(arena,()=>beam.front===beam.length);
  assert.equal(beam.ricochets,LASER_REFLECTIONS);
  assert(beam.tail<beam.front);
  advanceUntil(arena,()=>!arena.shots.length);
  assert.equal(shielded.armor,1);
  assert.equal(arena.shots.length,0);
});

test('crossing into the trailing band behind its front does not count as a new hit',()=>{
  const arena=createArena(0,2,'deathmatch');
  arena.walls=[];
  const [shooter,other]=arena.tanks;
  Object.assign(shooter,{x:100,y:200,hull:0,weapon:'beam'});
  Object.assign(other,{x:200,y:270});
  advanceArena(arena,[{...neutralInput(),fire:true}],interval);
  const [beam]=arena.shots;
  advanceUntil(arena,()=>beam.front>220);
  assert(beam.tail<100&&beam.front>100);
  other.y=200;
  advanceArena(arena,[],interval);
  assert.equal(other.armor,1);
  assert.equal(arena.blasts.length,0);
});

test('after a decisive hit the laser tail drains without resolving more hits',()=>{
  const arena=createArena(0,3,'deathmatch');
  arena.walls=[];
  const [shooter,first,other]=arena.tanks;
  Object.assign(shooter,{x:100,y:200,hull:0,weapon:'beam'});
  Object.assign(first,{x:175,y:200});
  Object.assign(other,{x:355,y:200});
  arena.kills[0]=9;
  advanceArena(arena,[{...neutralInput(),fire:true}],interval);
  const [beam]=arena.shots;
  const outcome=advanceUntil(arena,()=>!first.armor);
  assert.deepEqual(outcome,{winner:0,reason:'kills'});
  const finishingFront=beam.front;
  advanceLaserEffects(arena,.4);
  assert(beam.front>finishingFront&&beam.front>other.x-shooter.x);
  assert(beam.tail>0);
  assert.equal(other.armor,1);
  advanceLaserEffects(arena,2);
  assert.deepEqual(arena.shots,[]);
});
