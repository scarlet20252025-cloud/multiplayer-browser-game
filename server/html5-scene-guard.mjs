/**
 * Fail-closed boundary for a single native HTML5 level instance.
 * The first identity is a real snapshot. No gameplay state is mutated here.
 * A terminal transition is latched; only a separately verified new-session
 * handshake may re-arm a new guard.
 */
export class Html5SceneGuard {
  constructor(initial){
    if(!initial || initial.schemaVersion!==1 || !Number.isSafeInteger(initial.levelEpoch) ||
       initial.levelEpoch<1 || !Number.isSafeInteger(initial.snapshotSeq) ||
       initial.snapshotSeq<1 || typeof initial.sessionEpoch!=='string' ||
       !/^[a-f0-9]{64}$/.test(initial.sourceGameSha256??'') ||
       initial.level?.started!==true || !Array.isArray(initial.characters) ||
       initial.characters.length!==2)
      throw new TypeError('Native first-level identity is incomplete');
    this.sessionEpoch=initial.sessionEpoch;
    this.levelEpoch=initial.levelEpoch;
    this.sourceGameSha256=initial.sourceGameSha256;
    this.sceneName=initial.level.sceneName??null;
    this.lastSeq=initial.snapshotSeq;
    this.latched=null;
  }
  observe(snapshot){
    if(this.latched)return {status:'suspended',reason:this.latched,
      lastSeq:this.lastSeq,levelEpoch:this.levelEpoch};
    let reason=null;
    if(!snapshot||snapshot.schemaVersion!==1||!Number.isSafeInteger(snapshot.snapshotSeq))
      reason='INVALID_STATE';
    else if(snapshot.sessionEpoch!==this.sessionEpoch)
      reason='SESSION_EPOCH_CHANGED';
    else if(snapshot.sourceGameSha256!==this.sourceGameSha256)
      reason='SOURCE_BUILD_CHANGED';
    else if(snapshot.levelEpoch!==this.levelEpoch)
      reason='LEVEL_EPOCH_CHANGED';
    else if(this.sceneName!==null && snapshot.level?.sceneName!==this.sceneName)
      reason='NATIVE_SCENE_CHANGED';
    else if(snapshot.snapshotSeq<=this.lastSeq)
      reason='NON_MONOTONIC_SNAPSHOT';
    else if(snapshot.level?.started!==true)
      reason='LEVEL_STOPPED';
    else if(snapshot.level?.ended===true)
      reason='LEVEL_ENDED';
    else if(!Array.isArray(snapshot.characters)||snapshot.characters.length!==2)
      reason='CHARACTERS_MISSING';
    else if(snapshot.characters.some(x=>x.gameplay?.dead===true))
      reason='CHARACTER_DEAD';
    else if(snapshot.characters.some(x=>x.gameplay?.dying===true))
      reason='CHARACTER_DYING';
    if(reason){
      this.latched=reason;
      return {status:'suspended',reason,lastSeq:this.lastSeq,levelEpoch:this.levelEpoch};
    }
    this.lastSeq=snapshot.snapshotSeq;
    return {status:'active',lastSeq:this.lastSeq,levelEpoch:this.levelEpoch};
  }
  get suspended(){return this.latched!==null;}
}
