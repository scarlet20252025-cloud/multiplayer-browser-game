#!/usr/bin/env node
/** Loopback multi-game room lobby: viewer host + matching service. */
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {loadGameCatalog} from '../server/game-catalog.mjs';
import {loadGameManifests} from '../server/game-adapter.mjs';
import {LOCKSTEP_RUNTIME} from '../public/lockstep/protocol.mjs';
import {ARENA_RUNTIME} from '../public/tank-arena/rules.mjs';
import {BRAWL_RUNTIME} from '../public/platform-brawl/rules.mjs';
import {BVN33_GAME, BVN33_RUNTIME, createBvn33RoomService} from '../server/bvn33-room-service.mjs';
import {BVN_VIEWER_PATH, createBvn33ViewerProxy} from '../server/bvn33-viewer-proxy.mjs';
import {createGlortonViewerProxy} from '../server/glorton-viewer-proxy.mjs';
import {createGlortonBrowserRooms} from '../server/glorton-browser-rooms.mjs';
import {startRoomLobby} from '../server/room-lobby.mjs';
import {startHtml5ResearchHost} from './html5-research-host.mjs';

const REPO_ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');

export async function startGameLobby({
  root, viewerPort=8787, lobbyPort=8788, roomsFile=null, expectedForestSha256=null, manifestsDir=null,
  shanyiRoot=null, ruffleDir=null, bombItSwf=process.env.BOMB_IT_ORIGINAL_SWF||null,
  host=process.env.MULTIPLAYER_HOST||'127.0.0.1',
  publicHost=process.env.MULTIPLAYER_PUBLIC_HOST||null,
  publicViewerPort=process.env.MULTIPLAYER_PUBLIC_VIEWER_PORT?Number(process.env.MULTIPLAYER_PUBLIC_VIEWER_PORT):null,
  publicLobbyPort=process.env.MULTIPLAYER_PUBLIC_LOBBY_PORT?Number(process.env.MULTIPLAYER_PUBLIC_LOBBY_PORT):null,
  lanViewerOrigin=process.env.MULTIPLAYER_LAN_VIEWER_ORIGIN||null,
  wanViewerOrigin=process.env.MULTIPLAYER_WAN_VIEWER_ORIGIN||null,
  authorityPort=process.env.MULTIPLAYER_AUTHORITY_PORT?Number(process.env.MULTIPLAYER_AUTHORITY_PORT):0,
  authorityPublicPort=process.env.MULTIPLAYER_AUTHORITY_PUBLIC_PORT?Number(process.env.MULTIPLAYER_AUTHORITY_PUBLIC_PORT):null,
  mirrorPort=process.env.MULTIPLAYER_MIRROR_PORT?Number(process.env.MULTIPLAYER_MIRROR_PORT):0,
  mirrorPublicPort=process.env.MULTIPLAYER_MIRROR_PUBLIC_PORT?Number(process.env.MULTIPLAYER_MIRROR_PUBLIC_PORT):null,
  bvn33ServiceUrl=process.env.BVN33_SERVICE_URL??null,
  bvn33PublicUrl=process.env.BVN33_PUBLIC_URL??bvn33ServiceUrl,
  glortonServiceUrl=process.env.GLORTON_SERVICE_URL??null,
  glortonLocalWebRoot=process.env.GLORTON_LOCAL_WEB_ROOT??null,
}={}){
  for(const [key,port] of [['viewerPort',viewerPort],['lobbyPort',lobbyPort]]){
    if(!Number.isSafeInteger(port)||port<1024||port>65535)
      throw new RangeError(key+' must be a nonprivileged TCP port');
  }
  for(const [key,port] of [['publicViewerPort',publicViewerPort],['publicLobbyPort',publicLobbyPort],
    ['authorityPublicPort',authorityPublicPort],['mirrorPublicPort',mirrorPublicPort]]){
    if(port!==null&&(!Number.isSafeInteger(port)||port<1||port>65535))
      throw new RangeError(key+' must be a TCP port');
  }
  for(const [key,port] of [['authorityPort',authorityPort],['mirrorPort',mirrorPort]]){
    if(!Number.isSafeInteger(port)||port<0||port>65535)
      throw new RangeError(key+' must be a TCP port or 0');
  }
  if(viewerPort===lobbyPort)throw Error('Viewer and lobby ports must be distinct');
  if(typeof root!=='string'||!root.trim())throw Error('Private games root required');
  const flashRoot=path.resolve(shanyiRoot??path.join(REPO_ROOT,'local','private-games'));
  const manifestGames=path.resolve(manifestsDir??path.join(REPO_ROOT,'config','games'));
  const manifests=await loadGameManifests({dir:manifestGames});
  const extraRoots={shanyi:flashRoot};
  for(const manifest of manifests){
    if(manifest.runtime===LOCKSTEP_RUNTIME)extraRoots[manifest.id]=flashRoot;
    if([ARENA_RUNTIME,BRAWL_RUNTIME].includes(manifest.runtime))extraRoots[manifest.id]=path.join(REPO_ROOT,'public');
  }
  const staticCatalog=await loadGameCatalog({root,manifests,extraRoots});
  const bvn33Service=bvn33ServiceUrl?createBvn33RoomService(bvn33ServiceUrl,bvn33PublicUrl):null;
  if(bvn33Service)await bvn33Service.check();
  const catalog=bvn33Service?Object.freeze([...staticCatalog,BVN33_GAME]):staticCatalog;
  if(expectedForestSha256){
    if(!/^[a-f0-9]{64}$/.test(expectedForestSha256))throw Error('Invalid expected SHA-256');
    const forest=catalog.find(game=>game.id==='forest');
    if(!forest)throw Error('Forest game missing from catalog');
  }
  const displayHost=typeof publicHost==='string'&&publicHost.trim()?publicHost.trim():host;
  const displayViewerPort=publicViewerPort??viewerPort;
  const viewerOrigin=`http://${displayHost}:${displayViewerPort}`;
  const bvnBrowser=bvn33Service?new URL(bvn33PublicUrl):null;
  const bvnProxy=bvnBrowser?.origin===viewerOrigin&&bvnBrowser.pathname===BVN_VIEWER_PATH
    ?createBvn33ViewerProxy(bvn33ServiceUrl,viewerOrigin):null;
  const glortonProxy=glortonServiceUrl
    ?createGlortonViewerProxy(glortonServiceUrl,[viewerOrigin,lanViewerOrigin,wanViewerOrigin]):null;
  let lobby,viewers;
  const localWebRoot=glortonLocalWebRoot?path.resolve(glortonLocalWebRoot):null;
  const glortonBrowser=localWebRoot?createGlortonBrowserRooms({
    localWebRoot,
    isRoomNameTaken:key=>Boolean(lobby?.registry.record(key)||lobby?.registry.list().some(room=>room.key.normalize('NFKC')===key)),
    viewerOrigins:[viewerOrigin,lanViewerOrigin,wanViewerOrigin].filter(Boolean),
    ...(glortonServiceUrl?{serviceUrl:new URL('/ws',glortonServiceUrl).href.replace(/^http:/,'ws:')}:{}),
  }):null;
  const arenaOnViewer=publicViewerPort!==null;
  try{
    lobby=await startRoomLobby({port:lobbyPort,host,publicHost:displayHost,publicPort:publicLobbyPort,
      gamesRoot:root,catalog,viewerOrigin,
      authorityPort,authorityPublicPort,mirrorPort,mirrorPublicPort,
      bvn33Service,arenaOnViewer,listAdditionalRooms:glortonBrowser?.listRooms,
      hasAdditionalRoomName:glortonBrowser?.hasRoomName,
      ...(roomsFile?{roomsFile}:{})});
    viewers=await startHtml5ResearchHost({root,games:catalog.filter(game=>game.runtime!==BVN33_RUNTIME),
      port:viewerPort,publicPort:publicViewerPort,host,publicHost:displayHost,lobbyWsUrl:lobby.lobbyWsUrl,
      lobbyHttpHandler:lobby.handleHttp,lanViewerOrigin,wanViewerOrigin,bvnProxy,glortonProxy,glortonBrowser,
      glortonLocalWebRoot:localWebRoot,
      bombItSwf:bombItSwf??path.join(flashRoot,'bomb-it-7-original.swf'),
      arenaViewerUpgrade:lobby.handleArenaViewerUpgrade,
      ...(ruffleDir?{ruffleDir}:{})});
    const forest=viewers.games.find(game=>game.id==='forest');
    if(expectedForestSha256&&forest?.sourceSha256!==expectedForestSha256)
      throw Error('Private forest game SHA differs from required build');
    let closing;
    return Object.freeze({
      url:viewers.entryUrl,lobbyWsUrl:lobby.lobbyWsUrl,catalog,
      lobby,viewers,roomServiceUrl:lobby.url,glortonBrowser:glortonBrowser!==null,glortonLocalRender:Boolean(localWebRoot),
      close(){
        if(!closing)closing=(async()=>{
          await viewers.close().catch(()=>{});
          await lobby.close().catch(()=>{});
        })();
        return closing;
      },
    });
  }catch(error){
    if(!viewers){glortonProxy?.close();glortonBrowser?.close();}
    await viewers?.close().catch(()=>{});
    await lobby?.close().catch(()=>{});
    throw error;
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const {values}=parseArgs({options:{
      root:{type:'string'},'viewer-port':{type:'string'},'lobby-port':{type:'string'},
      'rooms-file':{type:'string'},'expected-forest-sha256':{type:'string'},'manifests':{type:'string'},
      'shanyi-root':{type:'string'},'ruffle-dir':{type:'string'},'bomb-it-swf':{type:'string'},host:{type:'string'},'public-host':{type:'string'},
      'public-viewer-port':{type:'string'},'public-lobby-port':{type:'string'},
      'lan-viewer-origin':{type:'string'},'wan-viewer-origin':{type:'string'},
      'authority-port':{type:'string'},'authority-public-port':{type:'string'},
      'mirror-port':{type:'string'},'mirror-public-port':{type:'string'},
    }});
    const app=await startGameLobby({
      root:values.root,
      viewerPort:values['viewer-port']===undefined?8787:Number(values['viewer-port']),
      lobbyPort:values['lobby-port']===undefined?8788:Number(values['lobby-port']),
      roomsFile:values['rooms-file']??null,
      expectedForestSha256:values['expected-forest-sha256']??null,
      manifestsDir:values.manifests??null,
      host:values.host??'127.0.0.1',
      publicHost:values['public-host']??null,
      ...(values['public-viewer-port']?{publicViewerPort:Number(values['public-viewer-port'])}:{}),
      ...(values['public-lobby-port']?{publicLobbyPort:Number(values['public-lobby-port'])}:{}),
      ...(values['lan-viewer-origin']?{lanViewerOrigin:values['lan-viewer-origin']}:{}),
      ...(values['wan-viewer-origin']?{wanViewerOrigin:values['wan-viewer-origin']}:{}),
      ...(values['authority-port']?{authorityPort:Number(values['authority-port'])}:{}),
      ...(values['authority-public-port']?{authorityPublicPort:Number(values['authority-public-port'])}:{}),
      ...(values['mirror-port']?{mirrorPort:Number(values['mirror-port'])}:{}),
      ...(values['mirror-public-port']?{mirrorPublicPort:Number(values['mirror-public-port'])}:{}),
      ...(values['shanyi-root']?{shanyiRoot:values['shanyi-root']}:{}),
      ...(values['ruffle-dir']?{ruffleDir:values['ruffle-dir']}:{}),
      ...(values['bomb-it-swf']?{bombItSwf:values['bomb-it-swf']}:{}),
    });
    console.log(JSON.stringify({
      kind:'loopback-multi-game-room-lobby',url:app.url,lobbyWsUrl:app.lobbyWsUrl,
      games:app.catalog.map(game=>({id:game.id,title:game.title,levels:game.levels.length})),
      instructions:'Open the URL, choose a game, create a room name + password; the second player joins with the same name + password',
      sourceIsPrivate:true,noVideo:true,publicHostingEnabled:values.host!==undefined&&values.host!=='127.0.0.1'&&values.host!=='localhost',
    }));
    for(const signal of ['SIGINT','SIGTERM'])
      process.once(signal,()=>void app.close().then(()=>process.exit(0)));
  }catch(error){console.error('GAME_LOBBY_FAILED: '+error.message);process.exitCode=1;}
}
