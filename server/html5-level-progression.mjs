/**
 * Read-only native progression gate shared by all legacy temples.
 * Never sets a win flag or changes original assets/game progress.
 * A native completed level AND both raised original doors are required.
 */
export function inspectNativeWin(snapshot){
  if(!snapshot || typeof snapshot!=='object')return {won:false,reason:'INVALID_SNAPSHOT'};
  if(snapshot.level?.ended!==true)return {won:false,reason:'LEVEL_NOT_ENDED'};
  if(!Array.isArray(snapshot.characters)||snapshot.characters.length!==2)
    return {won:false,reason:'INVALID_CHARACTERS'};
  if(snapshot.characters.some(x=>x.gameplay?.dead===true||x.gameplay?.dying===true))
    return {won:false,reason:'CHARACTER_DIED'};
  if(!Array.isArray(snapshot.doors)||snapshot.doors.length!==2)
    return {won:false,reason:'INVALID_DOORS'};
  if(snapshot.doors.some(x=>x.isUp!==true))
    return {won:false,reason:'DOORS_NOT_BOTH_RAISED'};
  return {won:true,reason:'LEVEL_WON'};
}
const standardId=(id,min=0,max=999)=>Number.isSafeInteger(id)&&id>=min&&id<=max;
const safeFilename=filename=>typeof filename==='string'&&filename.length<=160&&
  !filename.includes('..')&&!filename.startsWith('/')&&
  /^[A-Za-z0-9_./-]+\.json$/.test(filename);
/** Forest keeps its audited 1..32 standard progression. */
export function nextForestLevel({currentLevelId,temple,proof}={}){
  if(proof?.won!==true||proof?.reason!=='LEVEL_WON')
    throw Error('NATIVE_VICTORY_REQUIRED');
  if(!standardId(currentLevelId,1,32))throw Error('INVALID_CURRENT_LEVEL');
  if(!temple||temple.id!=='forest'||!Array.isArray(temple.levels))
    throw Error('INVALID_NATIVE_TEMPLE');
  const baseLevels=temple.levels.filter(x=>standardId(x?.id,1,32));
  const ids=new Set(baseLevels.map(x=>x.id));
  if(ids.size!==baseLevels.length)throw Error('DUPLICATE_NATIVE_LEVELS');
  const current=baseLevels.find(x=>x.id===currentLevelId);
  if(!current)throw Error('CURRENT_LEVEL_NOT_IN_ORIGINAL_TEMPLE');
  const next=baseLevels.filter(x=>x.id>currentLevelId)
    .sort((a,b)=>a.id-b.id)[0];
  if(!next)return {next:null,complete:true,currentLevelId};
  if(typeof next.filename!=='string'||!/^forest\/levels\/forest_\d{2}\.json$/.test(next.filename))
    throw Error('UNEXPECTED_NEXT_LEVEL_FILENAME');
  return {next:{id:next.id,filename:next.filename,type:next.type??null},
    complete:false,currentLevelId};
}
/** Numeric progression for the other single-temple legacy packs. */
export function nextTempleLevel({currentLevelId,temple,proof,templeId}={}){
  if(proof?.won!==true||proof?.reason!=='LEVEL_WON')
    throw Error('NATIVE_VICTORY_REQUIRED');
  if(!temple||!Array.isArray(temple.levels)||
     (templeId&&temple.id!==templeId))throw Error('INVALID_NATIVE_TEMPLE');
  if(!standardId(currentLevelId,0,999))throw Error('INVALID_CURRENT_LEVEL');
  const levels=temple.levels.filter(x=>standardId(x?.id,0,999)&&safeFilename(x?.filename));
  const ids=new Set(levels.map(x=>x.id));
  if(ids.size!==levels.length)throw Error('DUPLICATE_NATIVE_LEVELS');
  const current=levels.find(x=>x.id===currentLevelId);
  if(!current)throw Error('CURRENT_LEVEL_NOT_IN_ORIGINAL_TEMPLE');
  const next=levels.filter(x=>x.id>currentLevelId).sort((a,b)=>a.id-b.id)[0];
  if(!next)return {next:null,complete:true,currentLevelId};
  return {next:{id:next.id,filename:next.filename,type:next.type??null},
    complete:false,currentLevelId};
}
