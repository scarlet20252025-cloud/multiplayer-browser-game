const fighters = new Map([
  ['SBLPlayer', '草莓'], ['PeachPlayer', '桃子'], ['TrashPlayer', '垃圾桶'],
  ['CoffeePlayer', '咖啡'], ['DefaultPlayer', '圆球'], ['AuberginePlayer', '茄子'],
]);
const colors = ['红色', '蓝色', '绿色', '黄色'];
const stages = new Map([
  ['Rooftop', '屋顶'], ['Mogadishu', '摩加迪沙'], ['B52', 'B52 轰炸机'], ['Space', '太空'],
]);
const mapArtRoot = '/__lobby__/art/glorton/maps';
const colorValues = ['#d73e64', '#3b79e2', '#188657', '#a56b00'];

const styleText = `
body.glorton-room {
  min-height:100vh; margin:0; color:#20215c; color-scheme:light;
  background:linear-gradient(180deg,#e2ebff 0,#f5f2ff 340px,#f8f9ff 100%) !important;
  font:14px/1.55 "Microsoft YaHei UI","PingFang SC","Noto Sans CJK SC",system-ui,sans-serif;
}
body.glorton-room.glorton-setup {
  background:#69c9f3 url('/__lobby__/art/carnival.webp') center top / cover no-repeat fixed !important;
}
.glorton-local-hud {
  --ink:#20215c; --muted:#645f84; --purple:#6b30e0; --line:#e3dcf4;
  --rail:clamp(160px,14vw,226px);
  display:grid; grid-template-columns:var(--rail) minmax(0,1fr) var(--rail);
  grid-template-areas:"head head head" "room stage roster"; gap:16px;
  align-items:start; width:min(1720px,calc(100% - 40px)); margin:0 auto; padding:24px 0;
}
.glorton-local-hud * { box-sizing:border-box }
.glorton-local-hud [hidden] { display:none !important }
.glorton-local-hud h1,.glorton-local-hud h2,.glorton-local-hud p { margin:0 }
.glorton-local-hud .local-hud-head,.glorton-local-hud section {
  border:1px solid var(--line); border-radius:16px; background:#fff;
  box-shadow:0 3px 0 #e6e0fb,0 8px 22px #44358a0b;
}
.glorton-local-hud .local-hud-head {
  grid-area:head; display:flex; align-items:center; justify-content:space-between;
  flex-wrap:wrap; gap:10px 16px; padding:11px 15px;
}
.glorton-setup .glorton-local-hud .local-hud-head {
  padding:clamp(13px,2.2vw,24px); border-color:#fff; border-width:2px;
  color:#fff; background:linear-gradient(115deg,#5b38a4,#432c83);
  box-shadow:0 4px 0 #dcd0ff,0 10px 27px #26115238;
}
.glorton-local-hud .local-hud-banner-name { margin-top:2px; font-size:13px; font-weight:650 }
.glorton-local-hud h1 { font-size:clamp(19px,2vw,25px); line-height:1.2; letter-spacing:.01em }
.glorton-local-hud h2 { font-size:14px; line-height:1.4 }
.glorton-local-hud .local-hud-actions { display:flex; gap:7px; flex-wrap:wrap }
.glorton-local-hud button,.glorton-local-hud select,.glorton-local-hud input { font:inherit }
.glorton-local-hud button,.glorton-local-hud select,.glorton-local-hud input {
  min-width:0; border:1px solid #dcd1fa; border-radius:10px; background:#f8f5ff;
  color:var(--ink); padding:7px 10px;
}
.glorton-local-hud button,.glorton-local-hud select { cursor:pointer }
.glorton-local-hud button { font-weight:700 }
.glorton-local-hud button:hover:not(:disabled) { background:#ece4ff }
.glorton-local-hud button:disabled,.glorton-local-hud select:disabled { opacity:.55; cursor:default }
.glorton-local-hud :is(button,select,input,canvas):focus-visible { outline:3px solid #2257bc; outline-offset:2px }
.glorton-local-hud .local-hud-primary {
  color:#fff; background:linear-gradient(#8d52f7,#6b30e0); border-color:transparent;
  box-shadow:0 2px 0 #5328b8;
}
.glorton-local-hud .local-hud-primary:hover:not(:disabled) { background:#622fd1 }
.glorton-local-hud .local-hud-rail { display:grid; min-width:0; gap:12px }
.glorton-local-hud .local-hud-room { grid-area:room }
.glorton-local-hud .local-hud-roster { grid-area:roster }
.glorton-local-hud section { padding:13px }
.glorton-local-hud .local-hud-meta,.glorton-local-hud .local-hud-keys { margin:7px 0 0 }
.glorton-local-hud .local-hud-meta div,.glorton-local-hud .local-hud-keys div {
  display:flex; justify-content:space-between; gap:6px; padding:4px 0;
}
.glorton-local-hud dt { color:var(--muted) }
.glorton-local-hud dd { min-width:0; margin:0; overflow-wrap:anywhere; text-align:right }
.glorton-local-hud [data-room-name] { font-weight:800 }
.glorton-local-hud .local-hud-link { width:100%; margin-top:8px; font-size:12px }
.glorton-local-hud .local-hud-link-status { color:var(--muted); font-size:12px; overflow-wrap:anywhere }
.glorton-local-hud .local-hud-link-status:empty,.glorton-local-hud .glorton-provider-host:empty { display:none }
.glorton-local-hud .local-hud-keys kbd {
  display:inline-block; min-width:1.45em; padding:0 4px; border:1px solid var(--line);
  border-radius:5px; background:#f5f0ff; text-align:center; font:inherit; font-size:12px; font-weight:700;
}
.glorton-local-hud ul { display:grid; gap:3px; margin:7px 0 0; padding:0; list-style:none }
.glorton-local-hud li {
  display:grid; grid-template-columns:auto minmax(0,1fr); column-gap:6px;
  padding:5px 4px; border-bottom:1px solid #f0ebfa;
}
.glorton-local-hud li:last-child { border-bottom:0 }
.glorton-local-hud li[data-self] { background:#f1ebff; border-radius:7px }
.glorton-local-hud li b { color:var(--slot-color,#635ba8); font-size:12px; align-self:start }
.glorton-local-hud li span,.glorton-local-hud li small { overflow-wrap:anywhere }
.glorton-local-hud li small { grid-column:2; color:var(--muted); font-size:11px }
.glorton-local-hud li[data-player-ready] small { color:#12714a; font-weight:700 }
.glorton-local-hud li[data-player-vacant] { opacity:.65 }
.glorton-local-hud .glorton-stage {
  position:relative; isolation:isolate; grid-area:stage; min-width:0; width:100%;
  aspect-ratio:32 / 19; border:1px solid #d0c1ef; border-radius:18px;
  background:#1d1740; box-shadow:0 5px 0 #d9cff8,0 13px 28px #30266629;
}
.glorton-local-hud .glorton-stage #canvas {
  position:absolute !important; inset:0 !important; z-index:0 !important;
  display:block; width:100% !important; height:100% !important;
  margin:0 !important; padding:0 !important; border:0 !important; border-radius:inherit;
}
.glorton-local-hud .glorton-stage #transfer {
  position:absolute; inset:0; z-index:1; display:grid; place-content:center; color:#fff; pointer-events:none;
}
.glorton-local-hud .glorton-stage #transfer #status { margin:0 0 8px; color:inherit }
.glorton-local-hud .glorton-stage #transfer #progress { width:min(220px,60vw) }
.glorton-local-hud .glorton-stage:not([data-mode=loading]) #transfer { display:none }
.glorton-local-hud .glorton-stage[data-mode=select] #canvas {
  /* Pygbag sets inline visibility during boot. Keep the backing surface sized for the match. */
  visibility:hidden !important; opacity:0 !important; pointer-events:none !important;
}
.glorton-local-hud .glorton-stage[data-mode=select] {
  aspect-ratio:auto; border:0; border-radius:0; background:none; box-shadow:none;
}
.glorton-local-hud .local-hud-selection {
  position:relative; z-index:1; display:grid; gap:12px; color:var(--ink);
}
.glorton-local-hud .local-hud-selection section { padding:clamp(13px,1.5vw,21px); border-radius:17px }
.glorton-local-hud .local-hud-selection h2 { font-size:clamp(18px,2.2vw,25px); font-weight:850 }
.glorton-local-hud .local-hud-selection p { color:var(--muted); margin:3px 0 0 }
.glorton-local-hud .local-hud-ready-head {
  display:flex; align-items:center; justify-content:space-between; gap:9px;
}
.glorton-local-hud .local-hud-ready-head button { min-width:84px; min-height:42px; flex-shrink:0 }
.glorton-local-hud .local-hud-ready-count { font-weight:700 }
.glorton-local-hud .local-hud-options {
  display:grid; min-width:0; gap:12px;
}
.glorton-local-hud .local-hud-preview {
  display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px;
  margin:10px 0; padding:6px 12px; border-radius:14px; background:linear-gradient(120deg,#f8f4ff,#eee6fd);
}
.glorton-local-hud .local-hud-preview figure {
  min-width:0; margin:0; display:flex; align-items:center; gap:10px;
  color:var(--ink); font-weight:800; font-size:13px;
}
.glorton-local-hud .local-hud-preview img { display:block; width:78px; height:78px; object-fit:contain }
.glorton-local-hud .local-hud-preview label { display:grid; gap:3px; font-size:12px; font-weight:700 }
.glorton-local-hud .local-hud-preview select { padding:6px 7px }
.glorton-local-hud .local-hud-fighters {
  display:grid; grid-template-columns:repeat(6,minmax(0,1fr)); gap:clamp(5px,1vw,11px);
}
.glorton-local-hud .local-hud-fighter {
  min-height:0; display:grid; grid-template-rows:clamp(40px,4.8vw,66px) auto; justify-items:center;
  align-items:center; gap:3px; padding:6px 3px; border-radius:12px; background:#fff;
  border:1px solid #ded3fa; font-size:clamp(11px,1.15vw,15px); white-space:nowrap;
}
.glorton-local-hud .local-hud-fighter img { width:88%; height:100%; object-fit:contain; pointer-events:none }
.glorton-local-hud .local-hud-fighter span { grid-row:2 }
.glorton-local-hud .local-hud-fighter[aria-pressed=true] {
  border-color:#7237df; background:#eee6ff; box-shadow:inset 0 0 0 1px #7237df;
}
.glorton-local-hud .local-hud-ballot {
  display:grid; min-width:0; gap:8px;
}
.glorton-local-hud .local-hud-ballot-head p { font-size:12px; margin:0 }
.glorton-local-hud .local-hud-ballot-list { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:6px }
.glorton-local-hud .local-hud-ballot-list button {
  display:grid; align-content:start; justify-items:center; gap:3px; padding:4px;
  font-size:clamp(11px,1.2vw,14px); text-align:center;
}
.glorton-local-hud .local-hud-ballot-list img {
  width:100%; height:auto; aspect-ratio:3 / 2; object-fit:contain; border-radius:6px; background:#e9e1f8;
}
.glorton-local-hud .local-hud-ballot-list button[aria-pressed=true] {
  border-color:#7237df; background:#eee6ff; box-shadow:inset 0 0 0 1px #7237df;
}
.glorton-local-hud .local-hud-ballot-list button small { color:var(--muted); font-size:11px; font-weight:600 }
.glorton-local-hud .local-hud-result {
  position:absolute; inset:0; display:grid; place-items:center; padding:12px; border-radius:inherit;
  background:#1d1740a6;
}
.glorton-local-hud .local-hud-result section {
  display:grid; justify-items:center; gap:8px; width:min(340px,100%); padding:clamp(12px,3vw,25px);
  text-align:center; overflow-wrap:anywhere;
}
.glorton-local-hud .local-hud-result h2 { font-size:clamp(19px,3vw,31px) }
.glorton-local-hud .local-hud-result p { font-size:13px; color:var(--muted) }
.glorton-local-hud .local-hud-result .local-hud-actions { justify-content:center }
@media(max-width:950px) {
  .glorton-local-hud {
    grid-template-columns:repeat(2,minmax(0,1fr)); gap:11px;
    grid-template-areas:"head head" "stage stage" "room roster";
    width:min(720px,calc(100% - 22px)); padding:11px 0 18px;
  }
}
@media(max-width:510px) {
  .glorton-local-hud { grid-template-columns:minmax(0,1fr); grid-template-areas:"head" "stage" "room" "roster" }
  .glorton-local-hud .local-hud-head,.glorton-local-hud section { border-radius:12px; padding:10px }
  .glorton-local-hud .glorton-stage { border-radius:12px }
  .glorton-local-hud .local-hud-fighters { grid-template-columns:repeat(3,minmax(0,1fr)) }
  .glorton-local-hud .local-hud-fighter { grid-template-rows:43px auto }
  .glorton-local-hud .local-hud-ballot-list { grid-template-columns:repeat(2,minmax(0,1fr)) }
}
@media(max-height:620px) and (orientation:landscape) {
  .glorton-local-hud .glorton-stage:is([data-mode=battle],[data-mode=result]) {
    max-width:calc((100svh - 90px) * 32 / 19); justify-self:center;
  }
}
`;

export function mountGlortonHud({room, roomName, send, leave = () => location.assign('/')}) {
  const view = document.createElement('div');
  view.className = 'glorton-local-hud';
  view.innerHTML = `
    <header class="local-hud-head"><div><h1>疯狂小人乱斗</h1><p class="local-hud-banner-name" data-banner-name></p></div><div class="local-hud-actions">
      <button type="button" data-share>复制邀请</button><button type="button" data-leave>返回大厅</button>
    </div></header>
    <aside class="local-hud-rail local-hud-room" aria-label="联机房间">
      <section><h2>房间信息</h2><dl class="local-hud-meta">
        <div><dt>房间</dt><dd data-room-name></dd></div>
        <div><dt>状态</dt><dd data-status role="status"></dd></div>
        <div data-connection hidden><dt>往返延迟</dt><dd data-rtt></dd></div>
        <div data-app-delay hidden><dt>游戏回包</dt><dd data-app-rtt></dd></div>
        <div data-frame-rate hidden><dt>画面帧率</dt><dd data-fps></dd></div>
        <div data-backlog hidden><dt>同步积压</dt><dd data-backlog-value></dd></div>
        <div data-rules hidden><dt>地图</dt><dd data-map></dd></div>
        <div data-rules hidden><dt>命数</dt><dd data-stock></dd></div>
        <div data-rules hidden><dt>道具</dt><dd data-items></dd></div>
      </dl><input class="local-hud-link" aria-label="邀请链接" readonly hidden>
      <p class="local-hud-link-status" aria-live="polite"></p></section>
      <div class="glorton-provider-host"></div>
    </aside>
    <main class="glorton-stage" aria-label="游戏画面" data-mode="loading">
      <div class="local-hud-selection" hidden>
        <section aria-labelledby="glorton-ready-title">
          <div class="local-hud-ready-head"><div><h2 id="glorton-ready-title" data-pick-title>开局准备</h2>
            <p class="local-hud-ready-count" data-ready-count hidden></p></div>
            <button class="local-hud-primary" type="button" data-ready hidden>准备</button>
          </div>
          <p data-pick-help></p>
        </section>
        <div class="local-hud-options" hidden>
          <section aria-labelledby="glorton-role-title">
            <h2 id="glorton-role-title">角色与配色</h2>
            <div class="local-hud-preview">
              <figure><img data-picked-portrait alt="" width="78" height="78" hidden><figcaption data-picked-role></figcaption></figure>
              <label for="glorton-color">颜色<select id="glorton-color" data-color></select></label>
            </div>
            <div class="local-hud-fighters" data-fighter-list role="group" aria-label="角色"></div>
          </section>
          <section class="local-hud-ballot" aria-labelledby="glorton-ballot-title">
            <div class="local-hud-ballot-head"><h2 id="glorton-ballot-title">地图投票</h2><p>最高票入选，同票时随机抽选。</p></div>
            <div class="local-hud-ballot-list" data-stage-list role="group" aria-labelledby="glorton-ballot-title"></div>
          </section>
        </div>
      </div>
      <div class="local-hud-result" hidden>
        <section aria-labelledby="glorton-result-title">
          <h2 id="glorton-result-title" data-result-title>对局结束</h2>
          <p data-rematch-status aria-live="polite"></p>
          <div class="local-hud-actions">
            <button class="local-hud-primary" type="button" data-rematch>再来一局</button>
            <button type="button" data-result-leave>返回大厅</button>
          </div>
          <p data-result-notice aria-live="polite" hidden></p>
        </section>
      </div>
    </main>
    <aside class="local-hud-rail local-hud-roster" aria-label="玩家与操作">
      <section><h2 data-player-count>房间玩家</h2><ul aria-label="玩家席位"></ul></section>
      <section><h2>键位</h2><dl class="local-hud-keys">
        <div><dt>移动</dt><dd><kbd>A</kbd> <kbd>D</kbd></dd></div>
        <div><dt>跳跃 / 下蹲</dt><dd><kbd>W</kbd> <kbd>S</kbd></dd></div>
        <div><dt>普通 / 特殊攻击</dt><dd><kbd>J</kbd> <kbd>K</kbd></dd></div>
        <div><dt>护盾</dt><dd><kbd>Shift</kbd></dd></div>
      </dl></section>
    </aside>`;
  const css = document.createElement('style');
  css.textContent = styleText;
  document.head.append(css);
  document.body.classList.add('glorton-room');
  document.title = '疯狂小人乱斗 · 肥鱼乐园';
  document.body.append(view);

  const find = selector => view.querySelector(selector);
  const stage = find('.glorton-stage');
  const canvas = document.querySelector('#canvas');
  const transfer = document.querySelector('#transfer');
  if (transfer) stage.prepend(transfer);
  if (canvas) stage.prepend(canvas);

  const name = find('[data-room-name]'), banner = find('[data-banner-name]'), status = find('[data-status]');
  const selection = find('.local-hud-selection'), options = find('.local-hud-options');
  const fighterList = find('[data-fighter-list]'), color = find('[data-color]'), ready = find('[data-ready]');
  const activePortrait = find('[data-picked-portrait]'), activeRole = find('[data-picked-role]');
  const readyCount = find('[data-ready-count]');
  const stageList = find('[data-stage-list]');
  const result = find('.local-hud-result'), resultTitle = find('[data-result-title]');
  const rematch = find('[data-rematch]'), rematchStatus = find('[data-rematch-status]');
  const resultNotice = find('[data-result-notice]');
  const roster = find('ul'), count = find('[data-player-count]');
  const pickTitle = find('[data-pick-title]'), pickHelp = find('[data-pick-help]');
  const share = find('[data-share]'), shareField = find('.local-hud-link');
  const notice = find('.local-hud-link-status');
  const leaveButtons = view.querySelectorAll('[data-leave],[data-result-leave]');
  const rules = view.querySelectorAll('[data-rules]');
  const connection = find('[data-connection]'), rtt = find('[data-rtt]');
  const appDelay = find('[data-app-delay]'), appRtt = find('[data-app-rtt]');
  const frameRate = find('[data-frame-rate]'), fps = find('[data-fps]');
  const backlog = find('[data-backlog]'), backlogValue = find('[data-backlog-value]');
  const cards = new Map();
  const mapButtons = new Map();
  let portraits = window.GlortonRolePortraits ?? {};
  for (const [key, label] of fighters) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.fighter = key;
    button.className = 'local-hud-fighter';
    button.setAttribute('aria-pressed', 'false');
    const image = document.createElement('img');
    image.alt = '';
    image.hidden = true;
    const text = document.createElement('span');
    text.textContent = label;
    button.append(image, text);
    button.addEventListener('click', () => submit({fighter:key}));
    fighterList.append(button);
    cards.set(key, {button, image});
  }
  for (const [index, label] of colors.entries()) color.add(new Option(label, index));
  for (const [key, label] of stages) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.stageVote = key;
    button.setAttribute('aria-pressed', 'false');
    const image = document.createElement('img');
    image.alt = '';
    image.width = 150;
    image.height = 100;
    image.decoding = 'async';
    image.src = `${mapArtRoot}/${key}.png`;
    const title = document.createElement('span');
    title.textContent = label;
    const votes = document.createElement('small');
    button.append(image, title, votes);
    button.addEventListener('click', () => {
      if (canSelect() && readyPending === null && ballot[localSlot] !== key) {
        send({op:'map_vote', stage:key});
      }
    });
    stageList.append(button);
    mapButtons.set(key, {button, votes});
  }

  let localSlot = null, slots = [], phase = 'connecting', online = false, paused = false;
  let displayName = roomName || room, capacity = 0, settings = null, engineStatus = '', errorMessage = '';
  let automaticRoster = false, minimumPlayers = 2;
  let started = false, round = 0, ballot = [], matchResult = null, rematchVotes = [];
  let readyPending = null, readyTimer, rematchPending = null, rematchTimer;

  function canSelect() {
    return online && phase === 'lobby' && slots[localSlot]?.kind === 'human' && slots[localSlot]?.connected === true;
  }

  function describePhase() {
    if (errorMessage) return errorMessage;
    if (phase === 'finished' || phase === 'ended') return '对局结束';
    if (paused || (!online && started)) return '等待重连';
    if (!online) return engineStatus || '正在连接';
    if (phase === 'playing') return '对局进行中';
    return '等待玩家准备';
  }

  function renderCards(selected, colorIndex) {
    const activeSource = portraits[selected]?.[colorIndex];
    if (activeSource && activePortrait.getAttribute('src') !== activeSource) activePortrait.src = activeSource;
    activePortrait.hidden = !activeSource;
    activeRole.textContent = fighters.has(selected)
      ? `${fighters.get(selected)} · ${colors[colorIndex] ?? colors[0]}` : '选择角色';
    for (const [key, {button, image}] of cards) {
      const source = portraits[key]?.[colorIndex];
      if (source && image.getAttribute('src') !== source) image.src = source;
      image.hidden = !source;
      button.setAttribute('aria-pressed', String(key === selected));
      button.disabled = readyPending !== null;
    }
  }

  function renderBallot(locked) {
    for (const [key, {button, votes}] of mapButtons) {
      button.disabled = locked;
      button.setAttribute('aria-pressed', String(ballot[localSlot] === key));
      votes.textContent = `${ballot.filter((choice, index) => choice === key && slots[index]?.kind === 'human' && slots[index].enabled).length} 票`;
    }
  }

  function renderResult() {
    if (!matchResult) return;
    resultTitle.textContent = localSlot !== null && matchResult.winner_slot === localSlot ? '你获胜了' :
      matchResult.winner ? `${matchResult.winner} 获胜` : '对局结束';
    const required = matchResult.reason === 'game_set' ?
      slots.filter(slot => slot.kind === 'human' && slot.enabled).length : 0;
    const voted = rematchVotes[localSlot] === true;
    rematch.hidden = required < 2;
    rematch.disabled = !online || rematchPending !== null;
    rematch.textContent = rematchPending !== null ? '正在提交…' : voted ? '取消再战' : '再来一局';
    rematch.setAttribute('aria-pressed', String(voted));
    rematchStatus.textContent = required >= 2 ? `再战确认 ${rematchVotes.filter(Boolean).length}/${required}` :
      matchResult.reason === 'reconnect_timeout' ? '玩家重连超时' : '此局已结束';
  }

  function render() {
    const mode = phase === 'finished' ? 'result' : phase === 'ended' ? 'select' :
      started ? 'battle' : online ? 'select' : 'loading';
    if (stage.dataset.mode !== mode) {
      stage.dataset.mode = mode;
      document.body.classList.toggle('glorton-setup', mode === 'select');
      if (mode === 'battle' || mode === 'select') window.scrollTo(0, 0);
      if (mode === 'battle') canvas?.focus({preventScroll:true});
    }
    name.textContent = displayName;
    const statusText = describePhase();
    if (status.textContent !== statusText) status.textContent = statusText;
    selection.hidden = mode !== 'select';
    result.hidden = mode !== 'result';
    if (!result.hidden) renderResult();
    const selectable = canSelect();
    const humans = slots.filter(slot => slot.kind === 'human' && slot.enabled);
    const connected = humans.filter(slot => slot.connected).length;
    const readyPlayers = humans.filter(slot => slot.ready && (!automaticRoster || slot.connected)).length;
    const requiredPlayers = automaticRoster ? Math.max(minimumPlayers, humans.length) : capacity;
    const onlineCount = automaticRoster ? `${connected} 人在线 · 最多 ${capacity} 人` : `${connected}/${capacity} 在线`;
    banner.textContent = capacity ? `${displayName} · ${onlineCount}` : displayName;
    options.hidden = !selectable;
    ready.hidden = !selectable;
    readyCount.hidden = !capacity || !selectable;
    pickTitle.textContent = phase === 'ended' ? '房间已关闭' : selectable ? '开局准备' : '等待房间就绪';
    if (phase === 'ended') pickHelp.textContent = statusText;
    else if (automaticRoster) pickHelp.textContent = connected < humans.length ? '等待暂离玩家重连。'
      : connected < minimumPlayers ? `至少 ${minimumPlayers} 位玩家在线才能开局。` : '在线玩家全部准备后自动开局。';
    else pickHelp.textContent = connected < capacity ? '等待所有玩家入座或重连。' : '所有玩家准备后自动开局。';
    if (selectable) {
      const own = slots[localSlot];
      color.value = String(own.color ?? 0);
      color.disabled = readyPending !== null;
      renderCards(own.fighter, Number(color.value));
      readyCount.textContent = `${readyPlayers}/${requiredPlayers} 已准备`;
      ready.disabled = readyPending !== null;
      ready.textContent = readyPending !== null ? '正在提交…' : own.ready ? '取消准备' : '准备';
      ready.setAttribute('aria-pressed', String(Boolean(own.ready)));
      ready.classList.toggle('local-hud-primary', !own.ready);
      renderBallot(readyPending !== null);
    }
    for (const row of rules) row.hidden = !settings;
    if (settings) {
      const mapName = phase === 'lobby' ? null : settings.stage;
      find('[data-map]').textContent = stages.get(mapName) ?? mapName ?? '投票中';
      find('[data-stock]').textContent = settings.stock ?? '—';
      find('[data-items]').textContent = settings.items ? '开启' : '关闭';
    }
    count.textContent = !capacity ? '房间玩家' : automaticRoster ? `房间玩家 · ${connected} 人在线` : `房间玩家 ${connected}/${capacity}`;
    roster.replaceChildren(...slots.map((slot, index) => {
      if (index >= capacity && !(slot.kind === 'ai' && slot.enabled)) return null;
      if (automaticRoster && phase !== 'lobby' && !slot.enabled) return null;
      const row = document.createElement('li');
      row.dataset.playerSlot = index;
      row.toggleAttribute('data-self', index === localSlot);
      row.toggleAttribute('data-player-ready', phase === 'lobby' && slot.ready && slot.connected);
      row.toggleAttribute('data-player-vacant', automaticRoster && !slot.enabled);
      if (slot.enabled && colorValues[slot.color]) row.style.setProperty('--slot-color', colorValues[slot.color]);
      const label = document.createElement('b'), nickname = document.createElement('span');
      const detail = document.createElement('small');
      label.textContent = 'P' + (index + 1);
      nickname.textContent = slot.enabled ? (slot.name || (slot.kind === 'ai' ? '电脑' : '玩家 ' + (index + 1))) : '空位';
      const state = !slot.enabled ? automaticRoster ? '可加入' : '待加入' : slot.kind === 'ai' ? '电脑' : phase === 'lobby'
        ? [slot.connected ? null : '离线', slot.ready ? '已准备' : '未准备'].filter(Boolean).join(' · ')
        : slot.connected ? '在线' : '离线';
      const choice = slot.enabled && fighters.has(slot.fighter) ? [fighters.get(slot.fighter), colors[slot.color]].filter(Boolean) : [];
      detail.textContent = [state, ...choice].join(' · ');
      row.append(label, nickname, detail);
      return row;
    }).filter(Boolean));
  }

  function submit(patch) {
    return canSelect() && send({op:'lobby_update', slot:localSlot, patch}) !== false;
  }

  function clearReady() {
    clearTimeout(readyTimer);
    readyPending = null;
  }

  function clearRematch() {
    clearTimeout(rematchTimer);
    rematchPending = null;
  }

  color.addEventListener('change', () => {
    renderCards(slots[localSlot]?.fighter, Number(color.value));
    if (!submit({color:Number(color.value)})) render();
  });
  ready.addEventListener('click', () => {
    if (readyPending !== null || !canSelect()) return;
    readyPending = !slots[localSlot].ready;
    if (submit({ready:readyPending})) {
      readyTimer = setTimeout(() => { clearReady(); render(); }, 4000);
    } else {
      clearReady();
    }
    render();
  });
  rematch.addEventListener('click', () => {
    if (!online || phase !== 'finished' || rematchPending !== null || rematch.hidden) return;
    rematchPending = !rematchVotes[localSlot];
    if (send({op:'rematch', ready:rematchPending}) !== false) {
      rematchTimer = setTimeout(() => { clearRematch(); renderResult(); }, 4000);
    } else {
      clearRematch();
    }
    renderResult();
  });
  for (const event of ['keydown', 'keyup']) view.addEventListener(event, input => {
    if (input.target.closest('input,select,button,a')) input.stopPropagation();
  });
  for (const button of leaveButtons) button.addEventListener('click', async () => {
    leaveButtons.forEach(control => { control.disabled = true; });
    try { await leave(); }
    catch {
      const failure = phase === 'finished' ? resultNotice : notice;
      failure.textContent = '退出失败，请重试';
      failure.hidden = false;
      leaveButtons.forEach(control => { control.disabled = false; });
    }
  });
  share.addEventListener('click', async () => {
    const link = new URL('/', location.origin);
    link.searchParams.set('room', displayName || room);
    link.searchParams.set('game', 'glorton');
    try {
      await navigator.clipboard.writeText(link.href);
      shareField.hidden = true;
    } catch {
      shareField.value = link.href;
      shareField.hidden = false;
      shareField.select();
      try { if (document.execCommand('copy')) shareField.hidden = true; } catch {}
    }
    notice.textContent = shareField.hidden ? '邀请链接已复制' : '请复制邀请链接';
  });
  window.addEventListener('glorton:provider-status', ({detail}) => {
    engineStatus = detail?.phase === 'ready' ? '' : detail?.message ?? '';
    if (!online) render();
  });
  window.addEventListener('glorton:role-portraits', ({detail}) => {
    portraits = detail ?? window.GlortonRolePortraits ?? {};
    renderCards(slots[localSlot]?.fighter, Number(color.value));
  });
  render();

  return {
    transportMetrics({rttMs, linkRttMs, frameBacklog, fps:presentedFps}) {
      const roundTrip = linkRttMs ?? rttMs;
      connection.hidden = !Number.isFinite(roundTrip);
      if (!connection.hidden) rtt.textContent = `${Math.round(roundTrip)} ms`;
      appDelay.hidden = !Number.isFinite(linkRttMs) || !Number.isFinite(rttMs) || rttMs-linkRttMs<8;
      if (!appDelay.hidden) appRtt.textContent = `${Math.round(rttMs)} ms`;
      frameRate.hidden = !Number.isFinite(presentedFps);
      if (!frameRate.hidden) fps.textContent = `${Math.round(presentedFps)} FPS`;
      backlog.hidden = !Number.isFinite(frameBacklog) || frameBacklog < 2;
      if (!backlog.hidden) backlogValue.textContent = `${frameBacklog} 帧`;
    },
    receive(packet) {
      if (typeof packet?.roomName === 'string' && packet.roomName) displayName = packet.roomName;
      if (Number.isInteger(packet?.capacity) && packet.capacity >= 2 && packet.capacity <= 4) capacity = packet.capacity;
      if (typeof packet?.automaticRoster === 'boolean') automaticRoster = packet.automaticRoster;
      if (Number.isInteger(packet?.minimumPlayers) && packet.minimumPlayers >= 2 && packet.minimumPlayers <= 4)
        minimumPlayers = packet.minimumPlayers;
      switch (packet?.op) {
        case 'welcome':
          if (!Number.isInteger(packet.slot) || packet.slot < 0 || packet.slot > 3) return;
          localSlot = packet.slot;
          online = true;
          errorMessage = '';
          break;
        case 'state':
          if (packet.phase === 'ended') {
            phase = 'ended';
            errorMessage = typeof packet.message === 'string' ? packet.message : '';
          }
          if (typeof packet.paused === 'boolean') paused = packet.paused;
          break;
        case 'room_state':
          if (!Array.isArray(packet.slots) || packet.slots.length > 4) return;
          if (Number.isSafeInteger(packet.round)) {
            if (packet.round < round) return;
            round = packet.round;
          }
          slots = packet.slots.map(slot => slot ?? {});
          ballot = Array.isArray(packet.map_votes) ? packet.map_votes : [];
          rematchVotes = Array.isArray(packet.rematch_votes) ? packet.rematch_votes : [];
          if (slots[localSlot]?.ready === readyPending) clearReady();
          if (Boolean(rematchVotes[localSlot]) === rematchPending) clearRematch();
          if (phase !== 'ended') {
            if (packet.phase === 'lobby') {
              if (phase !== 'lobby') {
                started = false;
                matchResult = null;
                resultNotice.hidden = true;
                clearReady();
                clearRematch();
              }
              phase = 'lobby';
            } else if (packet.result || packet.phase === 'finished') {
              matchResult = packet.result ?? matchResult ?? {};
              phase = 'finished';
            } else if (phase !== 'finished') {
              phase = packet.phase;
            }
          }
          paused = packet.paused_for_reconnect === true;
          settings = packet.settings ?? settings;
          break;
        case 'match_start':
          phase = 'playing';
          started = true;
          if (stages.has(packet.match_config?.stage)) settings = {...settings, stage:packet.match_config.stage};
          matchResult = null;
          resultNotice.hidden = true;
          clearReady();
          clearRematch();
          break;
        case 'match_end':
          if (phase !== 'ended') {
            phase = 'finished';
            matchResult = packet;
          }
          break;
        case 'error':
          clearReady();
          clearRematch();
          const message = typeof packet.message === 'string' ? packet.message : '联机连接发生错误';
          if (packet.fatal) {
            phase = 'ended';
            errorMessage = message;
          } else if (phase === 'finished') {
            resultNotice.textContent = message;
            resultNotice.hidden = false;
          } else {
            errorMessage = message;
          }
          break;
        default: return;
      }
      render();
    },
    disconnect() {
      online = false;
      clearReady();
      clearRematch();
      connection.hidden = true;
      appDelay.hidden = true;
      frameRate.hidden = true;
      backlog.hidden = true;
      render();
    },
  };
}
