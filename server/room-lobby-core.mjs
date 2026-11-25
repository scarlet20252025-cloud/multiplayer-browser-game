/**
 * Ephemeral multi-seat lobby state for persistent room names. No sockets or game
 * code. Each game supplies its own capacity and minimum player count.
 */
import {randomBytes} from 'node:crypto';

const TOKEN_TTL_MS=6*60*60*1000;
const OFFLINE_RELEASE_MS=90*1000;
const EMPTY_ROOM_TTL_MS=10*60*1000;

export const DEFAULT_SEATS=2;
export const MAX_SEATS=6;
const SEAT_LABEL_PREFIX='P';

const fail=(code,message)=>Object.assign(new Error(message??code),{code});
const newToken=()=>randomBytes(24).toString('hex');
/** Seat label shown to players, from P1 through P6. */
export const seatLabel=seat=>SEAT_LABEL_PREFIX+(Number(seat)+1);
export const normalizeSeats=value=>
  Number.isInteger(value)&&value>=1&&value<=MAX_SEATS?value:DEFAULT_SEATS;

export class RoomLobbyCore {
  constructor({now=()=>Date.now(),catalogIds=[],seats=DEFAULT_SEATS,seatsFor=null,minSeatsFor=null}={}){
    if(typeof now!=='function')throw new TypeError('now must be a function');
    this.now=now;
    this.catalogIds=new Set(catalogIds);
    this.defaultSeats=normalizeSeats(seats);
    /** Optional resolver: gameId -> declared seat capacity from the manifest. */
    this.seatsFor=typeof seatsFor==='function'?seatsFor:null;
    this.minSeatsFor=typeof minSeatsFor==='function'?minSeatsFor:null;
    this.rooms=new Map();
  }
  roomFor(key){return this.rooms.get(key)??null;}
  capacityForGame(gameId){
    if(!this.seatsFor||typeof gameId!=='string')return this.defaultSeats;
    return normalizeSeats(this.seatsFor(gameId));
  }
  minimumForGame(gameId){
    const capacity=this.capacityForGame(gameId);
    const minimum=this.minSeatsFor?.(gameId);
    return Number.isInteger(minimum)&&minimum>0?Math.min(capacity,minimum):capacity;
  }
  /** Grow or shrink the seat array; shrinking below a used seat is refused. */
  resizeRoom(room,capacity){
    const next=normalizeSeats(capacity);
    if(next===room.members.length)return room;
    if(next<room.members.length&&room.members.slice(next).some(Boolean))
      throw fail('ROOM_CAPACITY_BUSY','目标席位仍有人占用，无法缩小房间容量');
    if(next<room.members.length)room.members.length=next;
    while(room.members.length<next)room.members.push(null);
    room.capacity=next;
    return room;
  }
  ensureRoom(key,{name,boundGameId=null}={}){
    if(typeof key!=='string'||!key)throw fail('ROOM_REQUIRED');
    let room=this.rooms.get(key);
    if(!room){
      const capacity=this.capacityForGame(boundGameId);
      room={key,name:name??key,capacity,members:new Array(capacity).fill(null),
        phase:'select',gameId:boundGameId,boundGameId,proposal:null,session:null,messages:[],
        createdAt:this.now(),lastActivity:this.now()};
      this.rooms.set(key,room);
    }
    room.lastActivity=this.now();
    return room;
  }
  nextMemberSeat(room,canReplaceActiveMember){
    const open=room.members.findIndex(member=>!member);
    if(open>=0)return open;
    const replaceable=room.members.filter(member=>!member.connected&&(room.phase==='select'
      ?member.everConnected:canReplaceActiveMember?.(member)));
    replaceable.sort((a,b)=>a.lastSeen-b.lastSeen);
    return replaceable[0]?.seat??-1;
  }
  /** Reserve an authenticated seat after the HTTP registry check. */
  addMember(key,{name,canReplaceActiveMember}={}){
    const room=this.ensureRoom(key,{name});
    if(room.phase==='starting')throw fail('ROOM_STARTING','房间正在启动游戏');
    if(room.phase==='playing'&&!canReplaceActiveMember)
      throw fail('ROOM_PLAYING','对局进行中，请等待本局结束');
    const seat=this.nextMemberSeat(room,canReplaceActiveMember);
    if(seat<0)throw fail('ROOM_FULL','房间 '+room.members.length+' 个席位都已占用');
    try{room.members[seat]?.ws?.close(4002,'replaced-offline');}catch{}
    const member={token:newToken(),seat,connected:false,ws:null,everConnected:false,
      displayName:null,avatar:null,
      chatStart:0,chatCount:0,createdAt:this.now(),lastSeen:this.now()};
    room.members[seat]=member;
    return member;
  }
  /**
   * The guest nickname is client-supplied and display-only: it never decides a
   * seat or a permission. Bounded and trimmed so a vote prompt stays readable.
   */
  setProfile(token,{name,avatar}={}){
    const {room,member}=this.auth(token);
    const cleanName=typeof name==='string'?name.trim().slice(0,20):'';
    const cleanAvatar=typeof avatar==='string'?avatar.trim().slice(0,8):'';
    if(cleanName)member.displayName=cleanName;
    if(cleanAvatar)member.avatar=cleanAvatar;
    room.lastActivity=this.now();
    return {room,member};
  }
  /** Display label for a seat: nickname when known, otherwise the Pn seat label. */
  memberLabel(room,seat){
    const member=room.members[seat];
    if(!member)return seatLabel(seat);
    return member.displayName||seatLabel(seat);
  }
  auth(token){
    if(typeof token!=='string'||token.length<16)throw fail('LOBBY_TOKEN_INVALID');
    for(const room of this.rooms.values()){
      const member=room.members.find(candidate=>candidate?.token===token);
      if(member){
        if(this.now()-member.createdAt>TOKEN_TTL_MS)
          throw fail('LOBBY_TOKEN_EXPIRED','房间凭证已过期，请重新加入');
        return {room,member};
      }
    }
    throw fail('LOBBY_TOKEN_INVALID','房间凭证无效，请重新加入');
  }
  attach(token,ws){
    const {room,member}=this.auth(token);
    if(member.ws&&member.ws!==ws){
      try{member.ws.close(4001,'replaced');}catch{}
    }
    if(!member.connected)room.proposal=null;
    member.ws=ws;member.connected=true;member.everConnected=true;member.lastSeen=this.now();
    room.lastActivity=this.now();
    return {room,member};
  }
  detach(ws){
    for(const room of this.rooms.values()){
      const member=room.members.find(candidate=>candidate?.ws===ws);
      if(member){
        member.ws=null;member.connected=false;member.lastSeen=this.now();room.proposal=null;
        room.lastActivity=this.now();
        return {room,member};
      }
    }
    return null;
  }
  memberForToken(token){return this.auth(token);}
  leave(token,{releaseDuringPlay=false}={}){
    const {room,member}=this.auth(token);
    if(member.connected)room.proposal=null;
    try{member.ws?.close(4000,'leave');}catch{}
    member.ws=null;member.connected=false;
    if(room.phase==='select'||room.phase==='playing'&&releaseDuringPlay){
      room.members[member.seat]=null;
      room.lastActivity=this.now();
    }
    return {room,member};
  }
  requireAttached(room,member){
    if(!member?.connected||!member.ws)throw fail('LOBBY_NOT_ATTACHED','大厅连接已断开');
    if(room.phase!=='select')throw fail('LOBBY_BUSY','游戏已经开始');
  }
  /** Room-scoped chat. Text is server-trimmed and rate-limited; the seat is
   * fixed by the authenticated socket, never by client-supplied fields. */
  chat(token,{text,name,avatar}={}){
    const {room,member}=this.auth(token);
    const clean=typeof text==='string'?text.trim():'';
    if(!clean||clean.length>500)throw fail('CHAT_INVALID','消息为空或超过 500 个字符');
    const now=this.now();
    if(now-member.chatStart>=3000||now<member.chatStart){
      member.chatStart=now;member.chatCount=0;
    }
    if(++member.chatCount>5)throw fail('CHAT_RATE_LIMIT','发送太快，请稍后再试');
    const displayName=typeof name==='string'?name.trim().slice(0,20):'';
    const avatarText=typeof avatar==='string'?avatar.trim().slice(0,8):'';
    const message={id:newToken().slice(0,12),seat:member.seat,
      name:displayName||seatLabel(member.seat),avatar:avatarText||'🐟',
      text:clean,at:now};
    if(!Array.isArray(room.messages))room.messages=[];
    room.messages.push(message);
    if(room.messages.length>60)room.messages.splice(0,room.messages.length-60);
    room.lastActivity=now;
    return {room,member,message};
  }
  requireGame(room,gameId){
    if(this.catalogIds.size&&!this.catalogIds.has(gameId))
      throw fail('GAME_UNKNOWN','未接入这个游戏');
    if(room.boundGameId&&room.boundGameId!==gameId)
      throw fail('ROOM_GAME_LOCKED','此房间已绑定另一款游戏');
  }
  selectGame(token,gameId,{bind=false}={}){
    const {room,member}=this.auth(token);
    this.requireAttached(room,member);
    this.requireGame(room,gameId);
    this.resizeRoom(room,this.capacityForGame(gameId));
    if(bind)room.boundGameId=gameId;
    if(room.gameId!==gameId){
      room.gameId=gameId;room.proposal=null;room.lastActivity=this.now();
    }
    return {room,member};
  }
  missingSeats(room){
    return room.members.reduce((count,member)=>member?count:count+1,0);
  }
  propose(token,{gameId,levelId}){
    const {room,member}=this.auth(token);
    this.requireAttached(room,member);
    this.requireGame(room,gameId);
    if(!Number.isInteger(levelId)||levelId<0)throw fail('LEVEL_INVALID','关卡无效');
    const minimum=this.minimumForGame(gameId);
    if(!this.canStart(room,gameId))
      throw fail('NEED_TWO_PLAYERS',`需要至少 ${minimum} 位玩家在线`);
    if(room.proposal&&room.proposal.bySeat!==member.seat)
      throw fail('PROPOSAL_PENDING','其他玩家正在等待你确认选关');
    this.resizeRoom(room,this.capacityForGame(gameId));
    room.gameId=gameId;
    room.proposal={id:newToken().slice(0,16),bySeat:member.seat,gameId,levelId,
      createdAt:this.now(),confirmations:[member.seat]};
    room.lastActivity=this.now();
    return {room,member,proposal:{...room.proposal}};
  }
  cancel(token,proposalId){
    const {room,member}=this.auth(token);
    this.requireAttached(room,member);
    if(!room.proposal)throw fail('NO_PROPOSAL','没有待确认的选关');
    if(proposalId&&room.proposal.id!==proposalId)
      throw fail('PROPOSAL_STALE','选关提议已变化');
    const cancelled={...room.proposal};
    room.proposal=null;room.lastActivity=this.now();
    return {room,member,cancelled};
  }
  confirm(token,proposalId){
    const {room,member}=this.auth(token);
    this.requireAttached(room,member);
    if(!room.proposal)throw fail('NO_PROPOSAL','没有待确认的选关');
    if(room.proposal.id!==proposalId)throw fail('PROPOSAL_STALE','选关提议已变化');
    if(room.proposal.bySeat===member.seat)
      throw fail('CANNOT_CONFIRM_OWN','请等待其他玩家确认你的选关');
    const participants=this.connectedMembers(room);
    const confirmations=[...new Set([...room.proposal.confirmations,member.seat])];
    const proposal={...room.proposal,confirmations};
    const ready=participants.every(candidate=>confirmations.includes(candidate.seat));
    room.proposal=ready?null:proposal;
    if(ready)room.phase='starting';
    room.lastActivity=this.now();
    return {room,member,proposal,ready};
  }
  /**
   * @param {object} [options.entryPaths] 按席位给出的进场地址（external 游戏用：
   *   P1 建房、其余加入，URL 里带不同参数）。缺省时所有人共用 entryPath。
   * @param {string} [options.roomCode] external 游戏的房间码，供 UI 与探测使用。
   */
  startSession(room,{gameId,levelId,wsUrl,token,entryPath,entryPaths=null,roomCode=null}={}){
    if(room.phase!=='starting')throw fail('ROOM_NOT_STARTING');
    room.phase='playing';
    room.session={gameId,levelId,wsUrl,token,entryPath,
      ...(entryPaths?{entryPaths:[...entryPaths]}:{}),
      ...(roomCode?{roomCode}:{}),
      startedAt:this.now(),sawBoth:false,wonLevel:null};
    room.lastActivity=this.now();
    return {...room.session};
  }
  stopSession(room,reason='SESSION_ENDED'){
    if(!room.session)return null;
    const session={...room.session};
    room.session=null;room.proposal=null;room.phase='select';
    room.lastActivity=this.now();
    // The game page closed the lobby socket long ago; give players a fresh
    // window to return to the lobby with their saved seat token.
    for(const member of room.members)if(member)member.lastSeen=this.now();
    return {session,reason};
  }
  failStart(room,code='SESSION_START_FAILED'){
    if(room.phase==='starting')room.phase='select';
    room.proposal=null;room.session=null;room.lastActivity=this.now();
    return {room,code};
  }
  markBothSeen(room){
    if(room.session)room.session.sawBoth=true;
  }
  bothConnected(room){
    return room.members.every(member=>member?.connected===true);
  }
  connectedMembers(room){return room.members.filter(member=>member?.connected===true);}
  canStart(room,gameId=room.gameId){
    return this.connectedMembers(room).length>=this.minimumForGame(gameId);
  }
  publicState(room,{saves=null,viewerSeat=null}={}){
    return {
      key:room.key,name:room.name,phase:room.phase,gameId:room.gameId,boundGameId:room.boundGameId,
      capacity:room.members.length,minimumSeats:this.minimumForGame(room.gameId),
      connectedCount:this.connectedMembers(room).length,canStart:this.canStart(room),
      seats:room.members.map((member,seat)=>({seat,label:seatLabel(seat),
        occupied:Boolean(member),connected:member?.connected===true,
        name:member?.displayName??null,avatar:member?.avatar??null})),
      connected:room.members.map(member=>member?.connected===true),
      bothConnected:this.bothConnected(room),
      proposal:room.proposal?{...room.proposal}:null,
      session:room.session?{gameId:room.session.gameId,levelId:room.session.levelId,
        startedAt:room.session.startedAt}:null,
      viewerSeat:Number.isInteger(viewerSeat)?viewerSeat:null,
      saves:saves??{},
      chat:(room.messages??[]).slice(-50),
    };
  }
  /** Release stale seats and idle lobby rooms. Returns rooms whose state changed. */
  sweep(){
    const now=this.now(),changed=new Set();
    for(const [key,room] of this.rooms){
      for(let seat=0;seat<room.members.length;seat++){
        const member=room.members[seat];
        if(!member||member.connected)continue;
        if(room.phase==='playing')continue;
        if(now-member.lastSeen>OFFLINE_RELEASE_MS){
          room.members[seat]=null;changed.add(room);room.lastActivity=now;
        }
      }
      if(room.members.every(member=>!member)&&
         now-room.lastActivity>EMPTY_ROOM_TTL_MS){
        this.rooms.delete(key);
      }
    }
    return [...changed];
  }
}
