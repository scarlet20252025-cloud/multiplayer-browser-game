/** Persistent, loopback-only room names and per-game saves. Passwords are hashed. */
import path from 'node:path';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {randomBytes,scryptSync,timingSafeEqual} from 'node:crypto';

const SCHEMA_VERSION=1;
const NAME_MIN=2,NAME_MAX=24,PASSWORD_MIN=4,PASSWORD_MAX=64;
const NAME_PATTERN=/^[\p{L}\p{N} _\-·.]+$/u;
const GAME_ID_PATTERN=/^[a-z][a-z0-9-]{1,31}$/;

export function normalizeRoomName(value){
  if(typeof value!=='string')throw coded('ROOM_NAME_REQUIRED','请输入房间名');
  const display=value.normalize('NFC').trim().replace(/\s+/g,' ');
  const length=Array.from(display).length;
  if(length<NAME_MIN||length>NAME_MAX)
    throw coded('ROOM_NAME_LENGTH',`房间名需要 ${NAME_MIN}-${NAME_MAX} 个字符`);
  if(!NAME_PATTERN.test(display))
    throw coded('ROOM_NAME_CHARSET','房间名只能包含文字、数字、空格、_ - · .');
  return {
    display,
    key:display.toLocaleLowerCase('en-US'),
  };
}

export function validateRoomPassword(value){
  if(typeof value!=='string')throw coded('PASSWORD_REQUIRED','请输入密码');
  const length=Array.from(value).length;
  if(length<PASSWORD_MIN||length>PASSWORD_MAX)
    throw coded('PASSWORD_LENGTH',`密码需要 ${PASSWORD_MIN}-${PASSWORD_MAX} 个字符`);
  if(/[\u0000-\u001f\u007f]/.test(value))
    throw coded('PASSWORD_CHARSET','密码不能包含控制字符');
  return value;
}

function coded(code,message){
  return Object.assign(new Error(message),{code});
}

function hashPassword(password,salt=randomBytes(16).toString('hex')){
  const hash=scryptSync(password,salt,32,{N:16384,r:8,p:1}).toString('hex');
  return {salt,hash};
}

function passwordMatches(record,password){
  if(!record?.salt||!/^[a-f0-9]{32}$/.test(record.salt)||!/^[a-f0-9]{64}$/.test(record.hash??''))
    return false;
  const attempt=scryptSync(password,record.salt,32,{N:16384,r:8,p:1});
  return timingSafeEqual(attempt,Buffer.from(record.hash,'hex'));
}

export class RoomRegistry {
  constructor({file}={}){
    if(typeof file!=='string'||!file.trim())throw new TypeError('Registry file required');
    this.file=path.resolve(file);
    this.data={version:SCHEMA_VERSION,rooms:{}};
    this.queue=Promise.resolve();
    this.loaded=false;
  }
  async load(){
    if(this.loaded)return this;
    try{
      const text=await readFile(this.file,'utf8');
      const parsed=JSON.parse(text);
      if(parsed?.version!==SCHEMA_VERSION||!parsed.rooms||typeof parsed.rooms!=='object')
        throw coded('ROOM_REGISTRY_INVALID','房间存档格式不受支持');
      this.data=parsed;
    }catch(error){
      if(error.code==='ENOENT'){
        await mkdir(path.dirname(this.file),{recursive:true});
        await this.persist();
      }else if(error.code==='ROOM_REGISTRY_INVALID'){
        throw error;
      }else if(error instanceof SyntaxError){
        throw coded('ROOM_REGISTRY_INVALID','房间存档不是有效 JSON');
      }else throw error;
    }
    this.loaded=true;
    return this;
  }
  persist(){
    const task=async()=>{
      const temp=this.file+'.tmp-'+process.pid;
      await mkdir(path.dirname(this.file),{recursive:true});
      await writeFile(temp,JSON.stringify(this.data,null,2)+'\n',{mode:0o600});
      await rename(temp,this.file);
    };
    this.queue=this.queue.then(task,task);
    return this.queue;
  }
  record(key){
    return Object.hasOwn(this.data.rooms,key)?this.data.rooms[key]:null;
  }
  /** Create a globally unique persistent room name. */
  async create({name,password,gameId,now=new Date().toISOString()}){
    const {display,key}=normalizeRoomName(name);
    validateRoomPassword(password);
    if(gameId!==undefined&&(typeof gameId!=='string'||!GAME_ID_PATTERN.test(gameId)))
      throw coded('GAME_ID_INVALID','游戏标识无效');
    if(this.record(key))
      throw coded('ROOM_NAME_TAKEN','这个房间名已被使用，请换一个（房间名用于长期存档）');
    const hashed=hashPassword(password);
    Object.defineProperty(this.data.rooms,key,{enumerable:true,configurable:true,writable:true,
      value:{name:display,createdAt:now,salt:hashed.salt,hash:hashed.hash,saves:{},
        ...(gameId?{gameId}:{})}});
    await this.persist();
    return this.publicRoom(key);
  }
  async authenticate({name,password}){
    const {key}=normalizeRoomName(name);
    validateRoomPassword(password);
    const record=this.record(key);
    if(!record)throw coded('ROOM_NOT_FOUND','没有找到这个房间名');
    if(!passwordMatches(record,password))
      throw coded('ROOM_PASSWORD_WRONG','房间密码不正确');
    return this.publicRoom(key);
  }
  async bindGame(key,gameId){
    const record=this.record(key);
    if(!record)throw coded('ROOM_NOT_FOUND','房间不存在');
    if(typeof gameId!=='string'||!GAME_ID_PATTERN.test(gameId))
      throw coded('GAME_ID_INVALID','游戏标识无效');
    if(record.gameId===gameId)return;
    if(record.gameId)throw coded('ROOM_GAME_LOCKED','此房间已绑定另一款游戏');
    record.gameId=gameId;
    await this.persist();
  }
  async migrateGameBindings(gameIds){
    const installed=new Set(gameIds);
    let changed=false;
    for(const room of Object.values(this.data.rooms)){
      if(room.gameId)continue;
      const saves=Object.entries(room.saves??{}).filter(([id])=>installed.has(id));
      saves.sort((a,b)=>String(b[1]?.updatedAt??'').localeCompare(String(a[1]?.updatedAt??'')));
      const [latest,next]=saves;
      if(latest&&(!next||latest[1]?.updatedAt&&latest[1].updatedAt!==next[1]?.updatedAt)){
        room.gameId=latest[0];
        changed=true;
      }
    }
    if(changed)await this.persist();
  }
  async setSave(key,gameId,save){
    const record=this.record(key);
    if(!record)throw coded('ROOM_NOT_FOUND','房间不存在');
    if(typeof gameId!=='string'||!GAME_ID_PATTERN.test(gameId))
      throw coded('GAME_ID_INVALID','游戏标识无效');
    if(!Number.isInteger(save?.levelId)||save.levelId<0)
      throw coded('SAVE_LEVEL_INVALID','关卡存档无效');
    record.saves[gameId]={
      levelId:save.levelId,
      updatedAt:new Date().toISOString(),
      ...(Number.isInteger(save.round)?{round:save.round}:{}),
      ...(typeof save.completed==='boolean'?{completed:save.completed}:{}),
    };
    await this.persist();
    return {...record.saves[gameId]};
  }
  reconcileVacancies({key,gameIds,isOccupied,now,ttlMs}){
    const keys=key===undefined?Object.keys(this.data.rooms):[key];
    const expired=[];
    let changed=false;
    for(const roomKey of keys){
      const room=this.record(roomKey);
      if(!room||!gameIds.has(room.gameId)||Object.keys(room.saves??{}).length)continue;
      if(isOccupied(roomKey)){
        if(Object.hasOwn(room,'vacantSince')){
          delete room.vacantSince;
          changed=true;
        }
        continue;
      }
      if(!Number.isSafeInteger(room.vacantSince)||room.vacantSince<0||room.vacantSince>now){
        room.vacantSince=now;
        changed=true;
      }else if(now-room.vacantSince>=ttlMs){
        delete this.data.rooms[roomKey];
        expired.push(roomKey);
        changed=true;
      }
    }
    return {changed,expired};
  }
  list(){
    return Object.keys(this.data.rooms)
      .map(key=>this.publicRoom(key))
      .filter(Boolean)
      .sort((a,b)=>String(b.createdAt??'').localeCompare(String(a.createdAt??'')));
  }
  saves(key){
    return {...(this.record(key)?.saves??{})};
  }
  publicRoom(key){
    const record=this.record(key);
    if(!record)return null;
    return {key,name:record.name,createdAt:record.createdAt,saves:{...record.saves},
      ...(record.gameId?{gameId:record.gameId}:{})};
  }
}

export const _test={hashPassword,passwordMatches};
