import {
  ARMOR, DEFAULT_MODE, HULL_RADIUS, MIN_PLAYERS, MODES, MOVE_SPEED, PULSE_CHARGE_SECONDS, SEEKER_ARM_SECONDS,
  SHELL_BOUNCES, SHELL_LIFETIME, SHELL_SPEED, SUPPLIES, TURN_SPEED, arenaFor, cellCenter, randomFrom, wrapAngle,
} from '../public/tank-arena/rules.mjs';
import {LASER_RADIUS, LASER_SPEED, LASER_WAVE_LENGTH, laserPath} from '../public/tank-arena/laser-path.mjs';

const SHELL_RADIUS=4;
const SHELL_INTERVAL=.30;
const SPECIAL_RECOVERY=.43;
const MAX_SHOTS=10;
const EPS=.000001;
const RESPAWN_SECONDS=2;
const SPAWN_GRACE=1.1;
const MINE_ARM=.7;
const MINE_RADIUS=43;
const MINE_SHARDS=16;
const CLUSTER_SHARDS=30;
const CLUSTER_RANGE_SCALE=1.3;
const RELAY_PERIOD=10;
const RELAY_RADIUS=43;
const GATLING_AMMO=24;
const GATLING_INTERVAL=.096;
const DOUBLE_AMMO=8;
const MISSILE_BOUNCE_BOOST=3;
const PULSE_DURATION=2;
const PULSE_WIDTH=64;
const PULSE_REHIT_DELAY=.4;
const UPGRADES={boost:{field:'boostRemaining',seconds:7},aimer:{field:'aimerRemaining',seconds:12}};
const SUPPLY_TYPES=Object.keys(SUPPLIES);
const SUPPLY_RADIUS=14;
const PROJECTILES={
  shell:{speed:SHELL_SPEED,bounces:SHELL_BOUNCES,life:SHELL_LIFETIME},
  scatter:{speed:310,bounces:7,life:4.5,angles:[-.28,-.14,0,.14,.28]},
  pulse:{speed:1,bounces:0,life:PULSE_DURATION},
  burst:{speed:300,bounces:6,life:2.1},
  seeker:{speed:245,bounces:18,life:8,arm:SEEKER_ARM_SECONDS},
  cluster:{speed:255,bounces:0,life:6},
  fragment:{speed:1,bounces:0,life:.5},
  mineShard:{speed:1,bounces:0,life:.5},
  guide:{speed:205,bounces:18,life:8},
  double:{speed:SHELL_SPEED,bounces:14,life:7},
  beam:{speed:LASER_SPEED,bounces:0},
};

export const neutralInput=()=>({drive:0,turn:0,fire:false});

export function normalizeInput({drive,turn,fire}){
  if(![-1,0,1].includes(drive)||![-1,0,1].includes(turn)||typeof fire!=='boolean')return null;
  return {drive,turn,fire};
}

function createTank(point,hull,spawnGrace=0){
  return {...point,hull,armor:ARMOR,shotWait:0,damage:0,shield:false,weapon:null,fireHeld:false,
    gatlingAmmo:0,gatlingSpin:0,doubleAmmo:0,doubleSide:-1,boostRemaining:0,aimerRemaining:0,pulseCharge:0,
    respawnRemaining:null,spawnGrace,available:true,forfeited:false};
}

export function createArena(mapSeed,playerCount=MIN_PLAYERS,mode=DEFAULT_MODE,supplyBag=[]){
  const layout=arenaFor(mapSeed,playerCount);
  const cells=[];
  for(let row=0;row<layout.rows;row++)for(let col=0;col<layout.columns;col++)
    cells.push(cellCenter(col,row,playerCount));
  const awayFromSpawns=point=>layout.spawns.every(spawn=>distance(point,spawn)>HULL_RADIUS*2);
  const supplyPoints=cells.filter(point=>awayFromSpawns(point)&&distance(point,layout.beacon)>layout.beacon.radius+8);
  const relay=mode==='relay';
  return {...layout,mode,cells,supplyPoints,scoringLocked:false,
    beacon:relay?{...layout.beacon,radius:RELAY_RADIUS,captureSeconds:1}:layout.beacon,
    beaconMoveRemaining:relay?RELAY_PERIOD:null,
    remaining:null,
    shots:[],mines:[],nextShot:0,blasts:[],nextBlast:0,effects:[],pickups:[],supplyBag,supplyWait:4,nextSupply:0,
    random:randomFrom(mapSeed^0xd379ad85),capture:Array(playerCount).fill(0),
    kills:Array(playerCount).fill(0),winningKill:null,relayScore:Array(playerCount).fill(0),
    tanks:layout.spawns.map(point=>createTank(point,Math.atan2(layout.beacon.y-point.y,layout.beacon.x-point.x))),
  };
}

const distance=(one,two)=>Math.hypot(one.x-two.x,one.y-two.y);
const inPlay=tank=>tank.available&&tank.armor>0;

export function reserveArenaSeat(arena,seat){
  const tank=createTank(arena.spawns[seat]??{x:arena.beacon.x,y:arena.beacon.y},0);
  tank.armor=0;tank.available=false;
  arena.tanks[seat]=tank;
  arena.capture[seat]=0;arena.kills[seat]=0;arena.relayScore[seat]=0;
}

export function enterArenaSeat(arena,seat){
  const tank=arena.tanks[seat];
  const site=safeSpawnPoint(arena,tank,{avoidBeacon:true});
  if(!site)return;
  const hull=Math.atan2(arena.beacon.y-site.y,arena.beacon.x-site.x);
  arena.tanks[seat]=createTank(site,hull,SPAWN_GRACE);
}

export function setArenaAvailability(arena,seat,available,lateEntry=false){
  const tank=arena.tanks[seat];
  tank.available=available;
  if(!available){
    if(arena.mode!=='relay')arena.capture[seat]=0;
    return;
  }
  if(!tank.armor)return;
  const occupied=arena.tanks.some(other=>other!==tank&&inPlay(other)&&distance(other,tank)<2*HULL_RADIUS);
  if(occupied){
    const point=safeSpawnPoint(arena,tank);
    if(point)Object.assign(tank,point,{spawnGrace:SPAWN_GRACE});
  }
  if(lateEntry)tank.spawnGrace=Math.max(tank.spawnGrace,SPAWN_GRACE);
}

export function forfeitArenaSeat(arena,seat){
  const tank=arena.tanks[seat];
  tank.armor=0;tank.shield=false;tank.weapon=null;tank.gatlingSpin=0;tank.gatlingAmmo=0;tank.doubleAmmo=0;tank.pulseCharge=0;
  tank.respawnRemaining=null;tank.available=false;tank.forfeited=true;
  arena.capture[seat]=0;
  arena.shots=arena.shots.filter(shot=>shot.owner!==seat);
  arena.mines=arena.mines.filter(mine=>mine.owner!==seat);
}

function overlaps(x,y,r,wall){
  const nx=Math.max(wall.x,Math.min(x,wall.x+wall.w));
  const ny=Math.max(wall.y,Math.min(y,wall.y+wall.h));
  return (x-nx)**2+(y-ny)**2<r*r;
}

function shiftTank(tank,tanks,input,walls,dt){
  tank.hull=wrapAngle(tank.hull+TURN_SPEED*input.turn*dt);
  if(!input.drive)return;
  const step=MOVE_SPEED*(tank.boostRemaining>0?1.30:1)*dt*input.drive;
  const clear=(x,y)=>tanks.every(other=>other===tank||!inPlay(other)||Math.hypot(x-other.x,y-other.y)>=2*HULL_RADIUS)&&
    !walls.some(wall=>overlaps(x,y,HULL_RADIUS,wall));
  const x=tank.x+Math.cos(tank.hull)*step,y=tank.y+Math.sin(tank.hull)*step;
  if(clear(x,tank.y))tank.x=x;
  if(clear(tank.x,y))tank.y=y;
}

function wallImpact(shot,dx,dy,wall){
  const left=wall.x-SHELL_RADIUS,right=wall.x+wall.w+SHELL_RADIUS;
  const top=wall.y-SHELL_RADIUS,bottom=wall.y+wall.h+SHELL_RADIUS;
  if(Math.abs(dx)<EPS&&(shot.x<left||shot.x>right))return null;
  if(Math.abs(dy)<EPS&&(shot.y<top||shot.y>bottom))return null;
  const tx1=Math.abs(dx)<EPS?-Infinity:(left-shot.x)/dx;
  const tx2=Math.abs(dx)<EPS?Infinity:(right-shot.x)/dx;
  const ty1=Math.abs(dy)<EPS?-Infinity:(top-shot.y)/dy;
  const ty2=Math.abs(dy)<EPS?Infinity:(bottom-shot.y)/dy;
  const enterX=Math.min(tx1,tx2),enterY=Math.min(ty1,ty2);
  const enter=Math.max(enterX,enterY),exit=Math.min(Math.max(tx1,tx2),Math.max(ty1,ty2));
  if(enter<0||enter>1||enter>exit)return null;
  return {time:enter,flipX:enterX>=enterY-EPS,flipY:enterY>=enterX-EPS};
}

function tankImpact(shot,dx,dy,tank,projectileRadius=SHELL_RADIUS){
  const x=shot.x-tank.x,y=shot.y-tank.y;
  const a=dx*dx+dy*dy;
  const b=x*dx+y*dy;
  const c=x*x+y*y-(HULL_RADIUS+projectileRadius)**2;
  if(c<=0)return 0;
  const discriminant=b*b-a*c;
  if(discriminant<0||a<EPS)return Infinity;
  const time=(-b-Math.sqrt(discriminant))/a;
  return time>=0&&time<=1?time:Infinity;
}

function hitTank(arena,seat,owner){
  const tank=arena.tanks[seat];
  if(!tank.armor||tank.spawnGrace>0)return;
  tank.damage=.22;
  if(tank.shield){tank.shield=false;return;}
  tank.armor=0;
  tank.weapon=null;tank.gatlingSpin=0;tank.gatlingAmmo=0;tank.doubleAmmo=0;tank.pulseCharge=0;
  tank.boostRemaining=0;tank.aimerRemaining=0;
  if(arena.mode!=='relay')arena.capture[seat]=0;
  arena.blasts.push({id:++arena.nextBlast,seat,owner,x:tank.x,y:tank.y,hull:tank.hull});
  if(arena.blasts.length>18)arena.blasts.shift();
  if(MODES[arena.mode].respawns)tank.respawnRemaining=RESPAWN_SECONDS;
  if(arena.scoringLocked||arena.mode!=='deathmatch')return;
  if(arena.winningKill===null&&owner!==seat&&!arena.tanks[owner].forfeited){
    arena.kills[owner]++;
    if(arena.kills[owner]>=MODES.deathmatch.scoreToWin)arena.winningKill=owner;
  }
}

function makeShot(arena,owner,origin,angle,kind,ricochets=0){
  const {speed,bounces,life,arm}=PROJECTILES[kind];
  return {id:++arena.nextShot,owner,x:origin.x,y:origin.y,vx:Math.cos(angle)*speed,vy:Math.sin(angle)*speed,
    kind,bounces,ricochets,life,arm,...(kind==='beam'?{heading:angle}:{})};
}

function trackTarget(shot,arena,dt){
  shot.arm=Math.max(0,shot.arm-dt);
  if(shot.arm>EPS){shot.target=null;return;}
  const eligible=(tank,seat)=>seat!==shot.owner&&inPlay(tank)&&tank.spawnGrace<=0;
  const visible=tank=>!arena.walls.some(wall=>wallImpact(shot,tank.x-shot.x,tank.y-shot.y,wall));
  const current=arena.tanks[shot.target];
  let target=current&&eligible(current,shot.target)?current:null;
  if(!target||!visible(target)){
    let nearest=Infinity,visibleSeat=null;
    for(const [seat,tank] of arena.tanks.entries()){
      if(!eligible(tank,seat))continue;
      const range=distance(shot,tank);
      if(range>=nearest||!visible(tank))continue;
      nearest=range;visibleSeat=seat;
    }
    // Keep the target through occlusion, but let the rocket bounce until it has a clear shot.
    if(visibleSeat===null){
      if(!target)shot.target=null;
      return;
    }
    shot.target=visibleSeat;
    target=arena.tanks[visibleSeat];
  }
  const targetAngle=Math.atan2(target.y-shot.y,target.x-shot.x);
  const heading=Math.atan2(shot.vy,shot.vx);
  const limit=3.1*dt,delta=wrapAngle(targetAngle-heading);
  const angle=heading+Math.max(-limit,Math.min(limit,delta));
  const speed=Math.hypot(shot.vx,shot.vy);
  shot.vx=Math.cos(angle)*speed;shot.vy=Math.sin(angle)*speed;
}

function controlMissile(missile,turn,dt){
  const previous=missile.pull??0;
  const travel=5.5*dt;
  missile.pull=previous+Math.max(-travel,Math.min(travel,turn-previous));
  const {vx,vy}=missile,speed=Math.hypot(vx,vy);
  const sideways=missile.pull*485*dt/speed;
  const x=vx-vy*sideways,y=vy+vx*sideways;
  const scale=speed/Math.hypot(x,y);
  missile.vx=x*scale;missile.vy=y*scale;
}

function boostRicochet(shot){
  const speed=Math.hypot(shot.vx,shot.vy);
  const scale=1+MISSILE_BOUNCE_BOOST/speed;
  shot.vx*=scale;shot.vy*=scale;
}

function prepareBeam(shot,arena){
  shot.path=laserPath(shot,shot.heading,arena.walls);
  shot.length=0;shot.travel=0;shot.front=0;shot.tail=0;
  shot.hitSeats=new Set();
  shot.legs=shot.path.slice(1).map((point,index)=>{
    const from=shot.path[index];
    const dx=point.x-from.x,dy=point.y-from.y,length=Math.hypot(dx,dy);
    const start=shot.length;
    shot.length+=length;
    return {from,dx:dx/length,dy:dy/length,start,end:shot.length};
  });
  const firstEnd=shot.path[1]??shot;
  shot.vx=firstEnd.x-shot.x;shot.vy=firstEnd.y-shot.y;
}

function sweepBeamFront(shot,arena,previousFront){
  for(const [index,leg] of shot.legs.entries()){
    const fromDistance=Math.max(previousFront,leg.start);
    const endDistance=Math.min(shot.front,leg.end);
    if(endDistance<=fromDistance)continue;
    const offset=fromDistance-leg.start;
    const from={x:leg.from.x+leg.dx*offset,y:leg.from.y+leg.dy*offset};
    const span=endDistance-fromDistance,dx=leg.dx*span,dy=leg.dy*span;
    const targets=[];
    for(const [seat,tank] of arena.tanks.entries()){
      if((index===0&&seat===shot.owner)||shot.hitSeats.has(seat)||!inPlay(tank))continue;
      const time=tankImpact(from,dx,dy,tank,LASER_RADIUS);
      if(Number.isFinite(time))targets.push({seat,time});
    }
    targets.sort((a,b)=>a.time-b.time);
    for(const {seat} of targets){
      shot.hitSeats.add(seat);
      hitTank(arena,seat,shot.owner);
    }
  }
}

function stepBeam(shot,arena,dt,resolveHits){
  if(!shot.path)prepareBeam(shot,arena);
  const previousFront=shot.front;
  shot.travel+=LASER_SPEED*dt;
  shot.front=Math.min(shot.travel,shot.length);
  shot.tail=Math.max(0,Math.min(shot.travel-LASER_WAVE_LENGTH,shot.length));
  while(shot.ricochets+1<shot.legs.length&&shot.front>=shot.legs[shot.ricochets].end)shot.ricochets++;
  if(resolveHits&&shot.front>previousFront)sweepBeamFront(shot,arena,previousFront);
  return shot.tail<shot.length;
}

function preparePulse(shot,arena){
  const {x,y,vx,vy}=shot;
  const toVertical=Math.abs(vx)>EPS?((vx>0?arena.width:0)-x)/vx:Infinity;
  const toHorizontal=Math.abs(vy)>EPS?((vy>0?arena.height:0)-y)/vy:Infinity;
  const edge=Math.min(toVertical,toHorizontal);
  const muzzle=Math.min(23,edge);
  shot.x=x+vx*muzzle;
  shot.y=y+vy*muzzle;
  shot.width=PULSE_WIDTH;
  shot.length=edge-muzzle;
  shot.path=[{x:shot.x,y:shot.y},{x:x+vx*edge,y:y+vy*edge}];
  shot.nextHit=new Map();
}

function stepPulse(shot,arena,dt,resolveHits){
  if(!shot.path)preparePulse(shot,arena);
  if(resolveHits){
    const age=PULSE_DURATION-shot.life;
    for(const [seat,tank] of arena.tanks.entries()){
      if(seat===shot.owner||!inPlay(tank)||tank.spawnGrace>0||age+EPS<(shot.nextHit.get(seat)??0))continue;
      const dx=tank.x-shot.x,dy=tank.y-shot.y;
      const along=dx*shot.vx+dy*shot.vy;
      const side=Math.abs(dx*shot.vy-dy*shot.vx);
      const beyondLength=Math.max(0,-along,along-shot.length);
      const beyondWidth=Math.max(0,side-shot.width/2);
      if(beyondLength**2+beyondWidth**2>HULL_RADIUS**2)continue;
      shot.nextHit.set(seat,age+PULSE_REHIT_DELAY);
      hitTank(arena,seat,shot.owner);
    }
  }
  shot.life-=dt;
  return shot.life>EPS;
}

export function advanceLaserEffects(arena,dt){
  arena.shots=arena.shots.filter(shot=>{
    if(shot.kind==='beam')return stepBeam(shot,arena,dt,false);
    if(shot.kind==='pulse')return stepPulse(shot,arena,dt,false);
    return true;
  });
}

function stepShot(shot,arena,dt,fragments){
  if(shot.kind==='beam')return stepBeam(shot,arena,dt,true);
  if(shot.kind==='pulse')return stepPulse(shot,arena,dt,true);
  shot.life-=dt;
  if(shot.life<=0){
    if(shot.kind==='cluster')detonateCluster(arena,shot,fragments);
    return false;
  }
  if(shot.kind==='seeker')trackTarget(shot,arena,dt);
  let remaining=dt;
  for(let collision=0;remaining>EPS&&collision<8;collision++){
    const dx=shot.vx*remaining,dy=shot.vy*remaining;
    let wall=null;
    for(const candidate of arena.walls){
      const impact=wallImpact(shot,dx,dy,candidate);
      if(!impact)continue;
      if(!wall||impact.time<wall.time-EPS)wall=impact;
      else if(Math.abs(impact.time-wall.time)<=EPS){
        wall.flipX||=impact.flipX;wall.flipY||=impact.flipY;
      }
    }
    let hit=Infinity,target=-1;
    for(const [seat,tank] of arena.tanks.entries()){
      if(!inPlay(tank)||shot.explosionHits?.has(seat)||(seat===shot.owner&&!shot.ricochets&&!shot.explosionHits))continue;
      const time=tankImpact(shot,dx,dy,tank);
      if(time<hit){hit=time;target=seat;}
    }
    if(target!==-1&&hit<=(wall?.time??1)){
      shot.explosionHits?.add(target);
      hitTank(arena,target,shot.owner);
      if(shot.kind==='cluster'){
        shot.x+=dx*hit;shot.y+=dy*hit;
        detonateCluster(arena,shot,fragments,new Set([target]));
      }
      return false;
    }
    if(!wall){shot.x+=dx;shot.y+=dy;return true;}
    if(!shot.bounces&&shot.kind!=='cluster')return false;
    shot.x+=dx*wall.time;shot.y+=dy*wall.time;
    if(wall.flipX)shot.vx=-shot.vx;
    if(wall.flipY)shot.vy=-shot.vy;
    if(shot.kind==='seeker'||shot.kind==='guide')boostRicochet(shot);
    shot.x+=shot.vx*EPS;shot.y+=shot.vy*EPS;
    if(shot.kind!=='cluster')shot.bounces--;
    shot.ricochets++;remaining*=1-wall.time;
  }
  return true;
}

function armaments(arena,seat){
  const tank=arena.tanks[seat];
  const weapon=tank.weapon;
  if(weapon==='mine'){
    if(arena.mines.some(mine=>mine.owner===seat))return;
    const mine={id:++arena.nextShot,x:tank.x,y:tank.y,owner:seat,armed:false,arm:MINE_ARM,life:11};
    mine.placementContacts=mineContacts(arena,mine);
    arena.mines.push(mine);
  }else{
    const kind=weapon??'shell';
    const offsets=PROJECTILES[kind].angles??[0];
    const active=arena.shots.filter(shot=>shot.owner===seat&&!shot.explosionHits).length;
    if(kind!=='pulse'&&active+offsets.length>MAX_SHOTS)return;
    let origin=tank;
    if(kind==='double'){
      const lateral=tank.doubleSide*7;
      origin={x:tank.x-Math.sin(tank.hull)*lateral,y:tank.y+Math.cos(tank.hull)*lateral};
      tank.doubleSide*=-1;
    }
    for(const offset of offsets)arena.shots.push(makeShot(arena,seat,origin,tank.hull+offset,kind));
    if(kind==='double'&&--tank.doubleAmmo>0){
      tank.shotWait=.25;
      return;
    }
  }
  tank.weapon=null;
  tank.shotWait=weapon===null?SHELL_INTERVAL:SPECIAL_RECOVERY;
}

function fireGatling(arena,tank,seat,fire,dt){
  tank.gatlingSpin=Math.max(0,Math.min(1,tank.gatlingSpin+(fire?dt/.24:-dt/.43)));
  if(!fire||tank.gatlingSpin<1-EPS||tank.shotWait>EPS)return;
  const spread=(arena.random()-.5)*.084;
  arena.shots.push(makeShot(arena,seat,tank,tank.hull+spread,'burst'));
  if(--tank.gatlingAmmo>0){tank.shotWait=GATLING_INTERVAL;return;}
  tank.weapon=null;tank.gatlingSpin=0;tank.shotWait=SPECIAL_RECOVERY;
}

function releaseDebris(arena,source,kind,count,destination,explosionHits){
  const rangeScale=kind==='fragment'?CLUSTER_RANGE_SCALE:1;
  for(let index=0;index<count;index++){
    const angle=arena.random()*2*Math.PI;
    const speed=108+arena.random()*183;
    const shard=makeShot(arena,source.owner,source,angle,kind);
    shard.vx*=speed;shard.vy*=speed;
    shard.life=(.17+arena.random()*.49)*rangeScale;
    shard.explosionHits=explosionHits;
    destination.push(shard);
  }
}

function recordEffect(arena,source,kind){
  const {id,x,y,owner}=source;
  arena.effects.push({kind,id,x,y,owner});
  if(arena.effects.length>18)arena.effects.shift();
}

function detonateCluster(arena,shot,destination,explosionHits=new Set()){
  recordEffect(arena,shot,'cluster');
  releaseDebris(arena,shot,'fragment',CLUSTER_SHARDS,destination,explosionHits);
}

function mineContacts(arena,mine){
  const contacts=[];
  for(const [seat,tank] of arena.tanks.entries()){
    if(!inPlay(tank)||distance(mine,tank)>=MINE_RADIUS)continue;
    if(!arena.walls.some(wall=>wallImpact(mine,tank.x-mine.x,tank.y-mine.y,wall)))contacts.push(seat);
  }
  return contacts;
}

function stepMines(arena,dt){
  arena.mines=arena.mines.filter(mine=>{
    mine.life-=dt;mine.arm-=dt;mine.armed=mine.arm<=0;
    if(mine.life<=0)return false;
    const contacts=mineContacts(arena,mine);
    mine.placementContacts=mine.placementContacts.filter(seat=>contacts.includes(seat));
    if(!mine.armed)return true;
    const victims=contacts.filter(seat=>arena.tanks[seat].spawnGrace<=0);
    if(!victims.some(seat=>!mine.placementContacts.includes(seat)))return true;
    const explosionHits=new Set(victims);
    for(const seat of victims)hitTank(arena,seat,mine.owner);
    recordEffect(arena,mine,'mine');
    releaseDebris(arena,mine,'mineShard',MINE_SHARDS,arena.shots,explosionHits);
    return false;
  });
}

function nextSupplyKind(arena){
  const bag=arena.supplyBag;
  if(bag.length===0){
    bag.push(...SUPPLY_TYPES);
    for(let index=bag.length-1;index>0;index--){
      const other=Math.floor(arena.random()*(index+1));
      [bag[index],bag[other]]=[bag[other],bag[index]];
    }
  }
  return bag.pop();
}

function sampleSupplyPoint(arena){
  const clearance=HULL_RADIUS+3;
  const clear=point=>
    arena.pickups.every(item=>distance(item,point)>2*SUPPLY_RADIUS)&&
    arena.tanks.every(tank=>!inPlay(tank)||distance(tank,point)>HULL_RADIUS+SUPPLY_RADIUS)&&
    arena.spawns.every(spawn=>distance(spawn,point)>2*HULL_RADIUS)&&
    distance(point,arena.beacon)>arena.beacon.radius+SUPPLY_RADIUS&&
    !arena.walls.some(wall=>overlaps(point.x,point.y,clearance,wall));
  for(let attempt=0;attempt<64;attempt++){
    const point={x:arena.width*arena.random(),y:arena.height*arena.random()};
    if(clear(point))return point;
  }
  const candidates=arena.supplyPoints.filter(clear);
  return candidates[Math.floor(arena.random()*candidates.length)];
}

function updateSupplies(arena,dt){
  arena.supplyWait-=dt;
  const count=arena.tanks.length;
  const batch=count===2?2:3;
  if(arena.supplyWait<=0&&arena.pickups.length<=count+2-batch){
    for(let index=0;index<batch;index++){
      const point=sampleSupplyPoint(arena);
      if(!point)break;
      arena.pickups.push({...point,kind:nextSupplyKind(arena),id:++arena.nextSupply});
    }
    arena.supplyWait=8;
  }
  arena.pickups=arena.pickups.filter(item=>{
    const upgrade=UPGRADES[item.kind];
    const tank=arena.tanks.find(tank=>inPlay(tank)&&distance(tank,item)<HULL_RADIUS+SUPPLY_RADIUS&&
      (item.kind==='shield'?!tank.shield:upgrade?tank[upgrade.field]<=0:!tank.weapon));
    if(!tank)return true;
    if(item.kind==='shield')tank.shield=true;
    else if(upgrade)tank[upgrade.field]=upgrade.seconds;
    else {
      tank.weapon=item.kind;
      if(item.kind==='burst')tank.gatlingAmmo=GATLING_AMMO;
      if(item.kind==='double'){tank.doubleAmmo=DOUBLE_AMMO;tank.doubleSide=-1;}
    }
    return false;
  });
}

function safeSpawnPoint(arena,tank,{avoidBeacon=false}={}){
  const alive=arena.tanks.filter(other=>other!==tank&&inPlay(other));
  const sites=arena.cells.filter(point=>distance(point,tank)>HULL_RADIUS*2&&
    (!avoidBeacon||distance(point,arena.beacon)>arena.beacon.radius+HULL_RADIUS)&&
    alive.every(other=>distance(other,point)>HULL_RADIUS*2)).map(point=>{
      const playerRisk=Math.min(Infinity,...alive.map(other=>distance(other,point)));
      const projectileRisk=Math.min(Infinity,...arena.shots.map(shot=>distance(shot,point)));
      const mineRisk=Math.min(Infinity,...arena.mines.map(mine=>Math.max(0,distance(mine,point)-MINE_RADIUS)));
      return {point,safety:Math.min(playerRisk,projectileRisk*2,mineRisk*2)};
    }).sort((a,b)=>b.safety-a.safety);
  const pool=sites.slice(0,Math.max(3,Math.ceil(sites.length/4)));
  return pool[Math.floor(arena.random()*pool.length)]?.point;
}

function updateRespawn(arena,seat,dt){
  const tank=arena.tanks[seat];
  if(tank.respawnRemaining===null||!tank.available)return;
  tank.respawnRemaining=Math.max(0,tank.respawnRemaining-dt);
  if(tank.respawnRemaining>0)return;
  const choice=safeSpawnPoint(arena,tank);
  if(!choice)return;
  const hull=Math.atan2(arena.beacon.y-choice.y,arena.beacon.x-choice.x);
  arena.tanks[seat]=createTank(choice,hull,SPAWN_GRACE);
}

function advanceRelay(arena,dt){
  const occupying=arena.tanks.flatMap((tank,seat)=>inPlay(tank)&&distance(tank,arena.beacon)<arena.beacon.radius?[seat]:[]);
  if(occupying.length===1){
    const [seat]=occupying;
    arena.capture[seat]+=dt;
    if(arena.capture[seat]+EPS>=arena.beacon.captureSeconds){
      arena.capture[seat]=Math.max(0,arena.capture[seat]-arena.beacon.captureSeconds);
      if(++arena.relayScore[seat]>=MODES.relay.scoreToWin)return {winner:seat,reason:'relay'};
    }
  }
  arena.beaconMoveRemaining=Math.max(0,arena.beaconMoveRemaining-dt);
  if(arena.beaconMoveRemaining>EPS)return null;
  const minDistance=.31*Math.min(arena.width,arena.height);
  const sites=arena.cells.filter(point=>distance(point,arena.beacon)>=minDistance&&
    arena.tanks.every(tank=>!inPlay(tank)||distance(tank,point)>=arena.beacon.radius+HULL_RADIUS));
  const site=sites[Math.floor(sites.length*arena.random())];
  if(site)Object.assign(arena.beacon,site);
  arena.beaconMoveRemaining=RELAY_PERIOD;
  return null;
}

export function advanceArena(arena,inputs,dt,{scoringLocked=false}={}){
  const {tanks,walls}=arena;
  const previousBlast=arena.nextBlast;
  arena.scoringLocked=scoringLocked;
  const activeWeapons=new Map();
  for(const shot of arena.shots){
    if(shot.kind==='guide'||shot.kind==='cluster'||shot.kind==='pulse')activeWeapons.set(shot.owner,shot);
  }
  updateSupplies(arena,dt);
  for(const [seat,tank] of tanks.entries()){
    if(!tank.armor){
      updateRespawn(arena,seat,dt);
      continue;
    }
    tank.damage=Math.max(0,tank.damage-dt);
    tank.shotWait=Math.max(0,tank.shotWait-dt);
    tank.spawnGrace=Math.max(0,tank.spawnGrace-dt);
    tank.boostRemaining=Math.max(0,tank.boostRemaining-dt);
    tank.aimerRemaining=Math.max(0,tank.aimerRemaining-dt);
    if(!tank.available)continue;
    const input=inputs[seat]??neutralInput();
    const trigger=input.fire&&!tank.fireHeld;
    tank.fireHeld=input.fire;
    const active=activeWeapons.get(seat);
    if(active?.kind==='pulse')continue;
    if(tank.pulseCharge>0){
      tank.pulseCharge=Math.max(0,tank.pulseCharge-dt);
      if(tank.pulseCharge<=EPS){tank.pulseCharge=0;armaments(arena,seat);}
      continue;
    }
    if(!active&&tank.weapon==='pulse'&&input.fire&&tank.shotWait<=EPS){
      tank.pulseCharge=PULSE_CHARGE_SECONDS;
      continue;
    }
    if(active?.kind==='guide'){
      controlMissile(active,input.turn,dt);
      shiftTank(tank,tanks,{drive:input.drive,turn:0},walls,dt);
    }else{
      shiftTank(tank,tanks,input,walls,dt);
      if(active?.kind==='cluster'){
        if(trigger){
          arena.shots=arena.shots.filter(shot=>shot!==active);
          detonateCluster(arena,active,arena.shots);
        }
      }else if(tank.weapon==='burst')fireGatling(arena,tank,seat,input.fire,dt);
      else if(input.fire&&tank.shotWait<=EPS)armaments(arena,seat);
    }
  }
  const fragments=[];
  const advancing=arena.shots.filter(shot=>stepShot(shot,arena,dt,fragments));
  arena.shots=advancing.concat(fragments);
  stepMines(arena,dt);
  if(scoringLocked)return null;
  if(arena.mode==='deathmatch')return arena.winningKill===null?null:{winner:arena.winningKill,reason:'kills'};
  if(arena.mode==='relay')return advanceRelay(arena,dt);

  const alive=tanks.map((tank,seat)=>inPlay(tank)?seat:null).filter(seat=>seat!==null);
  if(alive.length<=1){
    const lastBlast=arena.blasts.at(-1);
    if(lastBlast?.id>previousBlast&&lastBlast.seat===lastBlast.owner)
      return {winner:null,reason:'self-destruction'};
    return {winner:alive[0]??null,reason:'armor'};
  }
  if(arena.mode==='beacon'){
    const present=alive.filter(seat=>distance(tanks[seat],arena.beacon)<arena.beacon.radius);
    for(const seat of alive){
      if(present.length===1&&present[0]===seat){
        arena.capture[seat]+=dt;
        if(arena.capture[seat]>=arena.beacon.captureSeconds)return {winner:seat,reason:'beacon'};
      }else if(!present.includes(seat))arena.capture[seat]=Math.max(0,arena.capture[seat]-dt*1.7);
    }
  }
  return null;
}
