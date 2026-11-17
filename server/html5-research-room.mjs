/** Loopback-only research: two WebSockets, ONE HTML5/Box2D authority, no video. */
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {WebSocket,WebSocketServer} from 'ws';
import {startHtml5ResearchHost} from '../scripts/html5-research-host.mjs';
import {Html5RoomCore} from './html5-room-core.mjs';
const id=()=>randomBytes(16).toString('hex');
export async function startHtml5ResearchRoom({root,script,requireScript,entryPath,levelId=1,port=0,allowedViewerOrigins=[]}={}){
  if(!Number.isInteger(port)||port<0||port>65535)throw new RangeError('Invalid research port');
  if(!Array.isArray(allowedViewerOrigins)||allowedViewerOrigins.some(origin=>{
    try{const url=new URL(origin);return url.protocol!=='http:'||!['127.0.0.1','localhost'].includes(url.hostname)||url.origin!==origin;}
    catch{return true;}
  }))throw new TypeError('Viewer origins must be explicit local HTTP origins');
  const viewerOrigins=new Set(allowedViewerOrigins);
  let host,browser,page;
  try{
    host=await startHtml5ResearchHost({root,script,requireScript,entryPath});
    const launch={timeout:20000};
    if(process.env.CHROMIUM_PATH)launch.executablePath=process.env.CHROMIUM_PATH;
    browser=await chromium.launch(launch);
    page=await browser.newPage({viewport:{width:1280,height:960}});
    await page.route('**/*',route=>{
      try{return new URL(route.request().url()).origin===host.url?route.continue():route.abort();}
      catch{return route.abort();}
    });
    await page.addInitScript(()=>{
      localStorage.setItem('fb-forest:unlock','1');localStorage.removeItem('fb-forest:invulnerable');
    });
    await page.goto(host.entryUrl,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__game?.state?.current==='menu',null,{timeout:60000});
    await page.evaluate(()=>{
      const temple=__game.progress.get('temples').find(x=>x.id==='forest');
      if(!temple)throw Error('Forest temple missing');
      __game.state.states[__game.state.current].startTemple(temple);
    });
    await page.waitForFunction(()=>__game.state.current==='levelMenu'&&!__game.state.fading&&
      __game.state.states.levelMenu.buttons,null,{timeout:30000});
    const level=await page.evaluate(id=>{
      const menu=__game.state.states.levelMenu;
      const found=menu.templeData.levels.find(x=>Number(x.id)===Number(id));
      if(!found||!(found.state>0))throw Error('Requested level unavailable');
      menu.startLevel({data:found});return {id:found.id,filename:found.filename};
    },levelId);
    await page.waitForFunction(()=>__game.state.current==='level'&&__game.level?.levelStarted&&
      __game.level.pers1?.body&&__game.level.pers2?.body&&
      !__game.paused&&!__game.physics.box2d.paused&&!__game.state.fading,null,{timeout:45000});
    const roomEpoch=id();
    await page.evaluate(async({roomEpoch,sha})=>{
      const {installHtml5AuthorityInput}=await import('/adapters/fireboy-html5/authority-input.mjs');
      const {createSnapshotExporter}=await import('/adapters/fireboy-html5/state-snapshot.mjs');
      window.__html5RoomInput=installHtml5AuthorityInput(__game);
      window.__html5RoomSnapshot=createSnapshotExporter(__game,{
        sessionEpoch:roomEpoch,sourceGameSha256:sha,devices:window.Devices
      });
    },{roomEpoch,sha:host.sourceSha256});
    // Capture the full uncollected map before network input can remove any
    // diamond; its immutable spawn roster survives future collections.
    await page.evaluate(()=>{
      const baseline=window.__html5RoomSnapshot.capture();
      if(!baseline.coverage?.requiredPresent||baseline.diamondRoster.length<1)
        throw Error('Original level did not expose its initial diamond spawn roster');
    });
    await page.evaluate(()=>{
      if(!__game.paused)__game.level.togglePause();
      if(!__game.paused)throw Error('Waiting room did not pause');
    });
    const room=new Html5RoomCore({roomEpoch}),peers=new Map();
    let closed=false,failed=null,serial=Promise.resolve(),pendingTick=false,broadcastSeq=0;
    const send=(ws,obj)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));};
    const broadcast=obj=>{
      const payload=JSON.stringify(obj);
      for(const ws of peers.keys())if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<256*1024)ws.send(payload);
    };
    const notify=()=>broadcast({type:'room',room:room.publicState(),failure:failed?.message??null});
    function enqueue(work){
      const action=serial.then(async()=>{if(!closed&&!failed)return work();});
      serial=action.catch(error=>{
        failed=error;console.error('HTML5 research authority:',error.message);
        notify();broadcast({type:'error',code:'AUTHORITY_FAILED'});
      });
      return serial;
    }
    const enginePause=paused=>page.evaluate(value=>{
      if(!__game?.level?.togglePause)throw Error('Native pause handler missing');
      if(__game.paused!==value)__game.level.togglePause();
      if(__game.paused!==value)throw Error('Native pause handler failed');
    },paused);
    const syncPause=async()=>{await enginePause(room.effectivePaused);notify();};
    const inspectMechanisms=()=>page.evaluate(()=>{
      const game=window.__game,level=game?.level;
      const constructors=window.Devices??{};
      const kinds=['Pusher','Lever','Box','MovingPlatform','Beamer','LightPusher'];
      const sample=(entry,index)=>({
        index,id:entry?.id??null,type:entry?.type??null,
        x:entry?.x??null,y:entry?.y??null,
        group:entry?.properties?.group??null
      });
      return {
        levelId:level?.levelData?.id??null,
        runtime:(level?.objects??[]).map((object,index)=>{
          const options=object?.options??{};
          const recognized=kinds.filter(name=>typeof constructors[name]==='function'&&
            object instanceof constructors[name]);
          return {index,ownType:Object.hasOwn(options,'type'),
            optionsType:options.type??null,mapObjectId:options.id??null,
            x:options.x??null,y:options.y??null,
            group:options.properties?.group??null,recognized,
            bodyX:object?.body?.x??object?.button?.body?.x??null,
            bodyY:object?.body?.y??object?.button?.body?.y??null};
        }),
        authoredMapEntries:(level?.mapData?.objects?.Objects??[]).map(sample)
      };
    });
    const capture=()=>page.evaluate(()=>({
      snapshot:window.__html5RoomSnapshot.capture(),
      input:window.__html5RoomInput.inspect(),
      gamePaused:window.__game.paused,physicsPaused:window.__game.physics.box2d.paused
    }));
    const server=http.createServer((req,res)=>{
      const okay=req.url==='/health'&&['GET','HEAD'].includes(req.method);
      const body=JSON.stringify({researchOnly:true,gameAssetsHosted:false,noVideo:true,
        room:room.publicState(),gameSha256:host.sourceSha256,failed:!!failed});
      res.writeHead(okay?200:404,{'content-type':'application/json; charset=utf-8',
        'cache-control':'no-store','content-length':Buffer.byteLength(body)});
      res.end(req.method==='HEAD'?undefined:body);
    });
    const wss=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
    server.on('upgrade',(req,socket,head)=>{
      const h=req.headers.host;
      const valid=h==='127.0.0.1:'+server.address()?.port||h==='localhost:'+server.address()?.port;
      if(req.url!=='/ws'||!valid||(req.headers.origin&&req.headers.origin!=='http://'+h&&!viewerOrigins.has(req.headers.origin))||closed||failed){
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;
      }
      wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws));
    });
    wss.on('connection',ws=>{
      const memberId=id();let slot;
      try{slot=room.attach(memberId);}catch{send(ws,{type:'error',code:'ROOM_FULL'});ws.close();return;}
      peers.set(ws,{memberId,slot});
      send(ws,{type:'welcome',slot,room:room.publicState(),level,
        gameSha256:host.sourceSha256,originalPackageBaseline:false});
      notify();ws.on('error',()=>{});
      ws.on('close',()=>{
        const owner=peers.get(ws);if(!owner)return;
        peers.delete(ws);room.detach(memberId);
        void enqueue(async()=>{
          await page.evaluate(seat=>{
            window.__html5RoomInput.resetSlot(seat,{newEpoch:true});
            window.__html5RoomInput.resetAll();
          },owner.slot);
          await syncPause();
        });
      });
      ws.on('message',(buffer,isBinary)=>{
        const reject=code=>send(ws,{type:'error',code});
        if(isBinary)return reject('JSON_ONLY');
        let msg;try{msg=JSON.parse(buffer.toString());}catch{return reject('BAD_JSON');}
        if(!msg||typeof msg!=='object'||Array.isArray(msg))return reject('BAD_MESSAGE');
        if(msg.type==='input'){
          const result=room.receiveInput(memberId,msg);
          if(!result.accepted)reject(result.code);
        }else if(msg.type==='ready'){
          room.markReady(memberId);void enqueue(syncPause);
        }else if(msg.type==='room-command'){
          void enqueue(async()=>{
            const proposal=room.proposePause(memberId,msg);
            if(!proposal.accepted)return reject(proposal.code);
            if(!proposal.replayed){
              await enginePause(proposal.desiredPaused);room.commitPause(proposal);
              if(proposal.changed)await page.evaluate(()=>window.__html5RoomInput.resetAll());
            }
            send(ws,{type:'pause-receipt',...room.proposePause(memberId,msg)});
            notify();
          });
        }else if(msg.type==='ping')send(ws,{type:'pong',id:msg.id});
        else if(msg.type==='leave')ws.close();
        else reject('UNKNOWN_MESSAGE');
      });
    });
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});
    });
    const timer=setInterval(()=>{
      if(closed||failed||!room.running||pendingTick)return;
      pendingTick=true;
      void enqueue(async()=>{
        const sampled=room.sample(Date.now());
        await page.evaluate(({inputs,resets})=>{
          for(const seat of resets)window.__html5RoomInput.resetSlot(seat);
          inputs.forEach((input,slot)=>{if(input.seq>=0)window.__html5RoomInput.accept(slot,input);});
        },sampled);
        const state=await capture();
        broadcast({type:'state',roomEpoch,broadcastSeq:++broadcastSeq,
          ...state,ack:state.input.slots.map(x=>x.ackSeq)});
      }).finally(()=>{pendingTick=false;});
    },40);timer.unref();
    let closing;
    return {
      url:'http://127.0.0.1:'+server.address().port,room,level,
      sourceSha256:host.sourceSha256,servedSha256:host.servedSha256,
      readAuthority:capture,inspectMechanisms,
      close(){
        closing??=(async()=>{
          closed=true;clearInterval(timer);
          for(const ws of peers.keys())ws.terminate();
          await serial.catch(()=>{});
          await new Promise(resolve=>wss.close(resolve));
          await new Promise(resolve=>server.close(resolve));
          await page.close().catch(()=>{});
          await browser.close().catch(()=>{});
          await host.close().catch(()=>{});
        })();return closing;
      }
    };
  }catch(error){
    await page?.close().catch(()=>{});
    await browser?.close().catch(()=>{});
    await host?.close().catch(()=>{});
    throw error;
  }
}
