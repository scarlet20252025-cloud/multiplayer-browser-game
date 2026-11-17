import test from 'node:test';
import assert from 'node:assert/strict';
import {inspectTiledObjectLayer} from '../scripts/tiled-objects.mjs';
const tiles={tiles:{'0':{type:'pusher'},'1':{type:'lever'},'2':{type:'lever'},
  '4':{type:'box'}}};
const map=(firstgid,gid)=>({layers:[{name:'Objects',objects:[
  {id:9,gid,x:128,y:192,properties:{group:3}},
  {id:10,type:'platform',x:400,y:848,properties:{group:3}}]}],
  tilesets:[{firstgid:1,source:'Ground.json'},{firstgid:16,source:'Chars.json'},
    {firstgid,source:'../../../assets/tilemaps/tilesets/Objects.json'}]});
test('same global gid identifies different mechanism types at different firstgid',()=>{
  const stage27=inspectTiledObjectLayer(map(26,26),tiles);
  assert.equal(stage27.firstgid,26);
  assert.equal(stage27.objects[0].type,'pusher');
  const stage4=inspectTiledObjectLayer(map(24,26),tiles);
  assert.equal(stage4.objects[0].type,'lever');
  assert.equal(stage4.objects[1].type,'platform');
});
test('gid with Tiled flip flag must resolve without changing the tile ID',()=>{
  const flipped=26+0x80000000;
  assert.equal(inspectTiledObjectLayer(map(26,flipped),tiles).objects[0].type,'pusher');
});
test('foreign tileset object is not misclassified as an Objects tile',()=>{
  const a=map(26,18);
  assert.equal(inspectTiledObjectLayer(a,tiles).objects[0].type,null);
  assert.equal(inspectTiledObjectLayer(a,tiles).objects[0].source,'other-tileset-or-unmapped-gid');
});
test('unreviewed tile ID is not guessed and group stays explicit',()=>{
  const a=inspectTiledObjectLayer(map(26,35),tiles);
  assert.equal(a.objects[0].type,null);
  assert.equal(a.objects[0].group,3);
  assert.equal(a.gameplayVerified,false);
});
test('bad map data or duplicate tileset boundaries fail closed',()=>{
  const a=map(26,26);a.tilesets.push({firstgid:26,source:'Duplicate.json'});
  assert.throws(()=>inspectTiledObjectLayer(a,tiles),/Duplicate firstgid/);
  assert.throws(()=>inspectTiledObjectLayer({...map(26,26),layers:[]},tiles),/Objects layer missing/);
});
