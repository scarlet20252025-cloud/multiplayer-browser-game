import test from 'node:test';
import assert from 'node:assert/strict';
import {installHtml5AuthorityInput} from '../adapters/fireboy-html5/authority-input.mjs';
function fixture(){
  function character(name){
    return {name,cursors:{left:{isDown:false},right:{isDown:false},up:{isDown:false}},
      steps:[],prohibitJump:false,update(){
        this.steps.push({left:this.cursors.left.isDown,right:this.cursors.right.isDown,up:this.cursors.up.isDown});
        if(!this.cursors.up.isDown)this.prohibitJump=false;
        else if(!this.prohibitJump)this.prohibitJump=true;
        return 'original-result';
      }};
  }
  const p1=character('fb'),p2=character('wg');
  const game={paused:false,physics:{box2d:{paused:false}},level:{pers1:p1,pers2:p2}};
  const native1=p1.update,native2=p2.update;
  return {game,p1,p2,native1,native2,bridge:installHtml5AuthorityInput(game)};
}
const input=(seq,moveX=0,buttons=0,pressed=0,released=0)=>({seq,moveX,buttons,pressed,released});
test('two seats control only their own characters; ACK comes after actual game update',()=>{
  const f=fixture();
  f.bridge.accept(1,input(0,-1));
  assert.equal(f.bridge.inspect().slots[1].ackSeq,-1);
  assert.equal(f.p2.update(),'original-result');
  assert.equal(f.p2.steps.at(-1).left,true);
  assert.equal(f.bridge.inspect().slots[1].ackSeq,0);
  assert.equal(f.bridge.inspect().slots[0].ackSeq,-1);
  assert.equal(f.p1.steps.length,0);
  f.bridge.accept(0,input(0,1));f.p1.update();
  assert.equal(f.p1.steps.at(-1).right,true);
  assert.equal(f.p2.steps.at(-1).left,true);
});
test('short press/release is applied across two real updates, with delayed ACK',()=>{
  const f=fixture();f.bridge.accept(1,input(8,0,0,1,1));
  f.p2.update();assert.equal(f.p2.steps.at(-1).up,true);
  assert.equal(f.bridge.inspect().slots[1].ackSeq,-1);
  f.p2.update();assert.equal(f.p2.steps.at(-1).up,false);
  assert.equal(f.bridge.inspect().slots[1].ackSeq,8);
  f.p2.update();assert.equal(f.p2.steps.at(-1).up,false);
  assert.equal(f.p1.steps.length,0);
});
test('continuous hold persists; explicit release clears native jump latch',()=>{
  const f=fixture();f.bridge.accept(1,input(0,0,1,1));
  f.p2.update();f.p2.update();
  assert.deepEqual(f.p2.steps.map(x=>x.up),[true,true]);
  assert.equal(f.p2.prohibitJump,true);
  f.bridge.accept(1,input(1,0,0,0,1));f.p2.update();
  assert.equal(f.p2.prohibitJump,false);
  assert.equal(f.p2.steps.at(-1).up,false);
});
test('duplicate, invalid seat and unsupported input actions rejected',()=>{
  const f=fixture();f.bridge.accept(0,input(10,1));
  assert.equal(f.bridge.accept(0,input(10,-1)).accepted,false);
  assert.equal(f.bridge.accept(0,input(9,-1)).accepted,false);
  assert.throws(()=>f.bridge.accept(2,input(11)),/assigned seats/);
  for(const packet of [{...input(11),buttons:2},{...input(11),seq:-1},
     {...input(11),moveX:3},{...input(11),pressed:65536}])
    assert.throws(()=>f.bridge.accept(0,packet));
});
test('paused game cannot ACK; reset releases both movement and jump',()=>{
  const f=fixture();f.bridge.accept(0,input(1,-1,1,1));
  f.game.paused=true;f.p1.update();
  assert.equal(f.bridge.inspect().slots[0].ackSeq,-1);
  f.game.paused=false;f.p1.update();
  assert.equal(f.bridge.inspect().slots[0].ackSeq,1);
  f.bridge.resetSlot(0);
  assert.equal(f.p1.cursors.left.isDown,false);
  assert.equal(f.p1.cursors.up.isDown,false);
  f.p1.update();assert.equal(f.p1.steps.at(-1).up,false);
});
test('new connection epoch drops stale edges without disturbing the other seat',()=>{
  const f=fixture();f.bridge.accept(0,input(100,-1,0,1,1));f.bridge.accept(1,input(2,1));
  f.bridge.resetSlot(0,{newEpoch:true});
  f.bridge.accept(0,input(0,1));f.p1.update();f.p2.update();
  assert.equal(f.bridge.inspect().slots[0].ackSeq,0);
  assert.equal(f.bridge.inspect().slots[1].ackSeq,2);
});
test('uninstall restores both native update functions; stale bridge rejects new input',()=>{
  const f=fixture();
  assert.equal(f.bridge.uninstall(),true);
  assert.equal(f.bridge.uninstall(),false);
  assert.equal(f.p1.update,f.native1);
  assert.equal(f.p2.update,f.native2);
  assert.throws(()=>f.bridge.accept(0,input(0)),/stale/);
  assert.throws(()=>installHtml5AuthorityInput(f.game,{maxQueue:1}),/queue limit/);
});
test('an exception inside the real update does not falsely acknowledge input',()=>{
  const f=fixture();f.bridge.uninstall();
  f.p1.update=function(){throw Error('gameplay exception');};
  const bridge=installHtml5AuthorityInput(f.game);bridge.accept(0,input(10,1));
  assert.throws(()=>f.p1.update(),/gameplay exception/);
  assert.equal(bridge.inspect().slots[0].ackSeq,-1);
  bridge.uninstall();
});
