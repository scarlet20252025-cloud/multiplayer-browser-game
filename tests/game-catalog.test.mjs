import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdir,mkdtemp,rm,writeFile} from 'node:fs/promises';
import {gameFor,loadGameCatalog,nextCatalogLevel,publicCatalog} from '../server/game-catalog.mjs';

async function game(root,dir,{templeId,levels,main='game.js'}){
  const base=path.join(root,dir);
  await mkdir(path.join(base,'data',templeId),{recursive:true});
  await writeFile(path.join(base,'index.html'),
    `<script data-main="${main}" src="/bower_components/requirejs/require.js"></script>`);
  await writeFile(path.join(base,'game.json'),JSON.stringify({title:'Fixture &amp; Game'}));
  await writeFile(path.join(base,'data',templeId,'temple.json'),
    JSON.stringify({id:templeId,levels}));
}

test('catalog loads only playable packs, in numeric level order',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'game-catalog-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await game(root,'1-forest-temple',{templeId:'forest',levels:[
    {id:3,filename:'forest/levels/forest_03.json',type:'general'},
    {id:1,filename:'forest/levels/forest_01.json'},
    {id:3,filename:'forest/levels/forest_03.json'},
    {id:'bad',filename:'forest/levels/bad.json'},
  ]});
  await game(root,'3-ice-temple',{templeId:'ice',levels:[
    {id:2,filename:'ice/levels/2.json'},{id:0,filename:'ice/levels/0.json'},
  ]});
  const catalog=await loadGameCatalog({root});
  assert.deepEqual(catalog.map(game=>game.id),['forest','ice']);
  const forest=gameFor(catalog,'forest');
  assert.deepEqual(forest.levels.map(level=>level.id),[1,3]);
  assert.equal(forest.script,'1-forest-temple/game.js');
  assert.equal(forest.requireScript,'1-forest-temple/bower_components/requirejs/require.js');
  assert.equal(forest.entryPath,'/1-forest-temple/index.html');
  assert.equal(forest.subtitle,'Fixture & Game');
  assert.equal(gameFor(catalog,'crystal'),null);
  assert.deepEqual(forest.levels[0],{id:1,order:1,type:'general',time:null});
});

test('next level follows numeric order and reports completion',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'game-catalog-next-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await game(root,'1-forest-temple',{templeId:'forest',levels:[
    {id:1,filename:'forest/levels/forest_01.json'},
    {id:5,filename:'forest/levels/forest_05.json'},
  ]});
  const [forest]=await loadGameCatalog({root});
  assert.equal(nextCatalogLevel(forest,1).next.id,5);
  assert.deepEqual(nextCatalogLevel(forest,5),{next:null,complete:true});
  assert.throws(()=>nextCatalogLevel(forest,2),/LEVEL_NOT_IN_GAME/);
  const view=publicCatalog([forest],{forest:{levelId:5}});
  assert.equal(view[0].save.levelId,5);
  assert.equal(view[0].levels.length,2);
  assert.equal(publicCatalog([forest])[0].save,null);
});

test('an incomplete pack fails loudly instead of serving a broken entry',async t=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'game-catalog-bad-'));
  t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(path.join(root,'1-forest-temple'),{recursive:true});
  await writeFile(path.join(root,'1-forest-temple','index.html'),'<html></html>');
  await assert.rejects(loadGameCatalog({root}),/GAME_ENTRY_INVALID/);
  await assert.rejects(loadGameCatalog({root:''}),/GAME_ROOT_REQUIRED/);
  await assert.rejects(loadGameCatalog({root:path.join(root,'missing')}),/GAME_CATALOG_EMPTY/);
});
