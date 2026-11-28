import {
  HEIGHT, MAX_BRAWL_PLAYERS, MIN_BRAWL_PLAYERS, PLATFORMS, SCORE_TO_WIN, TICK_RATE, WIDTH, normalizeBrawlInput,
} from '../public/platform-brawl/rules.mjs';

const dt=1/TICK_RATE;
const halfBody=17;
const jumpSpeed=645;
const runSpeed=265;
const gravity=1520;
const outMargin=74;
const respawnTicks=90;
const protectionTicks=63;
const creditTicks=6*TICK_RATE;
const resultTicks=7*TICK_RATE;
const moves={
  light:{windup:4,active:4,recovery:11,reach:72,height:44,damage:12,force:178,lift:120,stun:13},
  heavy:{windup:11,active:5,recovery:23,reach:94,height:54,damage:23,force:316,lift:212,stun:23},
};

const roofSpawns=[
  {x:315,y:427}, {x:645,y:427}, {x:219,y:302},
  {x:741,y:302}, {x:448,y:190}, {x:514,y:427},
  {x:222,y:427}, {x:734,y:427}, {x:524,y:190},
];
const landingOrder=PLATFORMS.slice().sort((a,b)=>a.y-b.y);
const active=player=>player.connected&&player.spawned&&player.respawnAt===null;
const limit=(value,min,max)=>Math.max(min,Math.min(max,value));
const approach=(value,target,maxChange)=>value+limit(target-value,-maxChange,maxChange);

function clearAttack(player){
  player.attack=null;
  player.struck.clear();
}

function safeSpawn(state,player){
  const opponents=state.players.filter(other=>other!==player&&active(other));
  const clearance=spot=>opponents.reduce((closest,other)=>
    Math.min(closest,Math.hypot(spot.x-other.x,(spot.y-other.y)*.82)),Infinity);
  const home=roofSpawns[player.seat];
  if(clearance(home)>92)return home;
  return roofSpawns.reduce((safest,spot)=>clearance(spot)>clearance(safest)?spot:safest,home);
}

function spawn(state,player,safe){
  const {x,y}=safe?safeSpawn(state,player):roofSpawns[player.seat];
  clearAttack(player);
  Object.assign(player,{
    x,y,vx:0,vy:0,facing:x<WIDTH/2?1:-1,grounded:true,jumps:2,spawned:true,
    damage:0,attackAt:0,stunUntil:0,respawnAt:null,protectedUntil:state.tick+protectionTicks,
    lastHit:null,
  });
}

export function createBrawl({playerCount=MIN_BRAWL_PLAYERS,names=[]}={}){
  if(!Number.isInteger(playerCount)||playerCount<MIN_BRAWL_PLAYERS||playerCount>MAX_BRAWL_PLAYERS)
    throw new RangeError('A rooftop brawl needs between two and six seats.');
  const players=Array.from({length:playerCount},(_,seat)=>({
    ...roofSpawns[seat],seat,name:typeof names[seat]==='string'&&names[seat].trim()?names[seat].slice(0,24):'P'+(seat+1),
    connected:false,spawned:false,score:0,facing:1,vx:0,vy:0,grounded:false,jumps:0,
    damage:0,attack:null,attackAt:0,struck:new Set(),stunUntil:0,respawnAt:null,protectedUntil:0,lastHit:null,
  }));
  return {tick:0,round:1,phase:'playing',winner:null,resultEnd:null,players,events:[],nextEvent:1};
}

export function setBrawlerConnected(state,seat,connected){
  const player=state.players[seat];
  if(!player)return;
  player.connected=connected===true;
  if(!player.connected){
    clearAttack(player);
    return;
  }
  if(!player.spawned)spawn(state,player,true);
}

function event(state,type,source,target,x,y){
  const id=state.nextEvent++;
  state.events.push({id,type,source,target,x,y});
}

function advanceFighter(state,player,input){
  const move=moves[player.attack];
  if(move&&state.tick-player.attackAt>=move.windup+move.active+move.recovery)clearAttack(player);
  if(!player.attack&&state.tick>=player.stunUntil){
    const direction=Number(input.right)-Number(input.left);
    if(direction)player.facing=direction;
    player.vx=approach(player.vx,direction*runSpeed,(player.grounded?2200:1370)*dt);
    if(input.jump&&player.jumps>0){
      player.vy=-jumpSpeed;
      player.grounded=false;
      player.jumps--;
    }
    const attack=input.heavy?'heavy':input.light?'light':null;
    if(attack){
      player.attack=attack;
      player.attackAt=state.tick;
      // Protection blocks abuse but never shields a player who chooses to strike.
      player.protectedUntil=state.tick;
    }
  }else if(player.grounded){
    player.vx=approach(player.vx,0,710*dt);
  }

  const previousY=player.y;
  player.x+=player.vx*dt;
  player.vy=Math.min(player.vy+gravity*dt,980);
  player.y+=player.vy*dt;
  player.grounded=false;
  if(player.vy<0)return;

  const landed=landingOrder.find(roof=>previousY<=roof.y&&player.y>=roof.y&&
    player.x+halfBody*.64>roof.x&&player.x-halfBody*.64<roof.x+roof.width);
  if(landed){
    player.y=landed.y;
    player.vy=0;
    player.grounded=true;
    player.jumps=2;
  }else if(player.jumps===2){
    // Walking off a roof leaves one recovery jump, just like leaving it by jumping.
    player.jumps=1;
  }
}

function resolveStrikes(state){
  const candidates=new Map();
  const fighters=state.players.filter(active);
  for(const source of fighters){
    const move=moves[source.attack];
    if(!move)continue;
    const age=state.tick-source.attackAt;
    if(age<move.windup||age>=move.windup+move.active)continue;

    for(const target of fighters){
      if(source===target||source.struck.has(target.seat)||target.protectedUntil>state.tick)continue;
      const forward=(target.x-source.x)*source.facing;
      if(forward < -9||forward>move.reach||Math.abs(target.y-source.y)>move.height)continue;
      source.struck.add(target.seat);
      const previous=candidates.get(target);
      if(!previous||move.force>previous.move.force||
          (move.force===previous.move.force&&Math.abs(forward)<previous.distance))
        candidates.set(target,{source,move,distance:Math.abs(forward),direction:source.facing});
    }
  }
  // Collect strikes before applying them so two correctly timed attacks can trade fairly.
  for(const [target,{source,move,direction}] of candidates){
    clearAttack(target);
    target.damage=Math.min(target.damage+move.damage,230);
    target.vx=direction*Math.min(move.force+target.damage*(move===moves.heavy?4.3:3),820);
    target.vy=-Math.min(move.lift+target.damage*1.35,540);
    target.grounded=false;
    target.jumps=Math.min(target.jumps,1);
    target.stunUntil=state.tick+move.stun;
    target.lastHit={seat:source.seat,until:state.tick+creditTicks};
    event(state,'hit',source.seat,target.seat,target.x,target.y-24);
  }
}

function resolveRingOuts(state){
  let awarded=false;
  for(const player of state.players){
    if(!active(player)||(player.x>=-outMargin&&player.x<=WIDTH+outMargin&&player.y<=HEIGHT+outMargin))continue;
    const hit=player.lastHit;
    const scorer=hit?.until>=state.tick?state.players[hit.seat]:null;
    const credited=scorer?.connected&&scorer!==player?scorer:null;
    if(credited){
      credited.score++;
      awarded=true;
    }
    player.respawnAt=state.tick+respawnTicks;
    player.lastHit=null;
    clearAttack(player);
    event(state,'ringout',credited?.seat??null,player.seat,
      limit(player.x,20,WIDTH-20),limit(player.y,0,HEIGHT-18));
  }
  if(!awarded)return;
  const first=state.players.reduce((leader,player)=>player.score>leader.score?player:leader);
  if(first.connected&&first.score>=SCORE_TO_WIN&&!state.players.some(player=>player!==first&&player.score===first.score)){
    state.phase='result';
    state.winner=first.seat;
    state.resultEnd=state.tick+resultTicks;
  }
}

function nextRound(state){
  state.round++;
  state.phase='playing';
  state.winner=null;
  state.resultEnd=null;
  for(const player of state.players){
    player.score=0;
    spawn(state,player,false);
  }
}

export function stepBrawl(state,inputs=[]){
  state.tick++;
  state.events=[];
  if(state.phase==='result'){
    if(state.tick>=state.resultEnd)nextRound(state);
    return;
  }
  for(const player of state.players){
    if(!player.connected)continue;
    if(player.respawnAt!==null&&player.respawnAt<=state.tick){
      spawn(state,player,true);
      event(state,'respawn',null,player.seat,player.x,player.y);
    }
    if(active(player))advanceFighter(state,player,normalizeBrawlInput(inputs[player.seat]));
  }
  // Leaving the screen immediately removes a fighter from this step's combat.
  resolveRingOuts(state);
  if(state.phase==='playing')resolveStrikes(state);
}

export function brawlSnapshot(state){
  const seconds=ticks=>Math.max(0,ticks)/TICK_RATE;
  const coordinate=value=>Math.round(value*10)/10;
  return {
    tick:state.tick,phase:state.phase,winner:state.winner,round:state.round,
    remaining:state.resultEnd===null?null:seconds(state.resultEnd-state.tick),
    players:state.players.map(player=>({
      seat:player.seat,name:player.name,x:coordinate(player.x),y:coordinate(player.y),
      vx:coordinate(player.vx),vy:coordinate(player.vy),facing:player.facing,grounded:player.grounded,
      active:active(player),connected:player.connected,damage:player.damage,score:player.score,
      attack:player.attack,stun:seconds(player.stunUntil-state.tick),
      respawn:player.respawnAt===null?0:seconds(player.respawnAt-state.tick),
      protected:state.tick<player.protectedUntil,
    })),
    events:state.events.slice(),
  };
}
