import {createHash} from 'node:crypto';
import {readFile, readdir, writeFile} from 'node:fs/promises';
import path from 'node:path';

const input = process.argv[2];
if (!input) throw Error('Usage: node scripts/prepare-bvn33-sidecar.mjs <BVN Online directory>');
const root = path.resolve(input);
const hash = createHash('sha256').update(await readFile(path.join(root, 'game/bvn33-net.swf'))).digest('hex');
if (hash !== 'f60f8ea05c71fd31e896334c9b34f45d2863cb1e0d2e875d0cf977c1e625815c')
  throw Error('BVN 3.3 network build SHA-256 does not match the pinned upstream release');
const gamePath = `/game/net.swf?v=${hash}`;
const ruffleRoot = path.join(root, 'node_modules/@ruffle-rs/ruffle');
const ruffleFiles = (await readdir(ruffleRoot)).filter(file => /\.(js|wasm)$/.test(file)).sort();
if (!ruffleFiles.includes('ruffle.js') || !ruffleFiles.some(file => file.endsWith('.wasm')))
  throw Error('The pinned Ruffle player is missing; install the sidecar dependencies before preparation');
const ruffleHash = createHash('sha256');
for (const file of ruffleFiles) {
  const contents = await readFile(path.join(ruffleRoot, file));
  ruffleHash.update(`${file}\0${contents.length}\0`).update(contents);
}
const rufflePath = `/ruffle/${ruffleHash.digest('hex').slice(0, 24)}/`;

// Integrate the c7da486 BVN Online application without its media transport.
// Apply only to the private upstream checkout. Gameplay and frame handling stay upstream.
const changes = new Map();
async function edit(file, transform) {
  const target = path.join(root, file);
  const source = changes.get(target) ?? await readFile(target, 'utf8');
  const next = transform(source.replace(/\r\n/g, '\n'));
  changes.set(target, next);
}
function replace(source, before, after) {
  if (!source.includes(before)) throw Error('Unsupported BVN upstream source: ' + before.slice(0, 80));
  return source.replaceAll(before, after);
}

await edit('net-server.mjs', source => {
  if (source.includes("spectatorMode:'disabled'") || source.includes("spectatorMode:'lobby-lockstep'")) return source;
  source = replace(source, "import {installLiveMedia} from './lib/live-media.mjs';\n", '');
  const mediaBlock = /const liveMedia=installLiveMedia\(server,\{[\s\S]+?\n\}\}\);\n(?=server\.on\('upgrade')/;
  if (!mediaBlock.test(source)) throw Error('BVN media registration not found');
  source = source.replace(mediaBlock, '').replace(/liveMedia\.\w+\([^;]*?\);/g, '');
  source = replace(source, "spectatorMode:'live-video'", "spectatorMode:'disabled'");
  source = replace(source, 'if(!allow(req.socket.remoteAddress))',
    "if(u.pathname!=='/api/lobby-status'&&!allow(req.socket.remoteAddress))");
  source = replace(source, "      if(u.pathname==='/api/create') {", `      if(u.pathname==='/api/lobby-status'||u.pathname==='/api/lobby-close'){
        const r=rooms.get(String(data.code||''));
        if(!r||!safeEqual(data.token,r.tokens.get(1)))return json(res,404,{error:'对战已结束'});
        if(u.pathname==='/api/lobby-close'){closeRoom(r);return json(res,200,{ok:true});}
        return json(res,200,{state:r.state,players:[1,2].map(slot=>r.sockets.has(slot))});
      }
      if(u.pathname==='/api/watch')return json(res,404,{error:'观战未开放'});
      if(u.pathname==='/api/create') {`);
  source = replace(source, "  if(new URL(req.url,'http://localhost').pathname!=='/socket')return;",
    "  if(new URL(req.url,'http://localhost').pathname!=='/socket'){socket.destroy();return;}");
  source = replace(source, 'if(!sameOrigin(req)||u.pathname', 'if(watching||!sameOrigin(req)||u.pathname');
  return source;
});

await edit('public/net-index.html', source => {
  if (!source.includes('分享观战链接')) return source;
  return replace(replace(source, '<button value="watch">观看对局</button>', ''),
    '<button id="watch-link">分享观战链接</button>', '');
});
await edit('public/net-index.html', source => {
  if (source.includes('id="fight-emotes"')) return source;
  source = replace(source, '<div id="loading"',
    '<div id="fight-emotes" aria-hidden="true"><div id="fight-emote-p1"></div><div id="fight-emote-p2"></div></div><div id="loading"');
  return replace(source, '<div id="keys" class="keys"><p>WASD 移动</p><p>J 攻击 / 确认<br>K 跳跃 · L 冲刺<br>U 远攻 · I 必杀<br>O 援助</p>',
    `<div id="keys" class="keys" aria-labelledby="keys-title"><h2 id="keys-title">键位提示</h2><div class="key-grid">
<span><kbd>W A S D</kbd> 移动</span><span><kbd>J</kbd> 攻击 / 确认</span><span><kbd>K</kbd> 跳跃</span><span><kbd>L</kbd> 冲刺</span>
<span><kbd>U</kbd> 远攻</span><span><kbd>I</kbd> 必杀</span><span><kbd>O</kbd> 援助</span><span><kbd>Esc</kbd> 取消</span></div>`);
});
await edit('public/net-index.html', source => source.replace('<script src="/live-capture.js"></script>', ''));
// 加载条换成缤纷嘉年华星星组件：原版页面只有一条 <progress>，没有读数。
// 这里只替换那段进度 UI，下载事件本身仍由上游 net-client.js 上报。
await edit('public/net-index.html', source => {
  if (source.includes('id="download-loader"')) return source;
  if (source.includes('id="download-percent"')) {
    // 旧版是我们自己插的大号百分比，先撤掉再换成组件挂载点。
    source = source.replace(
      /<span id="download-percent"[^>]*>.*?<\/span><progress id="download-progress" max="100" hidden><\/progress>/s,
      '<div id="download-loader"></div><progress id="download-progress" max="100" hidden></progress>',
    );
    return source;
  }
  return replace(source,
    '<progress id="download-progress" max="100" hidden></progress><span id="download-detail"',
    '<div id="download-loader"></div><progress id="download-progress" max="100" hidden></progress><span id="download-detail"');
});
await edit('public/net-index.html', source => {
  if (source.includes('/loader/loader.css')) return source;
  return replace(source, '</head>',
    '<link rel="stylesheet" href="/loader/loader.css">\n<link rel="stylesheet" href="/loader/carnival-loader.css">\n</head>');
});
await edit('public/net-client.js', source => {
  if (source.includes("downloadLoader")) return source;
  // 原版只写 <progress> 的值；现在同时驱动星星组件。
  source = replace(source,
    "$('download-progress').hidden=percent===undefined;$('reload-engine').hidden=true;if(percent!==undefined)$('download-progress').value=percent;}",
    "$('download-progress').hidden=percent===undefined;$('reload-engine').hidden=true;if(percent!==undefined){$('download-progress').value=percent;}window.bvnDownloadProgress?.(percent);}");
  return source;
});
await edit('public/net-client.js', source => {
  if (source.includes('bvnDownloadProgress=')) return source;
  const hook = `
// 下载进度接缤纷嘉年华星星组件（/loader/），拿不到挂载点就保持原 <progress>。
let downloadLoader=null,downloadPending=null,downloadShown=0,downloadTarget=0,downloadRaf=0,downloadFrom=0,downloadAt=0;
window.bvnDownloadProgress=function(percent){
  if(percent===undefined){downloadPending={phase:'running',stage:'download',title:'正在加载游戏资源',detail:'正在准备下载。',percent:null};}
  else{downloadTarget=Math.min(100,Math.max(downloadTarget,percent));downloadPending={phase:'running',stage:'download',title:'正在加载游戏资源',detail:'正在下载游戏资源。',percent:downloadTarget};}
  downloadLoader?.show(downloadPending);
};
import('/loader/carnival-loader.mjs').then(m=>m.createCarnivalLoader(document.getElementById('download-loader'),{layout:'inline',compact:true})).then(instance=>{
  downloadLoader=instance;
  if(downloadPending)instance.show(downloadPending);
}).catch(()=>{});
`;
  return source + hook;
});
await edit('public/net-engine.html', source => source.replace('<script src="/live-capture.js"></script>', ''));
await edit('public/net-engine.js', source => {
  if (!source.includes('bvnLiveCapture')) return source;
  return replace(replace(source,
    'window.bvnLiveCapture?.setSound(message.enabled);player.ruffle().volume=1;',
    'player.ruffle().volume=message.enabled?1:0;'),
  'player.ruffle().volume=1;window.bvnLiveCapture?.setSound(false);', 'player.ruffle().volume=0;');
});

await edit('public/net-client.js', source => {
  if (source.includes("fragment.get('seat')")) return source;
  source = replace(source, "import {createLiveWatch} from '/live-watch.js';\n", '');
  source = replace(source, 'const liveWatch=createLiveWatch({frame,game,loading,say,sendMain:send});\nwindow.bvnLiveDiagnostics=()=>liveWatch.diagnostics();\n', '');
  for (const statement of ['liveWatch.connect(s);', 'liveWatch.reset(generation);',
    'liveWatch.disconnect();', 'if(liveWatch.handle(event))return;', 'liveWatch.resumeAudio();',
    "liveWatch.setSound(sound).catch(()=>say('请再次点击声音按钮'));", "$('watch-link').onclick=()=>share(true);"])
    source = replace(source, statement, '');
  source = replace(source, "window.addEventListener('hashchange',()=>location.reload());", `
const seatTicket=fragment.get('seat');
const backKey='bvn-lobby-return:'+linkCode;
let lobbyBack=null;
try {
  const candidate=fragment.get('back')||sessionStorage.getItem(backKey);
  const back=new URL(candidate);
  if(['http:','https:'].includes(back.protocol)&&back.hostname===location.hostname&&
      back.pathname==='/'&&!back.username&&!back.password){
    lobbyBack=back.href;sessionStorage.setItem(backKey,lobbyBack);
    $('leave').textContent='返回联机大厅';
  }
}catch{}
window.addEventListener('hashchange',()=>location.reload());`);
  source = replace(source, 'location.href=location.pathname;', 'location.href=lobbyBack||location.pathname;');
  source = replace(source,
    "try{const saved=JSON.parse(sessionStorage.getItem('bvn-session-test2')||'null');",
    "try{const saved=JSON.parse(sessionStorage.getItem('bvn-session-test2')||'null');if(seatTicket){connect(await api('/api/join',{code:linkCode,token:seatTicket}));}else ");
  return source;
});

// A transport reconnect before the first barrier must not restart a cold download.
await edit('net-server.mjs', source => {
  if (source.includes("r.ready.delete(slot);}broadcast(r,status(r));armIdle(r);")) return source;
  source = replace(source,
    '  if(r.epoch>0||previous)reset(r);else {send(ws,resetMessage(r));broadcast(r,status(r));}',
    "  if(r.epoch>0)reset(r);else {r.state='loading';r.ready.delete(slot);send(ws,resetMessage(r));broadcast(r,status(r));}");
  return replace(source,
    "r.sockets.delete(slot);r.keys[slot-1]=0;r.state='disconnected';broadcast(r,status(r));armIdle(r);",
    "r.sockets.delete(slot);r.keys[slot-1]=0;if(r.epoch>0)r.state='disconnected';else{r.state='loading';r.ready.delete(slot);}broadcast(r,status(r));armIdle(r);");
});

await edit('public/net-client.js', source => {
  if (source.includes('let engineGeneration=null,engineStarted=false,coldReady=null;')) return source;
  source = replace(source, 'function waitingStatus(){', [
    'let engineGeneration=null,engineStarted=false,coldReady=null;',
    "function reconnectNotice(){if(engineGeneration!==null&&!engineStarted)$('connection').textContent='连接中断，正在重连…';",
    "  else loading('连接中断，正在重连…');}",
    'function waitingStatus(){',
  ].join('\n'));
  source = replace(source, "    if(m.type==='reset'){", [
    "    if(m.type==='reset'){",
    '      if(!watching()&&!engineStarted&&engineGeneration===m.generation){if(coldReady)send(coldReady);return;}',
    '      engineStarted=false;coldReady=null;',
  ].join('\n'));
  source = replace(source, 'if(!watching()){frame.src=', 'if(!watching()){engineGeneration=generation;frame.src=');
  source = replace(source,
    "    if(['resume','frame','frames','timeline'].includes(m.type))post(m);",
    "    if(m.type==='resume')engineStarted=true;\n    if(['resume','frame','frames','timeline'].includes(m.type))post(m);");
  source = replace(source, "else if(m.state==='disconnected'){", "else if(m.state==='disconnected'&&engineStarted){");
  source = replace(source,
    "    if(ws!==socket||closed)return;enginePhase='paused';$('members-title').textContent='连接已断开，正在更新成员';release();post({type:'pause'});",
    [
      '    if(ws!==socket||closed)return;',
      "    const terminalClose=event.code===1000||event.code===4000;$('members-title').textContent='连接已断开，正在更新成员';release();",
      "    if(engineStarted||terminalClose){enginePhase='paused';post({type:'pause'});}",
    ].join('\n'));
  source = replace(source, '    if(event.code===1000||event.code===4000){', '    if(terminalClose){');
  source = replace(source, "    loading('连接中断，正在重连…');retry=setTimeout", '    reconnectNotice();retry=setTimeout');
  return replace(source,
    "  if(['ready','resumed','loading','ack','error'].includes(m.type))send(m);",
    "  if(m.type==='ready'&&!engineStarted)coldReady=m;\n  if(['ready','resumed','loading','ack','error'].includes(m.type))send(m);");
});

// A dropped request for the player loader should not abort both seats' cold start.
await edit('public/net-engine.html', source => {
  if (source.includes('window.bvnRuffleReady')) return source;
  return replace(source, '<script src="/ruffle/ruffle.js"></script>', `<script>
window.bvnRuffleReady=new Promise((resolve,reject)=>{
  function load(attempt){
    const script=document.createElement('script');
    script.src='/ruffle/ruffle.js'+(attempt?'?retry='+attempt:'');
    script.onload=resolve;
    script.onerror=()=>{
      script.remove();
      if(attempt<3)setTimeout(()=>load(attempt+1),500*(attempt+1));
      else reject(Error('游戏引擎下载失败'));
    };
    document.head.appendChild(script);
  }
  load(0);
});
</script>`);
});

await edit('public/net-engine.js', source => {
  if (source.includes('await window.bvnRuffleReady;')) return source;
  return replace(source, 'try {\n  window.RufflePlayer.config=',
    'try {\n  await window.bvnRuffleReady;\n  window.RufflePlayer.config=');
});

await edit('net-server.mjs', source => {
  if (source.includes("spectatorMode:'lobby-lockstep'")) return source;
  source = "import {admitWatchSocket,attachWatchSocket,endWatchers,issueWatchTicket,relayWatchFrame,setCombatCheckpoint,sweepWatchers,watchable} from './lib/lobby-watch-only.mjs';\n" + source;
  source = replace(source, "spectatorMode:'disabled'", "spectatorMode:'lobby-lockstep'");
  source = replace(source, 'maxPayload:8192', 'maxPayload:40*1024');
  source = replace(source, "const files={", "const files={'/lobby-watch':'lobby-watch.html','/lobby-watch.js':'lobby-watch.js','/lobby-capture.js':'lobby-capture.js',");
  source = replace(source, "'/live-watch.js':'live-watch.js','/live-capture.js':'live-capture.js',", '');
  source = replace(source, 'rooms.delete(r.code);clearTimeout(r.idle);', "endWatchers(r,'room-closed');rooms.delete(r.code);clearTimeout(r.idle);");
  source = replace(source, 'function reset(r){r.bot?.brain.reset();', "function reset(r){endWatchers(r,'unavailable');r.liveCombat=false;r.bot?.brain.reset();");
  source = replace(source, "function fail(r,message){r.state='error';", "function fail(r,message){endWatchers(r,'unavailable');r.state='error';");
  source = replace(source, "u.pathname==='/api/lobby-status'||u.pathname==='/api/lobby-close'",
    "u.pathname==='/api/lobby-status'||u.pathname==='/api/lobby-close'||u.pathname==='/api/lobby-watch'");
  source = replace(source, '        return json(res,200,{state:r.state,players:[1,2].map(slot=>r.sockets.has(slot))});', [
    "        if(u.pathname==='/api/lobby-watch'){",
    "          if(!safeEqual(data.watchKey,r.watchKey))return json(res,404,{error:'对战已结束'});",
    "          let profile;try{profile=memberProfile(data.nickname);}catch(error){return json(res,400,{error:error.message});}",
    '          const {status,...body}=issueWatchTicket(r,profile,data.returnUrl);return json(res,status,body);',
    '        }',
    '        return json(res,200,{state:r.state,players:[1,2].map(slot=>r.sockets.has(slot)),watchable:watchable(r)});',
  ].join('\n'));
  source = replace(source, 'watchProfiles:new Map(),lastTimeline:0', "watchProfiles:new Map(),watchKey:crypto.randomBytes(24).toString('base64url'),lastTimeline:0");
  source = replace(source, 'return json(res,201,{code:r.code,token,slot:1,settings:r.settings,profile});',
    'return json(res,201,{code:r.code,token,slot:1,settings:r.settings,profile,watchKey:r.watchKey});');
  source = replace(source, 'watchEntry=watching&&r?.watchProfiles.get(watchToken);',
    'watchEntry=watching&&admitWatchSocket(r,watchToken);');
  source = replace(source, "if(watching||!sameOrigin(req)||u.pathname!=='/socket'||!r||slot===undefined||(watching&&!watchEntry?.ws&&r.watchers.size>=MAX_WATCHERS))",
    "if(!sameOrigin(req)||u.pathname!=='/socket'||!r||slot===undefined)");
  const oldWatcher = /  if\(slot===0\)\{[\s\S]*?\n  \}\n(?=  clearTimeout\(r.idle\);)/;
  if (!oldWatcher.test(source)) throw Error('BVN legacy viewer handler not found');
  source = source.replace(oldWatcher, "  if(slot===0){attachWatchSocket(r,ws,watchEntry,{send,status:()=>status(r),update:()=>broadcast(r,status(r))});return;}\n");
  source = replace(source, '    if(binary||rooms.get(r.code)!==r||r.sockets.get(slot)!==ws)return;', [
    '    if(rooms.get(r.code)!==r||r.sockets.get(slot)!==ws)return;',
    '    if(binary){relayWatchFrame(r,ws,raw);return;}',
    "    if(raw.length>8192){ws.close(1009,'消息过大');return;}",
  ].join('\n'));
  source = replace(source, "fail(r,'两端对战状态不一致，请房主重新选人。');}r.checks.delete(m.n);",
    "fail(r,'两端对战状态不一致，请房主重新选人。');}else setCombatCheckpoint(r,m.state);r.checks.delete(m.n);");
  source = replace(source, "if(m.type==='loading'&&m.epoch===r.epoch){r.state='loading';",
    "if(m.type==='loading'&&m.epoch===r.epoch){endWatchers(r,'unavailable');r.liveCombat=false;r.state='loading';");
  source = replace(source, "  ws.on('close',()=>{if(rooms.get(r.code)!==r||r.sockets.get(slot)!==ws)return;r.sockets.delete(slot);",
    "  ws.on('close',code=>{if(rooms.get(r.code)!==r||r.sockets.get(slot)!==ws)return;endWatchers(r,code===1000?'player-left':'disconnected');r.liveCombat=false;r.sockets.delete(slot);");
  source = replace(source, 'server.listen(PORT,HOST,', "const watcherWatchdog=setInterval(()=>{for(const r of rooms.values())sweepWatchers(r);},250);watcherWatchdog.unref();\nserver.listen(PORT,HOST,");
  return replace(source, 'function stop(){clearInterval(ticker);', 'function stop(){clearInterval(watcherWatchdog);clearInterval(ticker);');
});

await edit('public/net-client.js', source => {
  if (source.includes('let watchCaptureActive=false;')) return source;
  source = replace(source, 'let engineGeneration=null,', 'let watchCaptureActive=false;\nlet engineGeneration=null,');
  source = replace(source, "    if(m.type==='reset'){", [
    "    if(m.type==='watch-capture'){if(s.slot===1&&m.generation===generation){watchCaptureActive=m.active===true;post(m);}return;}",
    "    if(m.type==='reset'){",
    '      watchCaptureActive=false;',
  ].join('\n'));
  source = replace(source, "    const terminalClose=event.code===1000||event.code===4000;",
    "    watchCaptureActive=false;post({type:'watch-capture',active:false,generation});\n    const terminalClose=event.code===1000||event.code===4000;");
  return replace(source, '  const m=event.data;', [
    '  const m=event.data;',
    "  if(m.type==='watch-capture-frame'){",
    '    if(watchCaptureActive&&session?.slot===1&&m.bytes instanceof ArrayBuffer&&m.bytes.byteLength<=32*1024&&',
    '        ws?.readyState===WebSocket.OPEN&&ws.bufferedAmount<64*1024)ws.send(m.bytes);',
    '    return;',
    '  }',
  ].join('\n'));
});

await edit('public/net-engine.js', source => {
  if (source.includes("from './lobby-capture.js'") || source.includes("from '/lobby-capture.js'")) return source;
  source = "import {captureGameFrame} from '/lobby-capture.js';\n" + source;
  return replace(source, "invoke('netInput',keys[0],botMask);netClock.tick(fps);",
    "invoke('netInput',keys[0],botMask);netClock.tick(fps);captureGameFrame();");
});

await edit('public/net-index.html', source => source.replace(/(src|href)="\/(client\.js|style\.css)"/g, '$1="./$2"'));

await edit('public/net-engine.html', source => {
  const loader = /script\.src='\.?\/ruffle\/(?:[a-f0-9]{24}\/)?ruffle\.js'/;
  if (!loader.test(source)) throw Error('BVN Ruffle loader not found');
  return source.replace(loader, `script.src='.${rufflePath}ruffle.js'`)
    .replace(/src="\/(net-download\.js|net-clock\.js|net-engine\.js)"/g, 'src="./$1"');
});

await edit('public/net-engine.js', source => {
  const game = /load\(\{url:'\.?\/game\/(?:[a-f0-9]{64}\/)?net\.swf(?:\?v=[a-f0-9]{64})?'/;
  if (!game.test(source)) throw Error('BVN game loader not found');
  return source.replace(game, `load({url:'.${gamePath}'`)
    .replace(/from '\/(lobby-capture\.js|net-bot-policy\.js)'/g, "from './$1'");
});

await edit('public/net-emotes.js', source => source.replace("fetch('/api/emotes')", "fetch('./api/emotes')")
  .replaceAll('.src=emote.image', ".src='.'+emote.image"));
await edit('public/net-emotes.js', source => {
  if (source.includes('export function showFightEmote')) return source;
  if (source.includes('const fightEmote=')) {
    source = replace(source, `    const corner=member.role==='host'?$('fight-emote-p1'):member.role==='player'?$('fight-emote-p2'):null;
    const fightEmote=corner?image(emote,'fight-emote emote-'+emote.id):null;
    if(fightEmote){fightEmote.alt='';corner.replaceChildren(fightEmote);}`, '    const fightEmote=showFightEmote(emote,member.role);');
  } else {
    source = replace(source, "    document.querySelectorAll('.member-emote').forEach(node=>node.remove());",
      "    document.querySelectorAll('.member-emote,.fight-emote').forEach(node=>node.remove());");
    source = replace(source, 'clearTimeout(entry.timer);entry.node.remove();active.delete(id);',
      'clearTimeout(entry.timer);entry.node.remove();entry.fightEmote?.remove();active.delete(id);');
    source = replace(source, '    const entry={node,member,emote,timer:null};active.set(member.id,entry);',
      `    const fightEmote=showFightEmote(emote,member.role);
    const entry={node,fightEmote,timer:null};active.set(member.id,entry);`);
  }
  source = replace(source, `  const ready=fetch('./api/emotes').then(async response=>{
    if(!response.ok)throw Error('表情加载失败');
    const data=await response.json();
    if(!Array.isArray(data.emotes)||data.emotes.length>8)throw Error('表情配置不正确');
    for(const emote of data.emotes) {`, `  const ready=loadEmoteCatalog().then(emotes=>{
    for(const emote of emotes) {`);
  source = source.replace(/      if\(!\/\^\[a-z\]\+\$\/\.test\(emote\.id\).*?continue;\n/, '');
  return `export async function loadEmoteCatalog(){
  const response=await fetch(new URL('./api/emotes',import.meta.url));
  if(!response.ok)throw Error('表情加载失败');
  const data=await response.json();
  if(!Array.isArray(data.emotes)||data.emotes.length>8)throw Error('表情配置不正确');
  return data.emotes.filter(emote=>emote&&/^[a-z]+$/.test(emote.id)&&
    /^\\/emotes\\/[a-z]+\\.(gif|png)$/.test(emote.image)&&typeof emote.label==='string'&&/^[0-9]$/.test(emote.key));
}
export function showFightEmote(emote,role){
  const slot=role==='host'?'p1':role==='player'?'p2':null;
  const corner=slot&&document.getElementById('fight-emote-'+slot);
  if(!corner)return null;
  const image=document.createElement('img');
  image.className='fight-emote emote-'+emote.id;
  image.src=new URL('.'+emote.image,import.meta.url).href;
  image.alt='';image.draggable=false;
  corner.replaceChildren(image);
  return image;
}
\n`+source;
});

await edit('public/net-client.js', source => {
  const transport = `async function api(url,data){
  const response=await fetch('.'+url,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(data),signal:AbortSignal.timeout(4500)});
  const result=await response.json().catch(()=>null);
  if(response.ok&&result&&typeof result==='object')return result;
  const error=Error(result?.error||'连接暂时不可用');
  error.status=response.ok?502:response.status;
  error.invalidSeat=(response.status===404&&result?.error==='房间不存在或已结束')||
    (response.status===409&&result?.error==='房间已满');
  throw error;
}
function readStoredSeat(){
  try{return JSON.parse(sessionStorage.getItem('bvn-session-test2')||'null');}catch{return null;}
}
function rememberSeat(credential){
  try{sessionStorage.setItem('bvn-session-test2',JSON.stringify(credential));return true;}catch{return false;}
}
function forgetSeat(credential){
  const saved=readStoredSeat();
  if(saved&&saved.code===credential.code&&saved.token===credential.token)sessionStorage.removeItem('bvn-session-test2');
}
function temporaryJoinError(error){
  return error.status===undefined||error.status===408||error.status===429||error.status>=500;
}
const joinBackoff=[600,1200,2400];
async function restoreSeat(credential,onRetry){
  if(typeof credential.code!=='string'||typeof credential.token!=='string'||!credential.token)
    throw Object.assign(Error('原席位凭证已失效'),{status:403,invalidSeat:true});
  const route=credential.role==='watch'?'/api/watch':'/api/join';
  for(let attempt=0;;attempt++){
    try{
      const joined=await api(route,credential);
      if(typeof joined.token!=='string'||typeof joined.code!=='string'||!Number.isInteger(joined.slot))
        throw Object.assign(Error('联机服务未返回有效席位'),{status:502});
      if(joined.token!==credential.token||joined.code!==credential.code.toUpperCase()||
        (credential.slot!==undefined&&joined.slot!==credential.slot))
        throw Object.assign(Error('原席位凭证已失效'),{status:403,invalidSeat:true});
      return joined;
    }catch(error){
      if(!temporaryJoinError(error)||attempt>=joinBackoff.length)throw error;
      onRetry();
      await new Promise(resolve=>setTimeout(resolve,joinBackoff[attempt]));
    }
  }
}`;
  const api = /^async function api\(url,data\)\{[\s\S]*?(?=\nfunction mask\()/m;
  if (!api.test(source)) throw Error('BVN player API client not found');
  const prepared = source.includes('async function restoreSeat(');
  source = source.replace(api, transport);
  if (prepared) return source;
  source = source.replace(/from '\/(emotes\.js|bot\.js)'/g, "from './$1'");
  source = source.replace("if(seatTicket)history.replaceState(null,'',location.pathname+'#room='+encodeURIComponent(linkCode));\n", '');
  source = replace(source, 'frame.src=`/net-engine.html?', 'frame.src=`./net-engine.html?');
  source = replace(source, '`${location.origin}/#${watch?', '`${location.origin}${location.pathname}#${watch?');
  const reconnect = /^async function reconnect\(s,attempt=0\)\{[\s\S]*?\n\}(?=\nfunction connect\(s\))/m;
  if (!reconnect.test(source)) throw Error('BVN player reconnect handler not found');
  source = source.replace(reconnect, `async function reconnect(s){
  if(closed||session!==s)return;
  try{
    const joined=await restoreSeat(s,reconnectNotice);
    if(!closed&&session===s)connect(joined);
  }catch(error){
    if(closed||session!==s)return;
    if(error.invalidSeat)forgetSeat(s);
    engineError(temporaryJoinError(error)?'连接暂时不可用，重新加载可使用原席位重试。':error.message);
  }
}`);
  source = replace(source, "clearTimeout(retry);sessionStorage.setItem('bvn-session-test2',JSON.stringify(s));",
    'clearTimeout(retry);const stored=rememberSeat(s);');
  source = replace(source, "  history.replaceState(null,'',`${location.pathname}#${watching()?'watch':'room'}=${s.code}`);",
    "  if(stored||!seatTicket)history.replaceState(null,'',`${location.pathname}#${watching()?'watch':'room'}=${s.code}`);");
  const socket = /^  const socket=new WebSocket\(.*;ws=socket;$/m;
  if (!socket.test(source)) throw Error('BVN player socket creation not found');
  source = source.replace(socket, `  const endpoint=new URL('./socket',location.href);
  endpoint.protocol=location.protocol==='https:'?'wss:':'ws:';
  endpoint.search=new URLSearchParams({room:s.code,token:s.token,...(watching()?{role:'watch'}:{})});
  const socket=new WebSocket(endpoint);ws=socket;`);
  const bootstrap = /^try\{const saved=JSON\.parse\(sessionStorage\.getItem\('bvn-session-test2'\).*$/m;
  if (!bootstrap.test(source)) throw Error('BVN player session bootstrap not found');
  return source.replace(bootstrap, `const saved=readStoredSeat();
const restore=seatTicket?{code:linkCode,token:seatTicket}:
  saved&&(!linkCode||linkCode===saved.code)&&(!fragment.has('watch')||saved.role==='watch')?saved:null;
try{
  if(restore){
    const joined=await restoreSeat(restore,()=>{if(!session)say('连接暂时不可用，正在使用原席位重试…');});
    if(!session)connect(joined);
  }else if(fragment.has('watch'))connect(await api('/api/watch',{code:linkCode,nickname:$('nickname').value}));
}catch(error){
  if(!session){
    if(restore&&error.invalidSeat){
      forgetSeat(restore);
      if(seatTicket)history.replaceState(null,'',location.pathname+'#room='+encodeURIComponent(linkCode));
    }
    say(restore&&temporaryJoinError(error)?'暂时无法连接，刷新此页可使用原席位重试。':error.message);
  }
}`);
});

await edit('public/net-client.js', source => {
  if (source.includes('let gameAssetCached=false;')) return source;
  source = replace(source, 'function waitingStatus(){', 'let gameAssetCached=false;\nfunction waitingStatus(){');
  source = replace(source, "enginePhase='downloading';initStarted=0;",
    "enginePhase='downloading';initStarted=0;gameAssetCached=false;");
  source = replace(source, "loading('准备下载游戏资源…',0);", "loading('正在启动游戏运行环境…');");
  source = replace(source, '`游戏资源下载完成 · 初始化已用 ${seconds} 秒`',
    "`${gameAssetCached?'已复用本地游戏资源':'游戏资源下载完成'} · 初始化已用 ${seconds} 秒`");
  return replace(source, "    if(m.complete&&m.name==='游戏资源'){enginePhase='initializing';initStarted=performance.now();loading('下载完成，正在初始化游戏…',undefined,'游戏资源下载完成');}", [
    "    if(m.complete&&m.name==='游戏资源'){",
    "      enginePhase='initializing';initStarted=performance.now();gameAssetCached=m.cached===true;",
    "      loading(gameAssetCached?'正在使用本地缓存启动…':'下载完成，正在初始化游戏…',undefined,",
    "        gameAssetCached?'已复用本地游戏资源':'游戏资源下载完成');",
    '    }',
  ].join('\n'));
});

await edit('net-server.mjs', source => {
  source = source.replace("    if(req.method!=='GET')return", "    if(req.method!=='GET'&&req.method!=='HEAD')return");
  const start = source.search(/^    let file(?:,validator)?;$/m);
  const end = source.indexOf('\n  } catch(e) {if(!res.headersSent)', start);
  if (start === -1 || end === -1) throw Error('BVN static file handler not found');
  const gameValidator = JSON.stringify(hash);
  return source.slice(0, start) + `    let file,validator;
    const immutableGame=u.pathname+u.search===${JSON.stringify(gamePath)};
    const immutableRuffle=u.pathname.startsWith(${JSON.stringify(rufflePath)});
    const ruffleFile=immutableRuffle?u.pathname.slice(${rufflePath.length}):u.pathname.startsWith('/ruffle/')?u.pathname.slice(8):'';
    const immutable=immutableGame||immutableRuffle;
    let cacheControl='no-store';
    if(u.pathname==='/game/net.swf') {
      file=path.join(ROOT,'game/bvn33-net.swf');
      validator=${gameValidator};
      cacheControl=immutable?'public, max-age=31536000, immutable':'no-cache';
    } else if(/^[\\w.-]+\\.(js|wasm)$/.test(ruffleFile)) {
      file=path.join(ROOT,'node_modules/@ruffle-rs/ruffle',ruffleFile);
      if(immutable)validator='${rufflePath.split('/')[2]}-'+ruffleFile;
      cacheControl=immutable?'public, max-age=31536000, immutable':'no-cache';
    } else if(Object.hasOwn(files,u.pathname))file=path.join(ROOT,'public',files[u.pathname]);
    else return json(res,404,{error:'Not found'});
    let stat=await fsp.stat(file);
    const originalSize=stat.size;
    const contentType=mime[path.extname(file)]||'application/octet-stream';
    const gzip=/(?:^|,)\\s*gzip\\s*(?:,|$)/i.test(req.headers['accept-encoding']||'')&&/\\.(wasm|swf)$/.test(file);
    res.setHeader('Vary','Accept-Encoding');
    if(gzip){file=await compressedAsset(file,stat,path.join(ROOT,'runtime','gzip'));stat=await fsp.stat(file);res.setHeader('Content-Encoding','gzip');res.setHeader('X-Uncompressed-Length',originalSize);}
    res.setHeader('Cache-Control',cacheControl);
    if(cacheControl!=='no-store') {
      const etag=(validator?'W/':'')+'"'+(gzip?'gz-':'')+(validator??stat.size+'-'+stat.mtimeMs)+'"';
      res.setHeader('ETag',etag);
      const tags=String(req.headers['if-none-match']||'').split(',').map(value=>value.trim().replace(/^W\\//,''));
      if(tags.includes('*')||tags.includes(etag.replace(/^W\\//,''))){res.writeHead(304);return res.end();}
    }
    res.writeHead(200,{'Content-Type':contentType,'Content-Length':stat.size});
    if(req.method==='HEAD')return res.end();
    const stream=fs.createReadStream(file);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);` + source.slice(end);
});

await edit('net-server.mjs', source => {
  if (source.includes('from \'./lib/lobby-frame-window.mjs\'')) return source;
  source = "import {attachFramePeer,frameWindowBlocked,probeFramePeer} from './lib/lobby-frame-window.mjs';\n" + source;
  source = replace(source, '  r.sockets.set(slot,ws);ws.isAlive=true;',
    "  r.sockets.set(slot,ws);ws.isAlive=true;\n  attachFramePeer(ws,ms=>send(ws,{type:'transport-rtt',ms}));");
  source = replace(source, 'r.lastTimeline=performance.now();for(const ws of r.watchers.keys())',
    'r.lastTimeline=performance.now();for(const peer of r.sockets.values())probeFramePeer(peer,r.lastTimeline);for(const ws of r.watchers.keys())');
  return replace(source, 'if(r.n-Math.min(...r.acks)>=8){r.nextTick=now;continue;}',
    'if(frameWindowBlocked(r)){r.nextTick=now;continue;}');
});

await edit('public/net-client.js', source => {
  if (source.includes('let transportAt=-Infinity')) return source;
  source = replace(source, '  const socket=new WebSocket(endpoint);ws=socket;', `  const socket=new WebSocket(endpoint);ws=socket;
  let transportAt=-Infinity,transportRtt,appRtt;
  function updateConnection(){
    const native=performance.now()-transportAt<4500;
    const latency=native?transportRtt:appRtt;
    const node=$('connection');
    const label=roomStatus?.players.every(p=>p.connected)?'两人已连接':'等待另一位玩家';
    node.textContent=latency===undefined?label:label+' · '+latency+' ms';
    node.title=latency===undefined?'':native?'WebSocket 往返延迟':'应用往返延迟（估算）';
  }`);
  source = replace(source,
    "roomStatus=m;$('connection').textContent=m.players.every(p=>p.connected)?'两人已连接':'等待另一位玩家';",
    'roomStatus=m;updateConnection();');
  return replace(source, "    if(m.type==='pong')$('connection').textContent=`${roomStatus?.players.every(p=>p.connected)?'已连接':'等待玩家'} · ${Math.round(performance.now()-m.sent)} ms`;",
    "    if(m.type==='transport-rtt'&&Number.isFinite(m.ms)){transportRtt=m.ms;transportAt=performance.now();updateConnection();}\n    if(m.type==='pong'&&Number.isFinite(m.sent)){appRtt=Math.max(0,Math.round(performance.now()-m.sent));updateConnection();}");
});

const startup = await readFile(new URL('./bvn33-player-bootstrap.js', import.meta.url), 'utf8');
const startupStyle = `<style id="bvn-launch-style">
.bvn-managed #lobby,#bvn-launch[hidden],#bvn-launch-retry[hidden]{display:none!important}
#bvn-launch{min-height:100vh;min-height:100dvh;display:grid;place-items:center;box-sizing:border-box;padding:20px;background:linear-gradient(155deg,#b9e8ff,#e0f0ff 43%,#eee5ff);color:#20215c;font:16px "Microsoft YaHei UI",system-ui,sans-serif}
#bvn-launch div{width:min(100%,400px);box-sizing:border-box;padding:24px;border:2px solid #e5dbfe;border-radius:24px;background:#fff;box-shadow:0 6px 0 #a393d14d}
#bvn-launch h1{margin:0 0 9px;font-size:25px}#bvn-launch p{min-height:42px;margin:0;color:#5d5a83;line-height:1.5}
#bvn-launch button,#bvn-launch a{display:inline-grid;place-items:center;box-sizing:border-box;min-height:42px;margin:6px 7px 0 0;padding:6px 10px;color:#5f2cc4;background:#f3edff;border:1px solid #ddd0fe;border-radius:11px;font:700 14px system-ui,sans-serif;text-decoration:none;cursor:pointer}
#bvn-launch button{color:#fff;background:#6731d4;border-color:#6731d4}
</style>`;
await edit('public/net-index.html', source => {
  source = source.replace('<h1>死神<br>vs 火影</h1>', '<h1>死神 vs 火影</h1>');
  if (source.includes('id="bvn-launch-style"'))
    return source.replace(/<style id="bvn-launch-style">[\s\S]*?<\/style>/, startupStyle);
  source = replace(source, '<link rel="stylesheet" href="./style.css">', `${startupStyle}<script>${startup}</script>`);
  source = replace(source, '<body>', `<body>
<main id="bvn-launch" hidden><div><h1>死神 vs 火影</h1><p id="bvn-launch-status" role="status">正在连接双人对战…</p><button id="bvn-launch-retry" hidden type="button">重新加载</button><a id="bvn-launch-return" href="/">返回大厅</a></div></main>`);
  return replace(source, '<script type="module" src="./client.js"></script>', '');
});

await edit('public/net-client.js', source => {
  if (source.includes('const moduleSearch=new URL(import.meta.url).search;')) return source;
  source = replace(source, "import {createEmotes} from './emotes.js';\nimport {createBotPanel} from './bot.js';", `const moduleSearch=new URL(import.meta.url).search;
const [{createEmotes},{createBotPanel}]=await Promise.all([
  import('./emotes.js'+moduleSearch),import('./bot.js'+moduleSearch),
]);
const lobbyBoot=window.bvnLobbyBoot;
if(lobbyBoot&&!lobbyBoot.moduleReady(moduleSearch))throw Error('联机组件加载已超时');`);
  source = replace(source, "  $('lobby').hidden=true;$('arena').hidden=false;", "  $('lobby').hidden=true;$('arena').hidden=false;lobbyBoot?.connected();");
  source = replace(source, "const joined=await restoreSeat(restore,()=>{if(!session)say('连接暂时不可用，正在使用原席位重试…');});", `const joined=await restoreSeat(restore,()=>{
      if(!session){
        const notice='连接暂时不可用，正在使用原席位重试…';
        say(notice);lobbyBoot?.status(notice);
      }
    });`);
  source = replace(source, "}else if(fragment.has('watch'))connect(await api('/api/watch',{code:linkCode,nickname:$('nickname').value}));", `}else if(fragment.has('watch'))connect(await api('/api/watch',{code:linkCode,nickname:$('nickname').value}));
  else lobbyBoot?.status('席位已失效，请返回大厅重新进入对战。');`);
  return replace(source, "    say(restore&&temporaryJoinError(error)?'暂时无法连接，刷新此页可使用原席位重试。':error.message);", `    const canRetry=Boolean(restore&&!error.invalidSeat);
    const notice=canRetry?'暂时无法连接，可使用原席位重试。':error.message;
    say(notice);lobbyBoot?.status(notice,canRetry);`);
});

await edit('public/net-client.js', source => {
  if (source.includes('const socketResetTimeout=')) return source;
  source = replace(source, 'let enginePhase=\'idle\',initStarted=0;', `let enginePhase='idle',initStarted=0,engineProgressAt=0;
let socketFailures=0;
const socketResetTimeout=7000;
const socketRetryDelays=[750,1500,3000];`);
  source = replace(source, '  if(enginePhase!==\'initializing\')return;', `  if(!watching()&&(enginePhase==='downloading'||enginePhase==='loading')&&
      performance.now()-engineProgressAt>=20000&&$('reload-engine').hidden){
    $('download-detail').textContent='暂时没有加载进度，可使用原席位重新加载。';
    $('reload-engine').hidden=false;
  }
  if(enginePhase!=='initializing')return;`);
  source = replace(source, 'function reconnectNotice(){if(engineGeneration!==null&&!engineStarted)', `function reconnectNotice(){
  lobbyBoot?.status('对战连接暂时不可用，正在使用原席位重试…');
  if(engineGeneration!==null&&!engineStarted)`);
  source = replace(source,
    "    if(error.invalidSeat)forgetSeat(s);\n    engineError(temporaryJoinError(error)?'连接暂时不可用，重新加载可使用原席位重试。':error.message);",
    `    if(error.invalidSeat)forgetSeat(s);
    const notice=temporaryJoinError(error)?'连接暂时不可用，重新加载可使用原席位重试。':error.message;
    lobbyBoot?.status(notice,!error.invalidSeat);
    engineError(notice);`);
  source = replace(source, "  $('lobby').hidden=true;$('arena').hidden=false;lobbyBoot?.connected();$('identity')",
    "  $('lobby').hidden=true;if(!lobbyBoot)$('arena').hidden=false;$('identity')");
  source = replace(source, '  const socket=new WebSocket(endpoint);ws=socket;', `  const socket=new WebSocket(endpoint);ws=socket;
  const resetDeadline=setTimeout(()=>{
    if(ws===socket&&!closed)socket.close(4008,'等待对战连接超时');
  },socketResetTimeout);`);
  source = replace(source, "    if(m.type==='reset'){\n      watchCaptureActive=false;", `    if(m.type==='reset'){
      clearTimeout(resetDeadline);socketFailures=0;
      $('arena').hidden=false;lobbyBoot?.connected();
      watchCaptureActive=false;`);
  source = replace(source, "generation=m.generation;enginePhase='downloading';initStarted=0;",
    "generation=m.generation;enginePhase='downloading';initStarted=0;engineProgressAt=performance.now();");
  source = replace(source, '  socket.onclose=event=>{if(ws===socket)botPanel.setConnected(false);', `  socket.onclose=event=>{
    clearTimeout(resetDeadline);
    if(ws===socket)botPanel.setConnected(false);`);
  source = replace(source, "    if(terminalClose){sessionStorage.removeItem('bvn-session-test2');loading(event.reason||'房间已结束');say('点击「返回首页」可重新建房或加入');return;}\n    reconnectNotice();retry=setTimeout(()=>reconnect(s),1500);", `    if(terminalClose){
      sessionStorage.removeItem('bvn-session-test2');
      const notice=event.reason||'房间已结束';
      lobbyBoot?.status(notice);loading(notice);say('点击「返回首页」可重新建房或加入');return;
    }
    const delay=socketRetryDelays[socketFailures++];
    if(delay===undefined){
      const notice='对战连接暂时不可用，可使用原席位重新加载。';
      lobbyBoot?.status(notice,true);engineError(notice);return;
    }
    reconnectNotice();retry=setTimeout(()=>reconnect(s),delay);`);
  source = replace(source, "  if(['ready','resumed','loading','ack','error'].includes(m.type))send(m);",
    "  if(['ready','resumed','loading','ack'].includes(m.type)||m.type==='error'&&engineStarted)send(m);");
  source = replace(source, "  if(m.type==='download'&&['downloading','initializing'].includes(enginePhase)){",
    "  if(m.type==='download'&&['downloading','initializing'].includes(enginePhase)){\n    engineProgressAt=performance.now();");
  return replace(source, "  if(m.type==='loading'){enginePhase='loading';loading('正在加载角色和地图…');}",
    "  if(m.type==='loading'){enginePhase='loading';engineProgressAt=performance.now();loading('正在加载角色和地图…');}");
});

await edit('net-server.mjs', source => source.includes("'/touch.js':'touch.js'") ? source :
  replace(source, 'const files={', "const files={'/touch.js':'touch.js','/touch.css':'touch.css',"));

await edit('public/net-client.js', source => {
  if (!source.includes('let touchKeys=new Set()'))
    source = replace(source, 'const codes=[', 'let touchKeys=new Set(),touchControls,touchLoading=false;\nconst codes=[');
  if (source.includes('function enableTouchControls(){')) return source;
  source = replace(source, "function mask(){return codes.reduce((n,c,i)=>n|(held.has(c)?1<<i:0),0);}\nfunction release(){held.clear();if(!watching())send({type:'input',mask:0});}", `function mask(){return codes.reduce((n,c,i)=>n|(held.has(c)||touchKeys.has(c)?1<<i:0),0);}
function release(){held.clear();if(!touchControls?.clear()&&!watching())send({type:'input',mask:0});}
function enableTouchControls(){
  if(touchLoading||watching()||!matchMedia('(any-pointer: coarse)').matches)return;
  touchLoading=true;
  import('./touch.js').catch(()=>import('./touch.js?retry=1')).then(({mountTouchControls})=>{
    touchControls=mountTouchControls(game,'fighter',pressed=>{
      touchKeys=pressed;
      if(!watching())send({type:'input',mask:mask()});
    });
  }).catch(()=>{});
}`);
  return replace(source, "$('arena').hidden=false;lobbyBoot?.connected();\n      watchCaptureActive=false;",
    "$('arena').hidden=false;lobbyBoot?.connected();enableTouchControls();\n      watchCaptureActive=false;");
});

await edit('public/net-client.js', source => {
  if (source.includes("classList.add('bvn-touch')")) return source;
  source = replace(source, "if(touchLoading||watching()||!matchMedia('(any-pointer: coarse)').matches)return;",
    "if(touchLoading||watching()||!matchMedia('(pointer: coarse) and (hover: none)').matches)return;");
  return replace(source, "      touchKeys=pressed;\n      if(!watching())send({type:'input',mask:mask()});\n    });",
    "      touchKeys=pressed;\n      if(!watching())send({type:'input',mask:mask()});\n    });\n    if(touchControls)$('arena').classList.add('bvn-touch');");
});

for (const [template, target] of [
  ['bvn33-carnival.css', 'public/net-style.css'],
  ['bvn33-frame-window.mjs', 'lib/lobby-frame-window.mjs'],
  ['bvn33-download-cache.js', 'public/net-download.js'],
  ['bvn33-watch-sidecar.mjs', 'lib/lobby-watch-only.mjs'],
  ['bvn33-watch-capture.mjs', 'public/lobby-capture.js'],
  ['bvn33-watch-client.mjs', 'public/lobby-watch.js'],
  ['bvn33-watch.html', 'public/lobby-watch.html'],
]) changes.set(path.join(root, target), await readFile(new URL('./' + template, import.meta.url), 'utf8'));

for (const [source, target] of [['touch.mjs', 'touch.js'], ['touch.css', 'touch.css']])
  changes.set(path.join(root, 'public', target), await readFile(new URL('../public/tank-arena/' + source, import.meta.url), 'utf8'));

for (const [file, contents] of changes) await writeFile(file, contents);
console.log('BVN 3.3 sidecar prepared with player and authorized viewer transport.');
