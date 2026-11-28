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
function pausedAccessorOf(object){
  let proto=Object.getPrototypeOf(object);
  while(proto){
    const descriptor=Object.getOwnPropertyDescriptor(proto,'paused');
    if(descriptor&&typeof descriptor.get==='function'&&typeof descriptor.set==='function')
      return descriptor;
    proto=Object.getPrototypeOf(proto);
  }
  return null;
}
function applySprite(sprite,display,{applyPosition=true,applyRotation=true,smooth=null}={}){
  if(!sprite||!display||typeof display!=='object')return;
  for(const key of ['x','y']){
    if(!applyPosition||!isNumber(display[key]))continue;
    // Presentation-only smoothing: the authoritative position is still the
    // target. Large corrections (respawn/teleport) snap instead of sliding.
    if(smooth&&isNumber(sprite[key])){
      const delta=display[key]-sprite[key];
      sprite[key]=Math.abs(delta)>300?display[key]:sprite[key]+delta*smooth.factor;
    }else sprite[key]=display[key];
  }
  for(const key of ['rotation','alpha']){
    if(!isNumber(display[key]))continue;
    if(!applyRotation&&key==='rotation')continue;
    if(smooth&&isNumber(sprite[key])&&key==='rotation'){
      sprite[key]+=(display[key]-sprite[key])*smooth.factor;
    }else sprite[key]=display[key];
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
function applyEntity(entity,obj,options){
  if(!entity||!obj)return;
  if(entity.kind==='diamond'){
    applySprite(obj,entity.rootDisplay,options);
    applySprite(obj.sprite,entity.display,options);
  }else{
    const sprite=spriteOf(entity.kind,obj);
    applySprite(sprite,entity.display,options);
  }
  if(entity.kind==='character'&&entity.bodyParts){
    for(const part of ['head','legs','ice'])applySprite(obj.bodyParts?.[part],entity.bodyParts[part],options);
  }
  if(mechanismTypes.has(entity.kind)){
    applySprite(obj.base,entity.baseDisplay,options);
    const lights=obj.lights??[];
    if(Array.isArray(entity.lights)){
      for(let i=0;i<entity.lights.length;i++)applySprite(lights[i],entity.lights[i],options);
    }
  }
}
function verifyInitial(snapshot) {
  const playable = snapshot?.coverage?.playableCore ?? snapshot?.coverage?.requiredPresent;
  if(!snapshot||snapshot.schemaVersion!==1 ||
      !CATEGORIES.every(key=>Array.isArray(snapshot[key])) ||
      playable!==true || !snapshot.coverage?.allObservedPositionsFinite)
    throw new Error('Cannot initialize spectator with an incomplete initial snapshot');
  if(!Number.isSafeInteger(snapshot.snapshotSeq)||snapshot.snapshotSeq<1 ||
    !Number.isSafeInteger(snapshot.levelEpoch)||snapshot.levelEpoch<1 ||
    typeof snapshot.sessionEpoch!=='string'||!snapshot.sessionEpoch)
    throw new Error('Invalid snapshot identity');
}
/** Install after spectator loads the *same* level as the authoritative instance. */
export function installHtml5Spectator(game,{devices=globalThis.Devices,smooth=false,smoothingMs=45,localSeat=null}={}){
  const level=game?.level;
  if(!level||!level.pers1?.sprite||!level.pers2?.sprite||!game.layers?.underGround)
    throw new TypeError('Ready Forest Temple game/scene required');
  if(typeof smooth!=='boolean')throw new TypeError('smooth must be boolean');
  if(!Number.isFinite(smoothingMs)||smoothingMs<5||smoothingMs>500)
    throw new RangeError('smoothingMs must be between 5 and 500');
  if(localSeat!==null&&localSeat!==0&&localSeat!==1)
    throw new RangeError('localSeat must be null, 0 or 1');
  const ownPauseDescriptor=Object.getOwnPropertyDescriptor(level,'pauseUpdate');
  const ownToggleDescriptor=Object.getOwnPropertyDescriptor(level,'togglePause');
  const originalInputEnabled=game.input?.enabled;
  const originalGamePauseDescriptor=Object.getOwnPropertyDescriptor(game,'paused');
  const nativePauseAccessor=pausedAccessorOf(game);
  const wasPaused=nativePauseAccessor
    ?Boolean(nativePauseAccessor.get.call(game)):game.paused===true;
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
  const renderer=game.renderer;
  const nativeRender=renderer?.render;
  const ownRenderDescriptor=renderer?Object.getOwnPropertyDescriptor(renderer,'render'):null;
  if(renderer&&typeof nativeRender==='function'&&ownRenderDescriptor&&!ownRenderDescriptor.configurable)
    throw new Error('Cannot install native spectator presentation guard');
  const originalActors=[level.pers1,level.pers2];
  const signal=level.pauseKey?.onDown;
  const oldToggle=level.togglePause;
  let active=true,initialized=false,lastSeq=0,epoch=null,entities=new Map(),blockedUnpauses=0,blockedWorldSteps=0,presentedSnapshot=null,presentationReplays=0,lastPresentedAt=0,cameraTarget=null;
  // 只记录席位；本地角色不再做任何位移预测（见 repaintNativeFrame 的说明）。
  let localCharacter=localSeat===0?level.pers1:localSeat===1?level.pers2:null;
  if(signal&&typeof signal.remove==='function')signal.remove(oldToggle,null);
  function repaintNativeFrame(){
    if(!active||!presentedSnapshot||game.level!==level)return;
    // Phaser's own body sync can overwrite display-only x/y during its paused
    // draw cycle. Re-apply the most recent validated authority presentation
    // immediately before each native render; never change Box2D bodies.
    const now=performance.now();
    let presentOptions;
    if(smooth){
      const dt=lastPresentedAt?Math.min(100,Math.max(0,now-lastPresentedAt)):1000;
      presentOptions={smooth:{factor:1-Math.exp(-dt/smoothingMs)}};
    }
    lastPresentedAt=now;
    const present=new Set();
    for(const category of CATEGORIES){
      for(const entity of presentedSnapshot[category]){
        const mapped=entities.get(entity.id);
        if(!mapped||mapped.category!==category)continue;
        present.add(entity.id);
        applyEntity(entity,mapped.object,presentOptions);
        if(category==='diamonds')mapped.object.visible=true;
      }
    }
    for(const [id,mapped] of entities){
      if(mapped.category==='diamonds'&&!present.has(id))mapped.object.visible=false;
    }
    // 这里曾经给自己角色加过一段「最多 ±8px、随时间衰减」的预测位移。
    // 衰减意味着这段位移最后要被收回去，表现出来就是自己看自己一直被往回拉；
    // 队友的角色没有这段偏移，所以只有本人觉得卡。权威已经 30Hz 以上在发快照，
    // 本地角色和队友角色走同一条投影路径，手感才一致。
    if(cameraTarget&&game.camera){
      const factor=smooth?(presentOptions?.smooth?.factor??1):1;
      for(const key of ['x','y']){
        const target=cameraTarget[key];
        if(!isNumber(target))continue;
        const delta=target-game.camera[key];
        game.camera[key]=Math.abs(delta)>300?target:game.camera[key]+delta*factor;
      }
    }
    if(game.stage&&typeof game.stage.updateTransform==='function')
      game.stage.updateTransform();
    presentationReplays++;
  }
  if(renderer&&typeof nativeRender==='function'){
    Object.defineProperty(renderer,'render',{
      configurable:true,writable:true,enumerable:ownRenderDescriptor?.enumerable??false,
      value:function authoritativeSpectatorRender(...args){
        repaintNativeFrame();
        return Reflect.apply(nativeRender,this,args);
      }
    });
  }
  // Protect the native viewer even if a Phaser callback bypasses Game.paused:
  // original rules and collision stepping execute ONLY in the authority.
  if(world&&typeof oldWorldStep==='function'){
    Object.defineProperty(world,'Step',{
      configurable:true,writable:true,enumerable:oldWorldStepDescriptor?.enumerable??true,
      value:function spectatorNoPhysicsStep(){blockedWorldSteps++;return undefined;}
    });
  }
  // Phaser exposes Game.paused as a prototype accessor backed by _paused.
  // Overriding only an own property leaves _paused=false and the whole native
  // update loop (camera, input polling, character logic) running in the viewer.
  // Freeze the real backing state first, then install the guard.
  if(nativePauseAccessor&&!wasPaused)nativePauseAccessor.set.call(game,true);
  // The original level may asynchronously set Game.paused=false AFTER
  // loading (even after levelStarted). Keep the locally rendered spectator
  // permanently paused until uninstall; native physics must never run here.
  // This only intercepts the VIEWER game property, never the authority.
  Object.defineProperty(game,'paused',{
    configurable:true,enumerable:originalGamePauseDescriptor?.enumerable??true,
    get(){return true;},
    set(next){if(next!==true)blockedUnpauses++;}
  });
  // A paused Phaser game can still have keyboard devices that were bound before
  // the spectator installed. Disable every local input device so the viewer
  // never writes a player velocity/body while snapshots are being projected.
  const inputManagers=[];
  if(game.input){
    for(const [owner,key] of [[game.input,'enabled'],[game.input.keyboard,'enabled'],
      [game.input.mouse,'enabled'],[game.input.touch,'enabled'],[game.input.gamepad,'enabled']]){
      if(owner&&key in owner){inputManagers.push({owner,key,value:owner[key]});owner[key]=false;}
    }
  }
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
    return apply(snapshot,{snap:true});
  }
  function cameraTargetFor(observed){
    if(!observed||!isNumber(observed.x)||!isNumber(observed.y))return null;
    const camera=game.camera;
    if(!camera)return null;
    let targetX=observed.x,targetY=observed.y;
    // Copy the world point at the authority camera's center, then recenter it
    // for this viewer's own viewport/scale. Window sizes may differ.
    if(isNumber(observed.width)&&isNumber(observed.height)&&
       isNumber(observed.scaleX)&&observed.scaleX>0&&
       isNumber(observed.scaleY)&&observed.scaleY>0&&
       isNumber(camera.width)&&isNumber(camera.height)&&
       isNumber(camera.scale?.x)&&camera.scale.x>0&&
       isNumber(camera.scale?.y)&&camera.scale.y>0){
      const centerX=observed.x+observed.width/(2*observed.scaleX);
      const centerY=observed.y+observed.height/(2*observed.scaleY);
      targetX=centerX-camera.width/(2*camera.scale.x);
      targetY=centerY-camera.height/(2*camera.scale.y);
    }
    return {x:targetX,y:targetY};
  }
  function applyCamera(observed,{snap=false}={}){
    cameraTarget=cameraTargetFor(observed);
    if(!cameraTarget||(smooth&&!snap))return;
    if(game.camera){
      game.camera.x=cameraTarget.x;
      game.camera.y=cameraTarget.y;
    }
  }
  function apply(snapshot,{snap=false}={}){
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
    // In smooth mode positions/rotation are driven by the render-time
    // interpolation below; discrete fields still update immediately.
    const options=smooth&&!snap?{applyPosition:false,applyRotation:false}:undefined;
    const found=new Set();
    let applied=0,hidden=0,unknown=0;
    for(const category of CATEGORIES){
      if(!Array.isArray(snapshot[category]))throw Error('Snapshot category missing '+category);
      for(const entity of snapshot[category]){
        const mapped=entities.get(entity.id);
        if(!mapped||mapped.category!==category){unknown++;continue;}
        found.add(entity.id);
        applyEntity(entity,mapped.object,options);applied++;
        if(category==='diamonds')mapped.object.visible=true;
      }
    }
    for(const [id,mapped] of entities){
      if(mapped.category==='diamonds'&&!found.has(id)){mapped.object.visible=false;hidden++;}
    }
    lastSeq=snapshot.snapshotSeq;
    presentedSnapshot=snapshot;
    applyCamera(snapshot.camera,{snap});
    if(snap)lastPresentedAt=0;
    // The guarded native renderer reapplies the last authority presentation
    // and updates display transforms before painting. Do not transform twice.
    if(!smooth&&game.renderer?.render&&game.stage)
      game.renderer.render(game.stage);
    else if(!smooth&&game.stage&&typeof game.stage.updateTransform==='function')
      game.stage.updateTransform();
    return {accepted:true,snapshotSeq:lastSeq,applied,hiddenDiamonds:hidden,unknownEntities:unknown,
      completeGameState:false};
  }
  function inspect(){
    assertLive();
    return {initialized,lastSeq,entityCount:entities.size,presentationReplays,
      actorRefsMatch:originalActors[0]===level.pers1&&originalActors[1]===level.pers2,
      blockedUnpauses,blockedWorldSteps,gamePaused:game.paused,
      physicsPaused:game.physics?.box2d?.paused??null};
  }
  function setLocalSeat(value){
    if(value!==null&&value!==0&&value!==1)
      throw new RangeError('local seat must be null, 0 or 1');
    localSeat=value;
    localCharacter=value===0?level.pers1:value===1?level.pers2:null;
    return localSeat;
  }
  /**
   * 保留接口给客户端上报本地按键，但不再据此移动精灵。
   * 之前用它做「预测位移」，衰减时会把角色往回拉；现在本地角色与队友角色
   * 完全走同一条权威投影路径。
   */
  function setLocalInput({moveX=0}={}){
    if(moveX!==-1&&moveX!==0&&moveX!==1)
      throw new RangeError('moveX must be -1, 0 or 1');
    return moveX;
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
    if(renderer&&typeof nativeRender==='function'&&renderer.render!==nativeRender){
      if(ownRenderDescriptor)Object.defineProperty(renderer,'render',ownRenderDescriptor);
      else delete renderer.render;
    }
    presentedSnapshot=null;cameraTarget=null;
    for(const {owner,key,value} of inputManagers)owner[key]=value;
    if(originalGamePauseDescriptor)
      Object.defineProperty(game,'paused',originalGamePauseDescriptor);
    else delete game.paused;
    if(nativePauseAccessor&&!originalGamePauseDescriptor)
      nativePauseAccessor.set.call(game,wasPaused);
    entities.clear();
    return true;
  }
  return Object.freeze({initialize,apply,inspect,setLocalInput,setLocalSeat,uninstall});
}
