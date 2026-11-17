import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectNativeWin,nextForestLevel} from '../server/html5-level-progression.mjs';
const snap=()=>({level:{ended:true},
  characters:[{gameplay:{dead:false,dying:false}},{gameplay:{dead:false,dying:false}}],
  doors:[{isUp:true},{isUp:true}]});
const temple={id:'forest',levels:[{id:1,filename:'tutorials/levels/forest_01.json'},
  {id:30,filename:'forest/levels/forest_30.json'},
  {id:2,filename:'forest/levels/forest_02.json'},
  {id:32,filename:'forest/levels/forest_32.json'},
  {id:31,filename:'forest/levels/forest_31.json'},
  {id:51,filename:'forest/levels/forest_03_1.json'}]};
test('native two raised doors and ended scene produce read-only win proof',()=>{
  assert.deepEqual(inspectNativeWin(snap()),{won:true,reason:'LEVEL_WON'});
});
test('no invented win from one door, missing ended state, or a dead character',()=>{
  const a=snap();a.doors[1].isUp=false;
  assert.equal(inspectNativeWin(a).won,false);
  const b=snap();b.level.ended=false;
  assert.equal(inspectNativeWin(b).reason,'LEVEL_NOT_ENDED');
  const c=snap();c.characters[0].gameplay.dead=true;
  assert.equal(inspectNativeWin(c).reason,'CHARACTER_DIED');
  const d=snap();d.doors=[];
  assert.equal(inspectNativeWin(d).reason,'INVALID_DOORS');
});
test('choose native next level by numeric standard progression, not menu array order',()=>{
  const result=nextForestLevel({currentLevelId:1,temple,proof:inspectNativeWin(snap())});
  assert.equal(result.next.id,2);
  assert.equal(result.next.filename,'forest/levels/forest_02.json');
  assert.equal(result.complete,false);
  const after30=nextForestLevel({currentLevelId:30,temple,proof:inspectNativeWin(snap())});
  assert.equal(after30.next.id,31);
  const final=nextForestLevel({currentLevelId:32,temple,proof:inspectNativeWin(snap())});
  assert.equal(final.complete,true);
  assert.equal(final.next,null);
});
test('client cannot request skipping levels, invent a success flag, or select bonus id',()=>{
  assert.throws(()=>nextForestLevel({currentLevelId:1,temple,proof:{won:true}}),/VICTORY/);
  assert.throws(()=>nextForestLevel({currentLevelId:51,temple,proof:inspectNativeWin(snap())}),/INVALID_CURRENT/);
  assert.throws(()=>nextForestLevel({currentLevelId:13,temple,proof:inspectNativeWin(snap())}),/CURRENT_LEVEL_NOT_IN/);
  const altered={...temple,levels:[...temple.levels,{id:2,filename:'forest/levels/forest_02.json'}]};
  assert.throws(()=>nextForestLevel({currentLevelId:1,temple:altered,proof:inspectNativeWin(snap())}),/DUPLICATE/);
});
test('unexpected next-level resource path fails closed before native transition',()=>{
  const invalid={...temple,levels:[{id:1,filename:'tutorials/levels/forest_01.json'},
    {id:2,filename:'../../evil.json'}]};
  assert.throws(()=>nextForestLevel({currentLevelId:1,temple:invalid,proof:inspectNativeWin(snap())}),/UNEXPECTED/);
});
