/**
 * Original research-only spectator projection for Forest Temple HTML5.
 * Requires the real game and assets installed privately in the viewing browser.
 * Never advances local gameplay. Does not provide a complete render-state sync.
 */
const CATEGORIES=['characters','diamonds','doors','mechanisms'];
const mechanismTypes=new Set(['lever','pusher','platform','box']);
const valueAtPath=(root,path)=>{
  if(typeof path!=='string')return undefined;
  // Authoritative observations use only these explicit known container paths.
  if(path==='level.pers1')return root.level.pers1;
  if(path==='level.pers2')return root.level.pers2;
  if(path==='level.door1')return root.level.door1;
  if(path==='level.door2')return root.level.door2;
  let m=path.match(/^level\.objects\[(\d+)\]$/);
  if(m)return root.level.objects?.[Number(m[1])];
  m=path.match(/^game\.layers\.underGround\.children\[(\d+)\]$/);
  if(m)return root.layers?.underGround?.children?.[Number(m[1])];
  return undefined;
};
const isNumber=value=>typeof value==='number'&&Number.isFinite(value);
function applySprite(sprite,display,{applyPosition=true}={}){
  if(!sprite||!display||typeof display!=='object')return;
  for(const key of ['x','y']){
    if(applyPosition&&isNumber(display[key]))sprite[key]=display[key];
  }
  for(const key of ['rotation','alpha']){
    if(isNumber(display[key]))sprite[key]=display[key];
  }
  if(typeof display.visible==='boolean')sprite.visible=display.visible;
  if(display.scale&&sprite.scale){
    for(const key of ['x','y'])if(isNumber(display.scale[key]))sprite.scale[key]=display.scale[key];
  }
  if(typeof display.frameName==='string' && display.frameName.length>0 && display.frameName.length<=160){
    sprite.frameName=display.frameName;
  }else if(Number.isInteger(display.frame)&&display.frame>=0) sprite.frame=display.frame;
  if(display.animation&&sprite.animations?.currentAnim){
    // Keep local animation engine frozen; never call play() (which can advance timers).
    if(typeof display.animation.playing==='boolean' &&
      typeof sprite.animations.currentAnim.isPlaying==='boolean'){
      sprite.animations.currentAnim.isPlaying=false;
    }
  }
}
function spriteOf(kind,obj){
  if(kind==='character')return obj.sprite;
  if(kind==='door')return obj.sprite;
  if(kind==='diamond')return obj.sprite;
  if(kind==='pusher')return obj.button;
  if(kind==='lever')return obj.body?.sprite;
  if(kind==='platform'||kind==='box')return obj.sprite;
  return null;
}
function applyEntity(entity,obj){
  if(!entity||!obj)return;
  if(entity.kind==='diamond'){
    applySprite(obj,entity.rootDisplay);
    applySprite(obj.sprite,entity.display);
  }else{
    const sprite=spriteOf(entity.kind,obj);
    applySprite(sprite,entity.display);
  }
  if(entity.kind==='character'&&entity.bodyParts){
    for(const part of ['head','legs','ice'])applySprite(obj.bodyParts?.[part],entity.bodyParts[part]);
  }
  if(mechanismTypes.has(entity.kind)){
    applySprite(obj.base,entity.baseDisplay);
    const lights=obj.lights??[];
    if(Array.isArray(entity.lights)){
      for(let i=0;i<entity.lights.length;i++)applySprite(lights[i],entity.lights[i]);
    }
  }
}
function verifyInitial(snapshot) {
  if(!snapshot||snapshot.schemaVersion!==1 ||
      !CATEGORIES.every(key=>Array.isArray(snapshot[key])) ||
      !snapshot.coverage?.requiredPresent || !snapshot.coverage?.allObservedPositionsFinite)
    throw new Error('Cannot initialize spectator with an incomplete initial snapshot');
  if(!Number.isSafeInteger(snapshot.snapshotSeq)||snapshot.snapshotSeq<1 ||
    !Number.isSafeInteger(snapshot.levelEpoch)||snapshot.levelEpoch<1 ||
    typeof snapshot.sessionEpoch!=='string'||!snapshot.sessionEpoch)
    throw new Error('Invalid snapshot identity');
}
/** Install after spectator loads the *same* level as the authoritative instance. */
export function installHtml5Spectator(game,{devices=globalThis.Devices}={}){
  const level=game?.level;
  if(!level||!level.pers1?.sprite||!level.pers2?.sprite||!game.layers?.underGround)
    throw new TypeError('Ready Forest Temple game/scene required');
  const ownPauseDescriptor=Object.getOwnPropertyDescriptor(level,'pauseUpdate');
  const ownToggleDescriptor=Object.getOwnPropertyDescriptor(level,'togglePause');
  const originalInputEnabled=game.input?.enabled;
  const originalGamePauseDescriptor=Object.getOwnPropertyDescriptor(game,'paused');
  const world=game.physics?.box2d?.world;
  const oldWorldStepDescriptor=world?Object.getOwnPropertyDescriptor(world,'Step'):null;
  const oldWorldStep=world?.Step;
  if(world&&typeof oldWorldStep!=='function')
    throw new Error('Native spectator Box2D world has no callable Step');
  if(oldWorldStepDescriptor&&!oldWorldStepDescriptor.configurable)
    throw new Error('Native spectator Box2D Step cannot be frozen');
  if(originalGamePauseDescriptor && !originalGamePauseDescriptor.configurable)
    throw new Error('Spectator cannot guard a nonconfigurable native pause property');
  if(!originalGamePauseDescriptor && !Object.isExtensible(game))
    throw new Error('Spectator cannot install a pause guard on this game');
  const signal=level.pauseKey?.onDown;
  const oldToggle=level.togglePause;
  let active=true,initialized=false,lastSeq=0,epoch=null,entities=new Map(),blockedUnpauses=0,blockedWorldSteps=0;
  if(signal&&typeof signal.remove==='function')signal.remove(oldToggle,null);
  // Protect the native viewer even if a Phaser callback bypasses Game.paused:
  // original rules and collision stepping execute ONLY in the authority.
  if(world&&typeof oldWorldStep==='function'){
    Object.defineProperty(world,'Step',{
      configurable:true,writable:true,enumerable:oldWorldStepDescriptor?.enumerable??true,
      value:function spectatorNoPhysicsStep(){blockedWorldSteps++;return undefined;}
    });
  }
  // The original level may asynchronously set Game.paused=false AFTER
  // loading (even after levelStarted). Keep the locally rendered spectator
  // permanently paused until uninstall; native physics must never run here.
  // This only intercepts the VIEWER game property, never the authority.
  Object.defineProperty(game,'paused',{
    configurable:true,enumerable:originalGamePauseDescriptor?.enumerable??true,
    get(){return true;},
    set(next){if(next!==true)blockedUnpauses++;}
  });
  if(game.input)game.input.enabled=false;
  level.pauseUpdate=()=>{};
  level.togglePause=()=>{};
  function assertLive(){
    if(!active||game.level!==level)throw Error('Spectator scene changed or is closed');
    if(!game.paused)throw Error('Spectator gameplay resumed locally; refusing projection');
  }
  function initialize(snapshot){
    assertLive();verifyInitial(snapshot);
    if(initialized)throw Error('Spectator already initialized');
    if(snapshot.characters.length!==2||snapshot.doors.length!==2)
      throw Error('Expected two characters and two doors');
    const mapping=new Map();
    const used=new Set();
    const roster=Array.isArray(snapshot.diamondRoster)?snapshot.diamondRoster:null;
    if(roster){
      const proto=devices?.Diamond?.prototype;
      if(!proto)throw Error('Diamond constructor required for spawn-roster mapping');
      const candidates=game.layers.underGround.children.filter(child=>
        child&&Object.prototype.isPrototypeOf.call(proto,child));
      for(const entry of roster){
        if(typeof entry.id!=='string'||!entry.id||mapping.has(entry.id)||
          typeof entry.character!=='string'||!Number.isFinite(entry.spawn?.x)||
          !Number.isFinite(entry.spawn?.y)||typeof entry.present!=='boolean')
          throw Error('Invalid authority diamond spawn roster');
        // Identify by the real, immutable map spawn and element type. Never use
        // shifted underGround.children indices after a diamond is collected.
        const matches=candidates.filter(child=>!used.has(child)&&
          child.data?.char===entry.character &&
          Math.abs(child.x-entry.spawn.x)<2 && Math.abs(child.y-entry.spawn.y)<2);
        if(matches.length!==1)throw Error('Ambiguous/missing diamond spawn for '+entry.id);
        const local=matches[0];
        used.add(local);
        mapping.set(entry.id,{category:'diamonds',object:local});
      }
      if(used.size!==candidates.length)
        throw Error('Diamond roster is incomplete for the spectator scene');
    }
    for(const category of CATEGORIES){
      for(const entry of snapshot[category]){
        if(category==='diamonds'&&roster){
          const match=mapping.get(entry.id);
          if(!match||match.category!=='diamonds')
            throw Error('Live diamond is absent from spawn roster');
          continue;
        }
        if(typeof entry.id!=='string'||!entry.id||mapping.has(entry.id))throw Error('Bad/duplicate entity id');
        let local;
        for(const path of entry.sourcePaths??[]){
          local=valueAtPath(game,path);
          if(local)break;
        }
        if(!local){
          // Do not invent object identities for a different map or a late join.
          throw Error('Unmapped initial authority entity: '+category+' '+entry.id);
        }
        if(used.has(local))throw Error('Two authority entities mapped to one local object');
        used.add(local);
        if(category==='diamonds'){
          const proto=devices?.Diamond?.prototype;
          if(!proto||!Object.prototype.isPrototypeOf.call(proto,local))throw Error('Diamond class mismatch');
        } else if(category==='mechanisms'&&local.options?.type!==entry.kind){
          throw Error('Mechanism type mismatch for '+entry.id);
        }
        mapping.set(entry.id,{category,object:local});
      }
    }
    initialized=true;entities=mapping;epoch={session:snapshot.sessionEpoch,level:snapshot.levelEpoch};
    return apply(snapshot);
  }
  function apply(snapshot){
    assertLive();
    if(!initialized)throw Error('Spectator requires an initial baseline');
    if(snapshot?.schemaVersion!==1||snapshot.sessionEpoch!==epoch.session||
      snapshot.levelEpoch!==epoch.level)throw Error('Snapshot epoch mismatch');
    if(!Number.isSafeInteger(snapshot.snapshotSeq)||snapshot.snapshotSeq<=lastSeq)
      return {accepted:false,reason:'stale',lastSeq};
    if(Array.isArray(snapshot.diamondRoster)){
      const present=new Set(snapshot.diamonds.map(entity=>entity.id));
      for(const row of snapshot.diamondRoster){
        if(!entities.has(row.id)||entities.get(row.id).category!=='diamonds'||
           row.present!==present.has(row.id))
          throw Error('Authority diamond roster/presence mismatch');
      }
    }
    const found=new Set();
    let applied=0,hidden=0,unknown=0;
    for(const category of CATEGORIES){
      if(!Array.isArray(snapshot[category]))throw Error('Snapshot category missing '+category);
      for(const entity of snapshot[category]){
        const mapped=entities.get(entity.id);
        if(!mapped||mapped.category!==category){unknown++;continue;}
        found.add(entity.id);
        applyEntity(entity,mapped.object);applied++;
        if(category==='diamonds')mapped.object.visible=true;
      }
    }
    for(const [id,mapped] of entities){
      if(mapped.category==='diamonds'&&!found.has(id)){mapped.object.visible=false;hidden++;}
    }
    lastSeq=snapshot.snapshotSeq;
    // Paint the current native scene graph explicitly while the spectator's
    // Phaser gameplay and Box2D world remain frozen.
    if(game.renderer?.render&&game.stage)
      game.renderer.render(game.stage);
    return {accepted:true,snapshotSeq:lastSeq,applied,hiddenDiamonds:hidden,unknownEntities:unknown,
      completeGameState:false};
  }
  function inspect(){
    assertLive();
    return {initialized,lastSeq,entityCount:entities.size,
      blockedUnpauses,blockedWorldSteps,gamePaused:game.paused,
      physicsPaused:game.physics?.box2d?.paused??null};
  }
  function uninstall(){
    if(!active)return false;
    active=false;
    if(ownPauseDescriptor)Object.defineProperty(level,'pauseUpdate',ownPauseDescriptor);
    else delete level.pauseUpdate;
    if(ownToggleDescriptor)Object.defineProperty(level,'togglePause',ownToggleDescriptor);
    else delete level.togglePause;
    if(signal&&typeof signal.add==='function'&&oldToggle&&!signal.has?.(oldToggle,null))
      signal.add(oldToggle,null);
    if(world&&typeof oldWorldStep==='function'){
      if(oldWorldStepDescriptor)Object.defineProperty(world,'Step',oldWorldStepDescriptor);
      else delete world.Step;
    }
    if(game.input)game.input.enabled=originalInputEnabled;
    if(originalGamePauseDescriptor)
      Object.defineProperty(game,'paused',originalGamePauseDescriptor);
    else delete game.paused;
    entities.clear();
    return true;
  }
  return Object.freeze({initialize,apply,inspect,uninstall});
}
