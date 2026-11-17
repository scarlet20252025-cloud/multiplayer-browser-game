/** Offline Tiled object inspection. Does not load or publish game assets. */
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
const isInt=x=>Number.isSafeInteger(x)&&x>=0;
function tileGid(raw){
  if(!isInt(raw)||raw>0xffffffff)throw new TypeError('Tiled gid must be a 32-bit unsigned integer');
  return (raw>>>0)&0x0fffffff; // 4 high-bit transform flags, not part of the tile index
}
export function inspectTiledObjectLayer(map,objectsTileset){
  if(!map||!Array.isArray(map.layers)||!Array.isArray(map.tilesets)||
    !objectsTileset||typeof objectsTileset.tiles!=='object')
    throw new TypeError('Valid Tiled JSON map and Objects tileset required');
  const sets=[...map.tilesets].sort((a,b)=>a.firstgid-b.firstgid);
  if(sets.some(s=>!Number.isSafeInteger(s.firstgid)||s.firstgid<1))throw new TypeError('Bad firstgid');
  if(new Set(sets.map(s=>s.firstgid)).size!==sets.length)throw new TypeError('Duplicate firstgid');
  const name=s=>String(s.source??s.name??'').split(/[\\/]/).at(-1);
  const objectSet=sets.filter(s=>name(s)==='Objects.json');
  if(objectSet.length!==1)throw new TypeError('Expected exactly one Objects.json tileset reference');
  const outputs=[];
  const layer=map.layers.find(l=>l.name==='Objects'&&Array.isArray(l.objects));
  if(!layer)throw new TypeError('Objects layer missing');
  for(const obj of layer.objects){
    if(!isInt(obj.id)||!Number.isFinite(obj.x)||!Number.isFinite(obj.y))
      throw new TypeError('Malformed map object identity or position');
    let type=null,tileId=null,source='unclassified';
    if(obj.gid!==undefined&&obj.gid!==null){
      const gid=tileGid(obj.gid);
      const set=[...sets].reverse().find(s=>s.firstgid<=gid);
      if(set && set.firstgid===objectSet[0].firstgid){
        tileId=gid-set.firstgid;
        const tile=Array.isArray(objectsTileset.tiles)?
          objectsTileset.tiles.find(t=>t.id===tileId):
          objectsTileset.tiles[String(tileId)];
        type=typeof tile?.type==='string'?tile.type:null;
        source='Objects.json gid via level-specific firstgid';
      }else source='other-tileset-or-unmapped-gid';
    }else if(typeof obj.type==='string'&&obj.type){
      type=obj.type;
      source='explicit Tiled object type';
    }
    outputs.push({id:obj.id,type,tileId,source,
      x:obj.x,y:obj.y,group:obj.properties?.group??null});
  }
  return {schemaVersion:1,firstgid:objectSet[0].firstgid,objectCount:outputs.length,
    types:outputs.reduce((acc,o)=>(acc[o.type??'unclassified']=(acc[o.type??'unclassified']??0)+1,acc),{}),
    objects:outputs,gameplayVerified:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{
    map:{type:'string'},'objects-tileset':{type:'string'},out:{type:'string'}
  }});
  if(!values.map||!values['objects-tileset']){
    console.error('Provide local --map and --objects-tileset JSON paths');
    process.exitCode=2;
  }else{
    try{
      const map=JSON.parse(await readFile(values.map,'utf8'));
      const tile=JSON.parse(await readFile(values['objects-tileset'],'utf8'));
      const result=inspectTiledObjectLayer(map,tile);
      const out=path.resolve(values.out??'local/tiled-objects-summary.json');
      await mkdir(path.dirname(out),{recursive:true});
      await writeFile(out,JSON.stringify(result,null,2)+'\n');
      console.log(JSON.stringify({status:'inspected',firstgid:result.firstgid,
        types:result.types,out,gameplayVerified:false}));
    }catch(e){console.error('TILED_INSPECT_FAILED: '+e.message);process.exitCode=2;}
  }
}
