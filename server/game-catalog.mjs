/** Authored multi-game catalog for the private HTML5 pack. No original assets. */
import path from 'node:path';
import {readFile, stat} from 'node:fs/promises';
import {DEFAULT_SEATS,loadGameManifests,manifestToCatalogDefinition} from './game-adapter.mjs';
import {LOCKSTEP_RUNTIME} from '../public/lockstep/protocol.mjs';
import {ARENA_RUNTIME} from '../public/tank-arena/rules.mjs';
import {BRAWL_RUNTIME} from '../public/platform-brawl/rules.mjs';

const DEFINITIONS = Object.freeze([
  {id:'forest', dir:'1-forest-temple', title:'森林神庙', subtitle:'Forest Temple',
    templeId:'forest', storagePrefix:'fb-forest', dataDir:'forest'},
  {id:'light', dir:'2-light-temple', title:'光明神庙', subtitle:'Light Temple',
    templeId:'light', storagePrefix:'fb-light', dataDir:'light'},
  {id:'ice', dir:'3-ice-temple', title:'冰雪神庙', subtitle:'Ice Temple',
    templeId:'ice', storagePrefix:'fb-ice', dataDir:'ice'},
  {id:'crystal', dir:'4-crystal-temple', title:'水晶神庙', subtitle:'Crystal Temple',
    templeId:'crystal', storagePrefix:'fb-crystal', dataDir:'crystal'},
]);

const decodeTitle = value => String(value ?? '')
  .replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>')
  .replace(/&quot;/g,'"').replace(/&#39;/g,"'").trim();

async function readJson(file){
  let text;
  try{text=await readFile(file,'utf8');}
  catch(error){
    if(error.code==='ENOENT')throw Error('GAME_PACKAGE_INCOMPLETE: '+file);
    throw error;
  }
  try{return JSON.parse(text);}
  catch{throw Error('GAME_METADATA_INVALID: '+file);}
}

function publicLevel(entry, order){
  const id=Number(entry?.id);
  if(!Number.isInteger(id)||id<0)return null;
  if(typeof entry?.filename!=='string'||!/\.json$/.test(entry.filename))return null;
  const type=typeof entry.type==='string'?entry.type.slice(0,24):'general';
  const time=Number(entry.time);
  return {id, order, type, time:Number.isFinite(time)?time:null};
}

function uniqueLevels(temple){
  const output=[], seen=new Set();
  for(const entry of Array.isArray(temple?.levels)?temple.levels:[]){
    const level=publicLevel(entry, output.length);
    if(!level||seen.has(level.id))continue;
    seen.add(level.id);output.push(level);
  }
  return output;
}

/** Authored level list for a Flash/Ruffle package (no server-side level data). */
function flashLevels(raw){
  const output=[];
  for(const entry of Array.isArray(raw?.levels)?raw.levels:[]){
    const id=Number(entry?.id);
    if(!Number.isInteger(id)||id<0)continue;
    const type=typeof entry?.type==='string'?entry.type.slice(0,24):'general';
    const time=Number(entry?.time);
    output.push({id,order:output.length,type,time:Number.isFinite(time)?time:null});
  }
  return output;
}

/** Load playable games from manifests (preferred) or the built-in legacy definitions. */
export async function loadGameCatalog({root, manifests=null, manifestsDir=null, extraRoots={}}={}){
  if(typeof root!=='string'||!root.trim())throw Error('GAME_ROOT_REQUIRED');
  if(manifests&&manifestsDir)throw Error('GAME_CATALOG_SOURCE_CONFLICT');
  if(manifestsDir)manifests=await loadGameManifests({dir:manifestsDir});
  const definitions=manifests
    ?manifests.map(manifestToCatalogDefinition)
    :DEFINITIONS;
  const games=[];
  for(const definition of definitions){
    const isFlash=definition.runtime==='flash-ruffle';
    const isExternal=definition.runtime==='html5-external';
    const isLockstep=definition.runtime===LOCKSTEP_RUNTIME;
    const isStaticGame=isFlash||isExternal||isLockstep||
      [ARENA_RUNTIME,BRAWL_RUNTIME,'shanyi-native'].includes(definition.runtime);
    const serveRoot=isStaticGame&&extraRoots[definition.id]
      ?path.resolve(extraRoots[definition.id])
      :path.resolve(root);
    const dir=path.join(serveRoot,definition.dir);
    try{await stat(dir);}
    catch{continue;}
    if(isStaticGame){
      const levelsPath=path.join(dir,...definition.levelsPath.split('/'));
      if(isLockstep){
        const files=[levelsPath,path.join(dir,definition.bridgeFile)];
        const info=await Promise.all(files.map(file=>stat(file).catch(error=>{
          if(error.code==='ENOENT'||error.code==='ENOTDIR')return null;
          throw error;
        })));
        if(!info.every(file=>file?.isFile()))continue;
      }
      const levels=flashLevels(await readJson(levelsPath)).sort((a,b)=>a.id-b.id);
      if(levels.length<1)throw Error('GAME_LEVELS_MISSING: '+definition.id);
      games.push(Object.freeze({
        id:definition.id,title:definition.title,subtitle:definition.subtitle,
        dir:definition.dir,script:null,requireScript:null,
        entryPath:'/'+definition.dir+'/'+(definition.entryFile??'index.html'),
        wrapperFile:definition.wrapperFile??null,gameFile:definition.gameFile??null,
        ...(isLockstep?{bridgeFile:definition.bridgeFile,tickRate:definition.tickRate}:{}),
        templeId:definition.templeId,storagePrefix:definition.storagePrefix,
        runtime:definition.runtime,adapter:definition.adapter,listed:definition.listed!==false,
        capabilities:definition.capabilities??null,seats:definition.seats??DEFAULT_SEATS,
        minSeats:definition.minSeats??definition.seats??DEFAULT_SEATS,
        levels,
        serveRoot,flash:isFlash,external:isExternal,experimental:isFlash,
      }));
      continue;
    }
    let meta={};
    try{meta=JSON.parse(await readFile(path.join(dir,'game.json'),'utf8'));}
    catch{}
    const index=await readFile(path.join(dir,'index.html'),'utf8').catch(()=>'');
    const main=/data-main="([^"]+)"/.exec(index)?.[1];
    const requireScript=/<script[^>]+src="([^"]*require\.js)"/.exec(index)?.[1];
    const gameScript=main==='game.js'?'game.js':main;
    if(!gameScript)throw Error('GAME_ENTRY_INVALID: '+definition.id);
    const scriptPath=path.posix.join(definition.dir,gameScript);
    const entryPath='/'+definition.dir+'/'+(definition.entryFile??'index.html');
    const templePath=definition.levelsPath
      ?path.join(dir,...definition.levelsPath.split('/'))
      :path.join(dir,'data',definition.dataDir,'temple.json');
    const temple=await readJson(templePath);
    if(temple?.id!==definition.templeId)
      throw Error('GAME_TEMPLE_MISMATCH: '+definition.id);
    const levels=uniqueLevels(temple).sort((a,b)=>a.id-b.id);
    if(levels.length<1)throw Error('GAME_LEVELS_MISSING: '+definition.id);
    games.push(Object.freeze({
      id:definition.id,title:definition.title,
      subtitle:decodeTitle(meta.title)||definition.subtitle,
      dir:definition.dir,script:scriptPath,
      entryPath,requireScript:requireScript
        ?path.posix.normalize(path.posix.join(definition.dir,requireScript))
        :path.posix.join('lib','require.js'),
      templeId:definition.templeId,
      storagePrefix:definition.storagePrefix,
      runtime:definition.runtime??'html5-phaser',
      adapter:definition.adapter??'fireboy-html5',
      listed:definition.listed!==false,
      capabilities:definition.capabilities??null,
      seats:definition.seats??DEFAULT_SEATS,
      minSeats:definition.minSeats??definition.seats??DEFAULT_SEATS,
      levels,serveRoot,flash:false,experimental:false,
    }));
  }
  if(!games.length)throw Error('GAME_CATALOG_EMPTY');
  return Object.freeze(games);
}

export function gameFor(catalog, gameId){
  return catalog.find(game=>game.id===gameId)??null;
}

/** Next standard level by numeric progression, matching the authority gate. */
export function nextCatalogLevel(game, levelId){
  if(!game||!Array.isArray(game.levels))throw Error('INVALID_GAME');
  const ids=game.levels.map(level=>level.id);
  if(!ids.includes(levelId))throw Error('LEVEL_NOT_IN_GAME');
  const next=game.levels.find(level=>level.id>levelId)??null;
  return next?{next,complete:false}:{next:null,complete:true};
}

export function publicCatalog(catalog, saves={}){
  return catalog.map(game=>({
    id:game.id,title:game.title,subtitle:game.subtitle,runtime:game.runtime,
    adapter:game.adapter,experimental:game.experimental===true,
    ...(game.listed===false?{listed:false}:{}),
    seats:game.seats??DEFAULT_SEATS,
    minSeats:game.minSeats??game.seats??DEFAULT_SEATS,
    levels:game.levels.map(level=>({...level})),
    save:saves?.[game.id]??null,
  }));
}
