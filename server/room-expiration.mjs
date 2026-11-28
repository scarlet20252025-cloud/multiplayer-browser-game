const VACANT_TTL_MS=10*60*1000;
const COMPETITIVE_RUNTIMES=new Set(['tank-arena','platform-brawl','bvn33-online','browser-lockstep']);

export function roomOccupiesName(room,hasSession=false){
  return Boolean(hasSession||room?.phase==='starting'||room?.phase==='playing'||room?.members?.some(Boolean));
}

export function createRoomExpiration({registry,catalog,isOccupied,onExpire=()=>{},now=Date.now}){
  const gameIds=new Set(catalog.filter(game=>
    COMPETITIVE_RUNTIMES.has(game.runtime)&&game.capabilities?.save!==true).map(game=>game.id));
  let dirty=false;

  async function reconcile(key){
    const {changed,expired}=registry.reconcileVacancies({key,gameIds,isOccupied,now:now(),ttlMs:VACANT_TTL_MS});
    dirty ||= changed;
    // Drop stale in-memory lobby state before another request can reuse the name.
    for(const roomKey of expired)onExpire(roomKey);
    if(dirty){
      dirty=false;
      try{await registry.persist();}
      catch(error){dirty=true;throw error;}
    }
    return expired;
  }

  return {sync:key=>reconcile(key),sweep:()=>reconcile()};
}
