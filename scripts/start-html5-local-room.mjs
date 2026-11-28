#!/usr/bin/env node
/** Authored localhost-only two-tab launcher; original assets read from private directory. */
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';
import {startHtml5ResearchRoom} from '../server/html5-research-room.mjs';
import {startHtml5ResearchHost} from './html5-research-host.mjs';
const REQUIRE='bower_components/requirejs/require.js';
export async function startHtml5LocalRoom({
  root,script,requireScript=REQUIRE,entryPath='/',levelId=1,
  viewerPort=8787,roomPort=8788,expectedSha256=null
}={}){
  for(const [key,port] of [['viewerPort',viewerPort],['roomPort',roomPort]]){
    if(!Number.isSafeInteger(port)||port<1024||port>65535)
      throw new RangeError(key+' must be a nonprivileged TCP port');
  }
  if(viewerPort===roomPort)throw new Error('Viewer and authority ports must be distinct');
  if(!Number.isSafeInteger(levelId)||levelId<1)throw Error('Invalid official level ID');
  if(typeof root!=='string'||!root.trim()||typeof script!=='string'||!script.trim())
    throw Error('Expected private --root and --script');
  if(expectedSha256!==null&&!/^[a-f0-9]{64}$/.test(expectedSha256))
    throw Error('Invalid expected source SHA-256');
  const viewerOrigin='http://127.0.0.1:'+viewerPort;
  const wsUrl='ws://127.0.0.1:'+roomPort+'/ws';
  let authority,viewers;
  try{
    authority=await startHtml5ResearchRoom({root,script,requireScript,
      entryPath,levelId,port:roomPort,allowedViewerOrigins:[viewerOrigin]});
    if(expectedSha256!==null&&authority.sourceSha256!==expectedSha256)
      throw Error('Private original game SHA differs from required build');
    viewers=await startHtml5ResearchHost({root,script,requireScript,entryPath,
      port:viewerPort,autoJoinWsUrl:wsUrl,autoJoinLevelId:levelId});
    if(viewers.sourceSha256!==authority.sourceSha256)
      throw Error('Private client and native authority scripts differ');
    let closing;
    return Object.freeze({
      url:viewers.entryUrl,wsUrl,sourceSha256:authority.sourceSha256,
      authority,viewers,levelId,
      close(){
        if(!closing)closing=(async()=>{
          await viewers.close();
          await authority.close();
        })();
        return closing;
      }
    });
  }catch(err){
    await viewers?.close().catch(()=>{});
    await authority?.close().catch(()=>{});
    throw err;
  }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  try{
    const {values}=parseArgs({options:{
      root:{type:'string'},script:{type:'string'},'require-script':{type:'string'},
      'entry-path':{type:'string'},'level-id':{type:'string'},
      'viewer-port':{type:'string'},'room-port':{type:'string'},
      'expected-sha256':{type:'string'}
    }});
    const app=await startHtml5LocalRoom({
      root:values.root,script:values.script,
      requireScript:values['require-script']??REQUIRE,
      entryPath:values['entry-path']??'/',
      levelId:values['level-id']===undefined?1:Number(values['level-id']),
      viewerPort:values['viewer-port']===undefined?8787:Number(values['viewer-port']),
      roomPort:values['room-port']===undefined?8788:Number(values['room-port']),
      expectedSha256:values['expected-sha256']??null
    });
    console.log(JSON.stringify({
      kind:'loopback-html5-native-two-tab-lab',url:app.url,
      instructions:'Open the same URL in two tabs on this computer; first is Fireboy, second Watergirl',
      gameSha256:app.sourceSha256,sourceIsPrivate:true,
      noVideo:true,originalPackageBaseline:false,publicHostingEnabled:false
    }));
    for(const signal of ['SIGINT','SIGTERM'])
      process.once(signal,()=>void app.close().then(()=>process.exit(0)));
  }catch(error){console.error('HTML5_LOCAL_ROOM_FAILED: '+error.message);process.exitCode=1;}
}
