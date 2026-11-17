/** Original room-domain logic for a two-seat HTML5 research authority.
 * No sockets, browser, game code, or copyrighted assets live in this module.
 * The transport binds each socket to an opaque server-owned memberId.
 */
import {InputBuffer,INPUT_TIMEOUT_MS,MAX_INPUTS_PER_SECOND} from './protocol.mjs';

export const HTML5_ROOM_VERSION=1;
const commandKeys=new Set(['type','command','roomEpoch','commandId','baseRevision','desiredPaused']);
const requiredInputKeys=new Set(['type','seq','moveX','moveY','buttons','pressed','released','aimX','aimY']);

export class Html5RoomCore {
  constructor({roomEpoch,inputTimeoutMs=INPUT_TIMEOUT_MS}={}){
    if(typeof roomEpoch!=='string'||!/^[-\w]{6,80}$/.test(roomEpoch))
      throw new TypeError('A server-generated roomEpoch is required');
    if(!Number.isSafeInteger(inputTimeoutMs)||inputTimeoutMs<50||inputTimeoutMs>30000)
      throw new RangeError('Invalid input timeout');
    this.roomEpoch=roomEpoch;
    this.inputTimeoutMs=inputTimeoutMs;
    this.members=[null,null];
    this.userPaused=false;
    this.suspendedReason=null;
    this.pauseRevision=0;
    this.receipts=new Map();
    this.roundNumber=0;
    this.restartVotes=new Set();
    this.restartPending=false;
    this.roundAction=null;
  }
  seatFor(memberId){
    const i=this.members.findIndex(m=>m?.id===memberId);
    return i<0?null:i;
  }
  memberFor(memberId){
    const slot=this.seatFor(memberId);
    if(slot===null)throw new Error('NOT_JOINED');
    return {slot,member:this.members[slot]};
  }
  attach(memberId){
    if(typeof memberId!=='string'||memberId.length<8||memberId.length>128)
      throw new TypeError('Expected opaque server-owned member id');
    if(this.seatFor(memberId)!==null)throw new Error('ALREADY_JOINED');
    const slot=this.members.findIndex(m=>!m);
    if(slot<0)throw new Error('ROOM_FULL');
    this.members[slot]={id:memberId,ready:false,input:new InputBuffer(),expired:false,
      lastReceivedAt:0,rateStart:0,rateCount:0};
    return slot;
  }
  markReady(memberId,roundNumber=this.roundNumber===0?0:null){
    const {member}=this.memberFor(memberId);
    if(roundNumber!==this.roundNumber)throw new Error('WRONG_ROUND');
    if(this.suspendedReason||this.restartPending)throw new Error('ROOM_SUSPENDED');
    member.ready=true;
    return this.publicState();
  }
  get bothReady(){return this.members.every(m=>m?.ready===true);}
  get effectivePaused(){return !this.bothReady||this.userPaused||this.suspendedReason!==null;}
  get running(){return this.bothReady&&!this.userPaused&&this.suspendedReason===null;}
  publicState(){
    return {protocol:HTML5_ROOM_VERSION,roomEpoch:this.roomEpoch,ready:this.members.map(m=>!!m?.ready),
      connected:this.members.map(m=>!!m),bothReady:this.bothReady,
      userPaused:this.userPaused,effectivePaused:this.effectivePaused,pauseRevision:this.pauseRevision,
      suspendedReason:this.suspendedReason,roundNumber:this.roundNumber,
      restartVotes:this.restartVotes.size,restartPending:this.restartPending,
      roundAction:this.roundAction};
  }
  suspend(reason){
    if(typeof reason!=='string'||!/^[-A-Z_]{3,64}$/.test(reason))
      throw new TypeError('Suspension requires a server-owned reason');
    if(this.suspendedReason)return {changed:false,reason:this.suspendedReason};
    this.suspendedReason=reason;
    this.resetPending();
    return {changed:true,reason};
  }
  voteRestart(memberId,command){
    this.memberFor(memberId);
    if(!command||typeof command!=='object'||Array.isArray(command)||
       Object.keys(command).some(key=>!['type','command','roomEpoch','roundNumber','commandId'].includes(key))||
       command.type!=='room-command'||!['round.restart.vote','round.advance.vote'].includes(command.command)||
       command.roomEpoch!==this.roomEpoch||
       !Number.isSafeInteger(command.roundNumber)||command.roundNumber!==this.roundNumber||
       typeof command.commandId!=='string'||command.commandId.length<1||command.commandId.length>128)
      return {accepted:false,code:'INVALID_RESTART_COMMAND'};
    if(!this.suspendedReason)return {accepted:false,code:'ROUND_NOT_SUSPENDED'};
    if(!this.members.every(member=>!!member))return {accepted:false,code:'NEED_TWO_MEMBERS'};
    const action=command.command==='round.advance.vote'?'advance':'restart';
    if(action==='advance'&&this.suspendedReason!=='LEVEL_WON')
      return {accepted:false,code:'NATIVE_WIN_REQUIRED'};
    if(this.roundAction&&this.roundAction!==action)
      return {accepted:false,code:'ROUND_ACTION_CONFLICT'};
    this.roundAction=action;
    this.restartVotes.add(memberId);
    if(this.restartVotes.size===2)this.restartPending=true;
    return {accepted:true,roundNumber:this.roundNumber,
      votes:this.restartVotes.size,execute:this.restartPending,action:this.roundAction};
  }
  beginNewRound(){
    if(!this.restartPending||this.restartVotes.size!==2||!this.suspendedReason)
      throw new Error('ROUND_RESTART_NOT_APPROVED');
    const completedAction=this.roundAction;
    if(!['restart','advance'].includes(completedAction))
      throw new Error('ROUND_ACTION_INVALID');
    this.roundNumber++;
    this.pauseRevision++;
    this.userPaused=false;
    this.suspendedReason=null;
    this.restartPending=false;
    this.roundAction=null;
    this.restartVotes.clear();
    this.receipts.clear();
    for(const member of this.members){
      if(!member)continue;
      member.ready=false;
      member.input=new InputBuffer();
      member.expired=false;
      member.lastReceivedAt=0;
      member.rateStart=0;
      member.rateCount=0;
    }
    return {...this.publicState(),completedAction};
  }
  detach(memberId){
    const seat=this.seatFor(memberId);
    if(seat===null)return {detached:false};
    this.members[seat].input.resetPending();
    this.restartVotes.delete(memberId);
    if(!this.restartVotes.size){this.restartPending=false;this.roundAction=null;}
    this.members[seat]=null;
    for(const member of this.members)member?.input.resetPending();
    return {detached:true,slot:seat,room:this.publicState()};
  }
  resetPending(){
    for(const member of this.members)if(member)member.input.resetPending();
  }
  receiveInput(memberId,message,now=Date.now()){
    const {slot,member}=this.memberFor(memberId);
    if(this.suspendedReason||this.restartPending)return {accepted:false,code:'ROOM_SUSPENDED'};
    if(!this.running)return {accepted:false,code:'NOT_RUNNING'};
    if(!message||typeof message!=='object'||Array.isArray(message)
      ||Object.keys(message).some(key=>!requiredInputKeys.has(key)))
      return {accepted:false,code:'INVALID_INPUT_FIELDS'};
    if(message.moveY!==0||((message.buttons??0)&~1)!==0)
      return {accepted:false,code:'UNSUPPORTED_HTML5_ACTION'};
    if(!Number.isFinite(now)||now<0)return {accepted:false,code:'INVALID_TIME'};
    if(now-member.rateStart>=1000||now<member.rateStart){member.rateStart=now;member.rateCount=0;}
    if(++member.rateCount>MAX_INPUTS_PER_SECOND)return {accepted:false,code:'RATE_LIMIT'};
    // Browser clients report explicit edge hints, whereas the original
    // InputBuffer validates only canonical held-state fields. Validate the
    // hints before normalizing; never forward unknown or slot-spoof fields.
    const pressed=message.pressed ?? 0, released=message.released ?? 0;
    if(![pressed,released].every(v=>Number.isInteger(v)&&v>=0&&v<=1))
      return {accepted:false,code:'INVALID_HTML5_EDGE'};
    const canonical={type:'input',seq:message.seq,moveX:message.moveX,
      moveY:message.moveY,buttons:message.buttons};
    if(message.aimX!==undefined)canonical.aimX=message.aimX;
    if(message.aimY!==undefined)canonical.aimY=message.aimY;
    const code=member.input.receive(canonical,now);
    if(code)return {accepted:false,code};
    // Explicit edges from this authenticated seat may include press+release
    // between two sends. Preserve them, but never accept arbitrary actions.
    member.input.pressed |= pressed;
    member.input.released |= released;
    // The server's socket fixes the seat; clients cannot override it.
    member.expired=false;
    member.lastReceivedAt=now;
    return {accepted:true,slot,seq:member.input.seq};
  }
  /**
   * Sample at the transport rate. ACK still comes from the real game bridge,
   * not these sampled inputs. Input timeout emits a reset instruction, because
   * it can preserve the previous seq while releasing buttons.
   */
  sample(now=Date.now()){
    const resets=[];
    const inputs=this.members.map((member,slot)=>{
      if(!member||!member.ready||!this.running)return {seq:-1,moveX:0,buttons:0,pressed:0,released:0};
      if(member.lastReceivedAt && now-member.lastReceivedAt>this.inputTimeoutMs && !member.expired){
        member.expired=true;resets.push(slot);
      }
      const i=member.input.consume(now);
      return {seq:i.seq,moveX:i.moveX,buttons:i.buttons&1,pressed:i.pressed&1,released:i.released&1};
    });
    return {inputs,resets};
  }
  proposePause(memberId,command){
    this.memberFor(memberId);
    if(this.suspendedReason)return {accepted:false,code:'ROOM_SUSPENDED'};
    if(!command||typeof command!=='object'||Array.isArray(command)||
       Object.keys(command).some(key=>!commandKeys.has(key))||
       command.type!=='room-command'||command.command!=='pause.set'||
       typeof command.commandId!=='string'||command.commandId.length<1||command.commandId.length>128||
       !Number.isSafeInteger(command.baseRevision)||typeof command.desiredPaused!=='boolean')
      return {accepted:false,code:'INVALID_PAUSE_COMMAND'};
    if(command.roomEpoch!==this.roomEpoch)return {accepted:false,code:'WRONG_EPOCH'};
    const key=memberId+':'+command.commandId;
    if(this.receipts.has(key))return {...this.receipts.get(key),replayed:true};
    if(!this.bothReady)return {accepted:false,code:'NOT_READY'};
    if(command.baseRevision!==this.pauseRevision)
      return {accepted:false,code:'STALE_REVISION',pauseRevision:this.pauseRevision};
    return {accepted:true,memberId,key,commandId:command.commandId,desiredPaused:command.desiredPaused,
      baseRevision:this.pauseRevision,changed:command.desiredPaused!==this.userPaused};
  }
  proposePauseToggle(memberId,command){
    this.memberFor(memberId);
    if(this.suspendedReason)return {accepted:false,code:'ROOM_SUSPENDED'};
    if(!command||typeof command!=='object'||Array.isArray(command)||
       Object.keys(command).some(key=>!['type','command','roomEpoch','commandId'].includes(key))||
       command.type!=='room-command'||command.command!=='pause.toggle'||
       typeof command.commandId!=='string'||command.commandId.length<1||
       command.commandId.length>128)
      return {accepted:false,code:'INVALID_PAUSE_COMMAND'};
    if(command.roomEpoch!==this.roomEpoch)return {accepted:false,code:'WRONG_EPOCH'};
    const key=memberId+':'+command.commandId;
    if(this.receipts.has(key))return {...this.receipts.get(key),replayed:true};
    if(!this.bothReady)return {accepted:false,code:'NOT_READY'};
    return {accepted:true,memberId,key,commandId:command.commandId,
      desiredPaused:!this.userPaused,baseRevision:this.pauseRevision,changed:true};
  }
  commitPause(proposal){
    if(!proposal?.accepted||proposal.baseRevision!==this.pauseRevision)
      throw new Error('Pause command must be validated against current revision');
    if(proposal.changed){
      this.userPaused=proposal.desiredPaused;
      this.pauseRevision++;
      this.resetPending();
    }
    const receipt={accepted:true,changed:proposal.changed,commandId:proposal.commandId,
      paused:this.userPaused,pauseRevision:this.pauseRevision};
    this.receipts.set(proposal.key,receipt);
    // Bounded replay cache. Once evicted, an old baseRevision remains stale.
    if(this.receipts.size>1024)this.receipts.delete(this.receipts.keys().next().value);
    return receipt;
  }
}
