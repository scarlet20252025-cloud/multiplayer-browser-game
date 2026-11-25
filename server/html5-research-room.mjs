/** Loopback-only research: two WebSockets, ONE HTML5/Box2D authority, no video. */
import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {chromium} from 'playwright';
import {WebSocket,WebSocketServer} from 'ws';
import {startHtml5ResearchHost} from '../scripts/html5-research-host.mjs';
import {Html5RoomCore} from './html5-room-core.mjs';
import {Html5SceneGuard} from './html5-scene-guard.mjs';
import {inspectNativeWin,nextForestLevel,nextTempleLevel} from './html5-level-progression.mjs';
const id=()=>randomBytes(16).toString('hex');
// 允许回环，以及 RFC1918 私网地址（局域网联机时需要）
const isLocalOrPrivateHost=name=>name==='127.0.0.1'||name==='localhost'||
  /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name)||
  /^192\.168\.\d{1,3}\.\d{1,3}$/.test(name)||
  /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(name);
export async function startHtml5ResearchRoom({root,script,requireScript,entryPath,levelId=1,port=0,publicPort=null,allowedViewerOrigins=[],templeId='forest',storagePrefix='fb-forest',gameId='forest',wsToken=null,bindHost='127.0.0.1',publicHost=null,seats=2}={}){
  if(!Number.isInteger(port)||port<0||port>65535)throw new RangeError('Invalid research port');
  if(publicPort!==null&&(!Number.isInteger(publicPort)||publicPort<1||publicPort>65535))
    throw new RangeError('Invalid public research port');
  if(typeof templeId!=='string'||!/^[a-z][a-z-]{1,31}$/.test(templeId))
    throw new TypeError('Invalid temple id');
  if(typeof storagePrefix!=='string'||!/^[a-z][a-z0-9-]{1,63}$/.test(storagePrefix))
    throw new TypeError('Invalid storage prefix');
  if(typeof gameId!=='string'||!/^[a-z][a-z-]{1,31}$/.test(gameId))
    throw new TypeError('Invalid game id');
  if(wsToken!==null&&(typeof wsToken!=='string'||!/^[a-f0-9]{16,128}$/.test(wsToken)))
    throw new TypeError('Invalid session token');
  const allowedPublicHost=typeof publicHost==='string'&&publicHost.trim()?publicHost.trim():null;
  if(!Array.isArray(allowedViewerOrigins)||allowedViewerOrigins.some(origin=>{
    try{const url=new URL(origin);
      return url.protocol!=='http:'||(!isLocalOrPrivateHost(url.hostname)&&url.hostname!==allowedPublicHost)||url.origin!==origin;}
    catch{return true;}
  }))throw new TypeError('Viewer origins must be explicit local, private-LAN or public HTTP origins');
  const viewerOrigins=new Set(allowedViewerOrigins);
  const bindAddress=['127.0.0.1','localhost','0.0.0.0','::'].includes(bindHost)||
    /^(?:\d{1,3}\.){3}\d{1,3}$/.test(bindHost)?bindHost:'127.0.0.1';
  const advertiseHost=typeof publicHost==='string'&&publicHost.trim()?publicHost.trim():bindAddress;
  let displayPort=publicPort;
  const allowedHostNames=new Set([advertiseHost,'127.0.0.1','localhost']);
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
    await page.addInitScript(prefix=>{
      localStorage.setItem(prefix+':unlock','1');
      localStorage.removeItem(prefix+':invulnerable');
    },storagePrefix);
    await page.goto(host.entryUrl,{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__game?.state?.current==='menu',null,{timeout:60000});
    await page.evaluate(templeId=>{
      const temple=__game.progress.get('temples').find(x=>x.id===templeId);
      if(!temple)throw Error('Temple missing: '+templeId);
      __game.state.states[__game.state.current].startTemple(temple);
    },templeId);
    await page.waitForFunction(()=>__game.state.current==='levelMenu'&&!__game.state.fading&&
      __game.state.states.levelMenu.buttons,null,{timeout:30000});
    let level=await page.evaluate(id=>{
      const menu=__game.state.states.levelMenu;
      const found=menu.templeData.levels.find(x=>Number(x.id)===Number(id));
      if(!found||!(found.state>0))throw Error('Requested level unavailable');
      menu.startLevel({data:found});return {id:Number(found.id),filename:found.filename};
    },levelId);
    await page.waitForFunction(()=>__game.state.current==='level'&&__game.level?.levelStarted&&
      __game.level.pers1?.body&&__game.level.pers2?.body&&
      !__game.paused&&!__game.physics.box2d.paused&&!__game.state.fading,null,{timeout:45000});
    // The authority browser is never shown. Rendering it at display rate
    // starves the CDP sampling calls that drive the room, dropping the
    // broadcast to a few Hz. Keep the native update/physics loop and skip
    // only painting; snapshots read game state directly.
    await page.evaluate(()=>{
      const renderer=__game.renderer;
      if(typeof renderer?.render!=='function')throw Error('Native renderer missing');
      renderer.render=()=>{};
    });
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
    const baseline=await page.evaluate(()=>{
      const snapshot=window.__html5RoomSnapshot.capture();
      if(snapshot.coverage?.playableCore!==true)
        throw Error('Original level did not expose a playable snapshot baseline');
      return snapshot;
    });
    let sceneGuard=new Html5SceneGuard(baseline);
    await page.evaluate(()=>{
      if(!__game.paused)__game.level.togglePause();
      if(!__game.paused)throw Error('Waiting room did not pause');
    });
    const room=new Html5RoomCore({roomEpoch,seats}),peers=new Map();
    let closed=false,failed=null,serial=Promise.resolve(),pendingTick=false,broadcastSeq=0;
    let lastWinSnapshot=null;
    const send=(ws,obj)=>{if(ws?.readyState===WebSocket.OPEN)ws.send(JSON.stringify(obj));};
    const broadcast=obj=>{
      const payload=JSON.stringify(obj);
      for(const ws of peers.keys())if(ws.readyState===WebSocket.OPEN&&ws.bufferedAmount<256*1024)ws.send(payload);
    };
    const notify=()=>broadcast({type:'room',room:room.publicState(),failure:failed?.message??null});
    function enqueue(work){
      const action=serial.then(async()=>{if(!closed&&!failed)return work();});
      serial=action.catch(error=>{
        // A duplicate restart request is a race, not a fatal authority state.
        // Latching failed here used to freeze the room and surface on the
        // client as WEBSOCKET_CLOSED after the lobby closed the authority.
        if(['ROUND_RESTART_NOT_APPROVED','ROUND_NOT_SUSPENDED','AUTO_RESTARTING'].includes(error.message)){
          console.warn('HTML5 research authority: ignored restart race:',error.message);
          notify();
          return;
        }
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
    // Native lifecycle discovery is read-only and never invokes a game handler.
    const inspectLifecycle=()=>page.evaluate(()=>{
      const game=window.__game,level=game?.level;
      const regex=/restart|reset|reload|menu|exit|end|finish|die|death|start|win|complete|lose|pause|return|retry/i;
      function methods(object){
        const output=new Set();
        let target=object;
        for(let depth=0;target&&depth<3;depth++,target=Object.getPrototypeOf(target)){
          for(const name of Object.getOwnPropertyNames(target)){
            if(name==='constructor'||!regex.test(name))continue;
            const descriptor=Object.getOwnPropertyDescriptor(target,name);
            if(descriptor && Object.hasOwn(descriptor,'value') &&
              typeof descriptor.value==='function')output.add(name);
          }
        }
        return [...output].sort().slice(0,100);
      }
      const snapshot=window.__html5RoomSnapshot?.capture();
      return {
        stateName:game?.state?.current??null,
        stateKeys:Object.keys(game?.state?.states??{}).slice(0,50),
        levelEpoch:snapshot?.levelEpoch??null,
        levelEnded:level?.ended??null,
        characters:[level?.pers1,level?.pers2].map(x=>({
          dead:x?.isDead??null,dying:x?.dying??null,x:x?.body?.x??null,y:x?.body?.y??null
        })),
        levelMethods:methods(level),
        levelStateMethods:methods(game?.state?.states?.level),
        gameStateMethods:methods(game?.state),
        levelObjectNames:Object.keys(level??{}).filter(x=>regex.test(x)).slice(0,100),
        doorFlags:[level?.door1,level?.door2].map(x=>({
          isOpen:x?.isOpen??null,isUp:x?.isUp??null,currentFrac:x?.currentFrac??null
        }))
      };
    });
    const capture=()=>page.evaluate(()=>{
      const snapshot=window.__html5RoomSnapshot.capture();
      let input;
      try{input=window.__html5RoomInput.inspect();}
      catch(error){
        // The existing input bridge is bound to the PREVIOUS level. Surface
        // its staleness so the server can halt before applying any old inputs.
        input={stale:true,reason:String(error.message),slots:[]};
      }
      return {snapshot,input,gamePaused:window.__game.paused,
        physicsPaused:window.__game.physics.box2d.paused};
    });
    // Research-only stimulus: invoke the game's own kill() handler so the
    // ordinary scene guard latches CHARACTER_DYING. It never writes isDead or
    // fabricates a snapshot; used to exercise the two-seat death vote locally.
    const invokeNativeDeathForResearch=()=>enqueue(async()=>{
      return page.evaluate(()=>{
        const character=window.__game?.level?.pers1;
        if(typeof character?.kill!=='function')throw Error('Native kill handler missing');
        character.kill.call(character);
        return {dying:character.dying===true};
      });
    });
    const invokeNativeRetryForResearch=()=>enqueue(async()=>{
      await page.evaluate(()=>{
        const level=window.__game?.level;
        if(typeof level?.retry!=='function')throw Error('Native retry handler missing');
        window.__researchPreviousNativeScene={
          level,root:level.root,fire:level.pers1,water:level.pers2
        };
        // Invoke the already-registered native game handler; never modify
        // position, collision, death flags, or game.js bytes in CI.
        level.retry.call(level);
      });
    });
    const observeNativeSceneForResearch=()=>page.evaluate(()=>{
      const previous=window.__researchPreviousNativeScene||window.__researchRestartOld;
      const level=window.__game?.level;
      const snapshot=window.__html5RoomSnapshot?.capture();
      let stale=false;
      try{window.__html5RoomInput.inspect();}catch{stale=true;}
      return {sceneName:window.__game?.state?.current??null,
        epoch:snapshot?.levelEpoch??null,
        levelChanged:previous?previous.level!==level:null,
        rootChanged:previous?previous.root!==level?.root:null,
        fireChanged:previous?previous.fire!==level?.pers1:null,
        waterChanged:previous?previous.water!==level?.pers2:null,
        inputStale:stale,levelStarted:level?.levelStarted??null,
        ended:level?.ended??null};
    });

    // Two-player vote is required even after a natural death. The old
    // native bridge must be detached before retry() creates a fresh Phaser
    // level. The room resumes only after both new viewers acknowledge the
    // same round and have installed their new frozen projections.
    let restartPromise=null;
    const restartNativeRound=async({auto=false}={})=>{
      if(restartPromise)return restartPromise;
      restartPromise=(async()=>{
      if(!auto&&!room.restartPending)throw Error('ROUND_RESTART_NOT_APPROVED');
      if(auto&&!room.suspendedReason)throw Error('ROUND_NOT_SUSPENDED');
      const priorEpoch=sceneGuard.levelEpoch;
      const action=room.roundAction;
      let advance=null;
      if(action==='advance'){
        if(room.suspendedReason!=='LEVEL_WON'||!lastWinSnapshot)
          throw Error('NATIVE_WIN_REQUIRED');
        const proof=inspectNativeWin(lastWinSnapshot);
        const nativeTemple=await page.evaluate(templeId=>{
          return window.__game.progress.get('temples').find(t=>t.id===templeId);
        },templeId);
        // The audited forest progression covers the standard 1..32 campaign.
        // Trial/bonus ids live outside it, so use the temple's own numeric
        // order there instead of failing a legitimate win.
        const standardForest=templeId==='forest'&&level.id>=1&&level.id<=32;
        advance=standardForest
          ?nextForestLevel({currentLevelId:level.id,temple:nativeTemple,proof})
          :nextTempleLevel({currentLevelId:level.id,temple:nativeTemple,proof,templeId});
        if(advance.complete||!advance.next)throw Error('LAST_STANDARD_LEVEL_COMPLETE');
      }
      await page.evaluate(({next,templeId})=>{
        const game=window.__game,old=game?.level;
        if(!next&&typeof old?.retry!=='function')throw Error('Original native retry missing');
        window.__researchRestartOld={level:old,root:old.root,
          fire:old.pers1,water:old.pers2};
        window.__html5RoomInput?.uninstall();
        if(next){
          const menu=game.state?.states?.levelMenu;
          const original=game.progress.get('temples').find(t=>t.id===templeId);
          const levelData=original?.levels?.find(l=>Number(l.id)===next.id);
          if(!menu||typeof menu.startLevel!=='function'||!levelData||
             levelData.filename!==next.filename)
            throw Error('Original native next level not available');
          menu.startLevel({data:levelData});
        }else old.retry.call(old);
      },{next:advance?.next??null,templeId});
      await page.waitForFunction(()=>{
        const old=window.__researchRestartOld,game=window.__game;
        return game?.state?.current==='level' && !game.state.fading &&
          game.level?.levelStarted && game.level?.pers1?.body &&
          game.level?.pers2?.body &&
          (game.level!==old.level||game.level.root!==old.root||
           game.level.pers1!==old.fire||game.level.pers2!==old.water);
      },null,{timeout:45000});
      const baseline=await page.evaluate(async()=>{
        const game=window.__game;
        const {installHtml5AuthorityInput}=await import(
          '/adapters/fireboy-html5/authority-input.mjs');
        window.__html5RoomInput=installHtml5AuthorityInput(game);
        const snapshot=window.__html5RoomSnapshot.capture();
        if(snapshot.coverage?.playableCore!==true ||
           !snapshot.characters.every(c=>Number.isFinite(c.position?.x)&&
             Number.isFinite(c.position?.y)))
          throw Error('Restart baseline missing real game entities');
        if(!game.paused)game.level.togglePause();
        if(!game.paused)throw Error('Restarted authority was not frozen');
        return snapshot;
      });
      if(baseline.levelEpoch<=priorEpoch)
        throw Error('Native retry did not advance level epoch');
      sceneGuard=new Html5SceneGuard(baseline);
      const roomState=room.beginNewRound({force:auto});
      if(advance?.next)level={id:advance.next.id,filename:advance.next.filename};
      lastWinSnapshot=null;
      broadcast({type:'round-reset',roomEpoch,
        roundNumber:roomState.roundNumber,levelEpoch:baseline.levelEpoch,
        gameSha256:host.sourceSha256,action,level,
        snapshot:baseline,room:roomState});
      notify();
      return roomState;
      })();
      try{return await restartPromise;}finally{restartPromise=null;}
    };
    const server=http.createServer((req,res)=>{
      const okay=req.url==='/health'&&['GET','HEAD'].includes(req.method);
      const body=JSON.stringify({researchOnly:true,gameAssetsHosted:false,noVideo:true,
        room:room.publicState(),gameId,templeId,gameSha256:host.sourceSha256,
        servedSha256:host.servedSha256,failed:!!failed});
      res.writeHead(okay?200:404,{'content-type':'application/json; charset=utf-8',
        'cache-control':'no-store','content-length':Buffer.byteLength(body)});
      res.end(req.method==='HEAD'?undefined:body);
    });
    const wss=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
    server.on('upgrade',(req,socket,head)=>{
      const h=req.headers.host;
      const hostName=String(h??'').replace(/:\d+$/,'');
      const valid=allowedHostNames.has(hostName)&&
        (String(h??'').endsWith(':'+server.address()?.port)||
         String(h??'').endsWith(':'+(displayPort??server.address()?.port)));
      let requestUrl=null,requestedSeat=null;
      try{requestUrl=new URL(req.url,'http://'+h);}catch{}
      const seatRaw=requestUrl?.searchParams.get('seat')??null;
      // Seat index is validated against the room's real capacity, not a
      // hardcoded 0/1 pair, so a 3/4-seat room accepts P3/P4 links too.
      if(seatRaw!==null&&/^\d{1,2}$/.test(seatRaw)){
        const parsed=Number(seatRaw);
        if(parsed>=0&&parsed<room.capacity)requestedSeat=parsed;
      }
      const tokenOkay=wsToken===null||requestUrl?.searchParams.get('token')===wsToken;
      if(!requestUrl||requestUrl.pathname!=='/ws'||!valid||!tokenOkay||
        (seatRaw!==null&&requestedSeat===null)||
        (req.headers.origin&&req.headers.origin!=='http://'+h&&!viewerOrigins.has(req.headers.origin))||
        closed||failed){
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;
      }
      wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,requestedSeat));
    });
    wss.on('connection',(ws,requestedSeat)=>{
      const memberId=id();let slot;
      try{slot=room.attach(memberId,requestedSeat);}catch{send(ws,{type:'error',code:'ROOM_FULL'});ws.close();return;}
      peers.set(ws,{memberId,slot});
      send(ws,{type:'welcome',slot,room:room.publicState(),level,
        gameId,templeId,gameSha256:host.sourceSha256,servedSha256:host.servedSha256,
        originalPackageBaseline:false});
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
          try{
            room.markReady(memberId,msg.roundNumber);
            void enqueue(syncPause);
          }catch(err){reject(err.message==='WRONG_ROUND'?'WRONG_ROUND':'ROOM_SUSPENDED');}
        }else if(msg.type==='room-command'){
          void enqueue(async()=>{
            if(['return.request','return.confirm','return.cancel'].includes(msg.command)){
              const result=room.voteReturn(memberId,msg);
              if(!result.accepted){reject(result.code);return;}
              send(ws,{type:'return-vote-receipt',...result});
              if(result.execute){
                await syncPause();
                broadcast({type:'return-to-lobby',roomEpoch,
                  roundNumber:room.roundNumber});
              }else notify();
              return;
            }
            if(msg.command==='round.restart.vote'||msg.command==='round.advance.vote'){
              const vote=room.voteRestart(memberId,msg);
              if(!vote.accepted){reject(vote.code);return;}
              send(ws,{type:'restart-vote-receipt',...vote});
              notify();
              if(vote.execute)await restartNativeRound();
              return;
            }
            const evaluator=msg.command==='pause.toggle'?
              room.proposePauseToggle.bind(room):room.proposePause.bind(room);
            const proposal=evaluator(memberId,msg);
            if(!proposal.accepted)return reject(proposal.code);
            if(!proposal.replayed){
              await enginePause(proposal.desiredPaused);room.commitPause(proposal);
              if(proposal.changed)await page.evaluate(()=>window.__html5RoomInput.resetAll());
            }
            send(ws,{type:'pause-receipt',...evaluator(memberId,msg)});
            notify();
          });
        }else if(msg.type==='ping')send(ws,{type:'pong',id:msg.id});
        else if(msg.type==='leave')ws.close();
        else reject('UNKNOWN_MESSAGE');
      });
    });
    await new Promise((resolve,reject)=>{
      server.once('error',reject);
      server.listen(port,bindAddress,()=>{server.off('error',reject);displayPort=publicPort??server.address().port;resolve();});
    });
    const evaluateBoundary=async state=>{
      const decision=sceneGuard.observe(state.snapshot);
      if(decision.status!=='suspended')return false;
      if(decision.reason==='LEVEL_WON'&&inspectNativeWin(state.snapshot).won)
        lastWinSnapshot=state.snapshot;
      room.suspend(decision.reason);
      notify();
      broadcast({type:'lifecycle',roomEpoch,reason:decision.reason,
        levelEpoch:state.snapshot?.levelEpoch??null,
        snapshotSeq:state.snapshot?.snapshotSeq??null,
        restartSupported:false});
      if(['CHARACTER_DYING','CHARACTER_DEAD'].includes(decision.reason))
        scheduleAutoRestart();
      // Fatal room state is latched. A future protocol revision must explicitly
      // reinstall native input and require new viewer baselines.
      return true;
    };
    let autoRestartTimer=null;
    const scheduleAutoRestart=()=>{
      if(closed||failed||autoRestartTimer)return;
      autoRestartTimer=setTimeout(()=>{
        autoRestartTimer=null;
        if(closed||failed||!room.suspendedReason)return;
        try{
          room.prepareAutoRestart('restart');
          void restartNativeRound({auto:true}).catch(error=>{
            failed=true;lastError=error.message;notify();
          });
        }catch(error){failed=true;lastError=error.message;notify();}
      },700);
      autoRestartTimer.unref?.();
    };
    const TICK_MS=32;
    let timer=null;
    const scheduleTick=()=>{
      if(closed)return;
      timer=setTimeout(runTick,TICK_MS);
      timer.unref?.();
    };
    const runTick=()=>{
      timer=null;
      if(closed||failed||!room.running||pendingTick)return scheduleTick();
      pendingTick=true;
      const startedAt=performance.now();
      void enqueue(async()=>{
        const t0=performance.now();
        const sampled=room.sample(Date.now());
        // Apply inputs and capture in one browser round-trip. Wait for the
        // next native frame so an acknowledged input was actually consumed
        // by the real update loop, then snapshot in the same evaluate.
        const result=await page.evaluate(async ({inputs,resets})=>{
          const appliedAt=performance.now();
          for(const seat of resets)window.__html5RoomInput.resetSlot(seat);
          inputs.forEach((input,slot)=>{if(input.seq>=0)window.__html5RoomInput.accept(slot,input);});
          if(typeof requestAnimationFrame==='function')
            await new Promise(resolve=>requestAnimationFrame(()=>resolve()));
          let input;
          try{input=window.__html5RoomInput.inspect();}
          catch(error){
            // The existing input bridge is bound to the PREVIOUS level. Surface
            // its staleness so the server can halt before applying any old inputs.
            input={stale:true,reason:String(error.message),slots:[]};
          }
          const snapshot=window.__html5RoomSnapshot.capture();
          return {applyMs:performance.now()-appliedAt,
            state:{snapshot,input,gamePaused:window.__game.paused,
              physicsPaused:window.__game.physics.box2d.paused}};
        },sampled);
        const t2=performance.now();
        // One post-input snapshot per tick is the room's clock. If the native
        // scene turned terminal during this tick, latch it now and stop; the
        // next round still requires a fresh baseline and both ready votes.
        if(await evaluateBoundary(result.state))return;
        broadcast({type:'state',roomEpoch,broadcastSeq:++broadcastSeq,
          ...result.state,ack:result.state.input.slots.map(x=>x.ackSeq)});
        if(process.env.HTML5_ROOM_PROFILE)console.error('TICK '+JSON.stringify({
          applyInputs:+result.applyMs.toFixed(1),capture:+(t2-t0).toFixed(1),
          total:+(performance.now()-t0).toFixed(1)}));
      }).finally(()=>{
        pendingTick=false;
        const elapsed=performance.now()-startedAt;
        if(closed)return;
        timer=setTimeout(runTick,Math.max(0,TICK_MS-elapsed));
        timer.unref?.();
      });
    };
    scheduleTick();
    let closing;
    return {
      url:'http://'+advertiseHost+':'+displayPort,
      localUrl:`http://${bindAddress==='0.0.0.0'||bindAddress==='::'?'127.0.0.1':bindAddress}:${server.address().port}`,
      room,level,
      sourceSha256:host.sourceSha256,servedSha256:host.servedSha256,
      readAuthority:capture,inspectMechanisms,inspectLifecycle,
      invokeNativeRetryForResearch,invokeNativeDeathForResearch,observeNativeSceneForResearch,
      close(){
        closing??=(async()=>{
          closed=true;if(timer)clearTimeout(timer);
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
