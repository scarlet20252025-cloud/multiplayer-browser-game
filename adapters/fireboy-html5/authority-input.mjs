/**
 * Server-owned, per-seat keyboard input bridge for a loaded HTML5 Forest Temple.
 * This is an original adapter; no original game assets or source are embedded.
 *
 * Acknowledgement advances only when the real character update returned,
 * never when transport merely received an input message.
 */
export const HTML5_INPUT_SCHEMA = 1;
const JUMP = 1;

function seatIndex(value) {
  if(value !== 0 && value !== 1)throw new RangeError('Only assigned seats 0 and 1 are valid');
}
function validate(packet){
  if(!packet || typeof packet!=='object' || Array.isArray(packet))throw new TypeError('Invalid input object');
  if(!Number.isSafeInteger(packet.seq) || packet.seq < 0)throw new TypeError('Invalid input sequence');
  if(![-1,0,1].includes(packet.moveX))throw new TypeError('Invalid moveX');
  for(const key of ['buttons','pressed','released']){
    if(!Number.isInteger(packet[key]) || packet[key]<0 || packet[key]>65535)
      throw new TypeError('Invalid '+key);
    if((packet[key] & ~JUMP)!==0)throw new TypeError('Only jump button 1 is supported');
  }
}

/** @returns {object} accept, resetSlot, resetAll, inspect and uninstall */
export function installHtml5AuthorityInput(game,{maxQueue=128}={}){
  if(!Number.isSafeInteger(maxQueue)||maxQueue<2||maxQueue>2048)throw new RangeError('Invalid queue limit');
  const level=game?.level;
  if(!level||!game.physics?.box2d)throw new TypeError('A loaded Box2D level is required');
  const actors=[level.pers1,level.pers2];
  const slots=actors.map((actor,index)=>{
    if(!actor || typeof actor.update!=='function' || !actor.cursors ||
       !['left','right','up'].every(x=>actor.cursors[x] && typeof actor.cursors[x]==='object'))
      throw new TypeError('Seat '+index+' lacks an update/cursor interface');
    const originalDescriptor=Object.getOwnPropertyDescriptor(actor,'update');
    if(originalDescriptor && !originalDescriptor.writable && !originalDescriptor.configurable)
      throw new TypeError('Seat '+index+' update cannot be instrumented');
    return {actor,originalDescriptor,originalUpdate:actor.update,wrapper:null,
      lastSeq:-1,ackSeq:-1,moveX:0,jumpHeld:false,queue:[],updates:0};
  });
  let active=true;
  function assertLive(){
    if(!active || game.level!==level || level.pers1!==actors[0] || level.pers2!==actors[1])
      throw new Error('HTML5 authority input adapter is stale after a level replacement');
  }
  function cursor(slot,up){
    slot.actor.cursors.left.isDown=slot.moveX===-1;
    slot.actor.cursors.right.isDown=slot.moveX===1;
    slot.actor.cursors.up.isDown=up;
  }
  for(const slot of slots){
    function wrappedUpdate(...args){
      if(active && game.level===level && !game.paused && !game.physics.box2d.paused){
        const command=slot.queue[0];
        const nextMove=command ? command.moveX : slot.moveX;
        const nextUp=command ? (command.edges.length ? command.edges[0] : command.held) : slot.jumpHeld;
        slot.moveX=nextMove;cursor(slot,nextUp);
        const result=Reflect.apply(slot.originalUpdate,this,args);
        slot.updates++;
        if(command){
          if(command.edges.length)command.edges.shift();
          if(command.edges.length===0){
            slot.jumpHeld=command.held;slot.ackSeq=command.seq;slot.queue.shift();
          }else slot.jumpHeld=nextUp;
        }
        return result;
      }
      return Reflect.apply(slot.originalUpdate,this,args);
    }
    slot.wrapper=wrappedUpdate;
    Object.defineProperty(slot.actor,'update',{configurable:true,writable:true,enumerable:false,value:wrappedUpdate});
    cursor(slot,false);
  }
  function accept(index,packet){
    seatIndex(index);assertLive();validate(packet);
    const slot=slots[index];
    if(packet.seq<=slot.lastSeq)return {accepted:false,reason:'duplicate-or-stale',ackSeq:slot.ackSeq};
    // Movement and final held bits are replaceable. Queuing every 25Hz
    // heartbeat lets a slow native character keep walking long after keyup.
    // Preserve every unconsumed jump edge but collapse any pure held state.
    const edges=[];
    if(packet.pressed & JUMP)edges.push(true);
    if(packet.released & JUMP)edges.push(false);
    if(edges.length===0){
      const pendingEdges=slot.queue.filter(item=>item.edges.length>0);
      slot.queue.length=0;
      slot.queue.push(...pendingEdges);
    }
    if(slot.queue.length>=maxQueue)throw new Error('Input queue full: fail closed and reset this seat');
    slot.queue.push({seq:packet.seq,moveX:packet.moveX,held:!!(packet.buttons&JUMP),edges});
    slot.lastSeq=packet.seq;
    return {accepted:true,queued:slot.queue.length};
  }
  function resetSlot(index,{newEpoch=false}={}){
    seatIndex(index);assertLive();
    const slot=slots[index];
    slot.queue.length=0;slot.moveX=0;slot.jumpHeld=false;cursor(slot,false);
    if(newEpoch){slot.lastSeq=-1;slot.ackSeq=-1;}
  }
  function resetAll(options){resetSlot(0,options);resetSlot(1,options);}
  function inspect(){
    assertLive();
    return {schemaVersion:HTML5_INPUT_SCHEMA,seatBindings:['pers1','pers2'],
      slots:slots.map(x=>({lastSeq:x.lastSeq,ackSeq:x.ackSeq,
        queued:x.queue.length,gameplayUpdates:x.updates,moveX:x.moveX,jumpHeld:x.jumpHeld}))};
  }
  function uninstall(){
    if(!active)return false;
    active=false;
    for(const slot of slots){
      slot.queue.length=0;slot.moveX=0;slot.jumpHeld=false;cursor(slot,false);
      if(slot.actor.update===slot.wrapper){
        if(slot.originalDescriptor)Object.defineProperty(slot.actor,'update',slot.originalDescriptor);
        else delete slot.actor.update;
      }
    }
    return true;
  }
  return Object.freeze({accept,resetSlot,resetAll,inspect,uninstall});
}
