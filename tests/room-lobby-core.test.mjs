import test from 'node:test';
import assert from 'node:assert/strict';
import {RoomLobbyCore} from '../server/room-lobby-core.mjs';

function fixture(){
  let time=1_000_000;
  const lobby=new RoomLobbyCore({now:()=>time,catalogIds:['forest','ice']});
  const room=lobby.ensureRoom('room-key',{name:'测试房间'});
  const socket=token=>({token,closed:false,close(){this.closed=true;}});
  const add=()=>{
    const member=lobby.addMember('room-key');
    return {member,ws:socket(member.token)};
  };
  return {lobby,room,add,advance:ms=>{time+=ms;}};
}

test('a room holds exactly two seats and rejects a third player',()=>{
  const f=fixture();
  const a=f.add(),b=f.add();
  assert.equal(a.member.seat,0);assert.equal(b.member.seat,1);
  assert.throws(()=>f.add(),{code:'ROOM_FULL'});
  assert.ok(a.member.token!==b.member.token);
});

test('level choice is proposed by one seat and only the other seat may confirm',()=>{
  const f=fixture();
  const a=f.add(),b=f.add();
  const A=f.lobby.attach(a.member.token,a.ws);
  assert.throws(()=>f.lobby.propose(A.member.token,{gameId:'forest',levelId:3}),
    {code:'NEED_TWO_PLAYERS'});
  f.lobby.attach(b.member.token,b.ws);
  const {proposal}=f.lobby.propose(A.member.token,{gameId:'forest',levelId:3});
  assert.equal(proposal.bySeat,0);
  assert.throws(()=>f.lobby.confirm(A.member.token,proposal.id),{code:'CANNOT_CONFIRM_OWN'});
  assert.throws(()=>f.lobby.cancel(A.member.token,'stale-id'),{code:'PROPOSAL_STALE'});
  const started=f.lobby.confirm(b.member.token,proposal.id);
  assert.equal(started.proposal.levelId,3);
  assert.equal(f.room.phase,'starting');
  assert.equal(f.room.proposal,null);
  f.lobby.startSession(f.room,{gameId:'forest',levelId:3,wsUrl:'ws://127.0.0.1:1/ws',token:'t'});
  assert.equal(f.room.phase,'playing');
  assert.throws(()=>f.lobby.propose(A.member.token,{gameId:'forest',levelId:4}),
    {code:'LOBBY_BUSY'});
});

test('cancelling a proposal returns both players to level selection',()=>{
  const f=fixture();
  const a=f.add(),b=f.add();
  const A=f.lobby.attach(a.member.token,a.ws),B=f.lobby.attach(b.member.token,b.ws);
  const {proposal}=f.lobby.propose(A.member.token,{gameId:'ice',levelId:2});
  const {cancelled}=f.lobby.cancel(B.member.token,proposal.id);
  assert.equal(cancelled.id,proposal.id);
  assert.equal(f.room.proposal,null);
  assert.equal(f.room.phase,'select');
});

test('unknown games and invalid levels never reach a proposal',()=>{
  const f=fixture();
  const a=f.add(),b=f.add();
  f.lobby.attach(a.member.token,a.ws);f.lobby.attach(b.member.token,b.ws);
  assert.throws(()=>f.lobby.selectGame(a.member.token,'fairy'),{code:'GAME_UNKNOWN'});
  assert.throws(()=>f.lobby.propose(a.member.token,{gameId:'forest',levelId:-1}),{code:'LEVEL_INVALID'});
  assert.throws(()=>f.lobby.propose(a.member.token,{gameId:'forest',levelId:1.5}),{code:'LEVEL_INVALID'});
});

test('a session can be reused for another game and returns both seats to selection',()=>{
  const f=fixture();
  const a=f.add(),b=f.add();
  f.lobby.attach(a.member.token,a.ws);f.lobby.attach(b.member.token,b.ws);
  const {proposal}=f.lobby.propose(a.member.token,{gameId:'forest',levelId:9});
  f.lobby.confirm(b.member.token,proposal.id);
  f.lobby.startSession(f.room,{gameId:'forest',levelId:9,wsUrl:'ws://127.0.0.1:1/ws',token:'t'});
  f.lobby.stopSession(f.room,'PLAYERS_LEFT');
  assert.equal(f.room.phase,'select');
  const second=f.lobby.propose(a.member.token,{gameId:'ice',levelId:1});
  assert.equal(second.proposal.gameId,'ice');
});

test('seats are released only after a long offline window while selecting',()=>{
  const f=fixture();
  const a=f.add(),b=f.add();
  f.lobby.attach(a.member.token,a.ws);f.lobby.attach(b.member.token,b.ws);
  f.lobby.detach(b.ws);
  f.advance(89_000);
  assert.deepEqual(f.lobby.sweep(),[]);
  assert.notEqual(f.room.members[1],null);
  f.advance(2_000);
  assert.equal(f.lobby.sweep().length,1);
  assert.equal(f.room.members[1],null);  assert.equal(f.room.members[0].seat,0);
});

test('a playing room keeps its seats across a lobby disconnect',()=>{
  const f=fixture();
  const a=f.add(),b=f.add();
  f.lobby.attach(a.member.token,a.ws);f.lobby.attach(b.member.token,b.ws);
  const {proposal}=f.lobby.propose(a.member.token,{gameId:'forest',levelId:1});
  f.lobby.confirm(b.member.token,proposal.id);
  f.lobby.startSession(f.room,{gameId:'forest',levelId:1,wsUrl:'ws://127.0.0.1:1/ws',token:'t'});
  f.lobby.detach(b.ws);
  f.advance(10*60_000);
  assert.deepEqual(f.lobby.sweep(),[]);
  assert.equal(f.room.members[1].token,b.member.token);
});

test('a replaced socket does not take the seat token with it',()=>{
  const f=fixture();
  const a=f.add();
  const first=f.lobby.attach(a.member.token,a.ws);
  const replacement={close(){}};
  f.lobby.attach(a.member.token,replacement);
  assert.equal(a.ws.closed,true);
  assert.equal(f.lobby.detach(a.ws),null);
  assert.equal(f.room.members[0].connected,true);
});

test('a six-seat room can start with two players and invalidates votes when the roster changes',()=>{
  const lobby=new RoomLobbyCore({catalogIds:['tank-trouble','forest'],
    seatsFor:gameId=>gameId==='tank-trouble'?6:2,
    minSeatsFor:gameId=>gameId==='tank-trouble'?2:undefined});
  const room=lobby.ensureRoom('arena',{boundGameId:'tank-trouble'});
  const join=()=>{
    const member=lobby.addMember(room.key);
    const socket={close(){}};
    lobby.attach(member.token,socket);
    return {member,socket};
  };
  const first=join();
  const nextProposal=()=>lobby.propose(first.member.token,{gameId:'tank-trouble',levelId:1}).proposal;
  assert.equal(lobby.publicState(room).seats.length,6);
  assert.equal(lobby.publicState(room).canStart,false);
  assert.throws(nextProposal,{code:'NEED_TWO_PLAYERS'});
  assert.throws(()=>lobby.selectGame(first.member.token,'forest'),{code:'ROOM_GAME_LOCKED'});
  const second=join();
  const beforeJoin=nextProposal();
  const third=join();
  assert.throws(()=>lobby.confirm(second.member.token,beforeJoin.id),{code:'NO_PROPOSAL'});
  const beforeLeave=nextProposal();
  assert.equal(lobby.confirm(second.member.token,beforeLeave.id).ready,false);
  lobby.detach(third.socket);
  assert.equal(lobby.publicState(room).proposal,null);
  const finalProposal=nextProposal();
  assert.equal(lobby.confirm(second.member.token,finalProposal.id).ready,true);
  assert.equal(room.phase,'starting');
});
