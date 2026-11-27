/**
 * 共用的游戏加载遮罩。
 *
 * 改之前先读这四条约定：
 * - **百分比只能向前**。有真实字节时按字节算；没有字节时按阶段预算推进，
 *   不允许出现「卡在 40% 不动」。
 * - **数字要动画**。目标值变了不直接跳，用 rAF 在 420ms 内追上去，看起来像在数数。
 * - **等待别人不是加载**。`waiting` / `recover` 固定 100%，文案改成等待。
 * - **错误可重试**。`error` 阶段隐藏进度条，露出重试与返回。
 */

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

// 进入某阶段时至少到的百分比，保证单调向前。
const PHASE_BASE = {
  connect: 4,
  cache: 10,
  download: 12,
  verify: 72,
  initialize: 80,
  ready: 96,
  waiting: 100,
};

const DOWNLOAD_SPAN = 58; // 下载占 12% → 70%
const TWEEN_MS = 420;
const easeOut = t => 1 - (1 - t) ** 3;

export function mountGameLoader(container, {backUrl, onBack} = {}) {
  const overlay = container.ownerDocument.createElement('div');
  overlay.className = 'game-loader';
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="game-loader__card">
      <div class="game-loader__status" role="status" aria-atomic="true">
        <h2 class="game-loader__title"></h2>
        <p class="game-loader__detail" hidden></p>
      </div>
      <div class="game-loader__progress">
        <div class="game-loader__readout">
          <span class="game-loader__percent" aria-hidden="true">0<span class="game-loader__unit">%</span></span>
          <span class="game-loader__amount" aria-hidden="true" hidden></span>
        </div>
        <div class="game-loader__track" role="progressbar" aria-label="加载进度"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-valuetext="0%">
          <span class="game-loader__fill"></span>
        </div>
      </div>
      <div class="game-loader__actions" hidden>
        <button class="game-loader__retry" type="button" hidden>重试加载</button>
        <a class="game-loader__back" hidden>返回房间</a>
      </div>
    </div>`;
  const title = overlay.querySelector('.game-loader__title');
  const detail = overlay.querySelector('.game-loader__detail');
  const progress = overlay.querySelector('.game-loader__progress');
  const track = overlay.querySelector('.game-loader__track');
  const fill = overlay.querySelector('.game-loader__fill');
  const percentText = overlay.querySelector('.game-loader__percent');
  const amount = overlay.querySelector('.game-loader__amount');
  const actions = overlay.querySelector('.game-loader__actions');
  const retryButton = overlay.querySelector('.game-loader__retry');
  const backLink = overlay.querySelector('.game-loader__back');
  const digits = percentText.firstChild; // 模板里的「0」文本节点，直接改值，别新增节点
  let retryLoad;
  let shown = 0;   // 当前显示的百分比
  let target = 0;  // 目标百分比
  let frameHandle = 0;
  let tweenStart = 0;
  let tweenFrom = 0;

  if (backUrl) backLink.href = backUrl;
  if (onBack) {
    if (!backUrl) backLink.href = '#';
    backLink.addEventListener('click', (event) => {
      event.preventDefault();
      onBack();
    });
  }
  retryButton.addEventListener('click', () => {
    retryButton.disabled = true;
    retryLoad?.();
  });
  container.classList.add('game-loader-host');
  container.append(overlay);

  function paint(value) {
    shown = value;
    const rounded = Math.round(value);
    digits.nodeValue = String(rounded);
    fill.style.width = `${value}%`;
    track.setAttribute('aria-valuenow', String(rounded));
    track.setAttribute('aria-valuetext', `${rounded}%`);
  }

  function animateTo(next) {
    target = Math.min(100, Math.max(shown, next));
    if (frameHandle) return; // 已经在追，目标会被下一次 paint 取到
    tweenFrom = shown;
    tweenStart = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - tweenStart) / TWEEN_MS);
      paint(tweenFrom + (target - tweenFrom) * easeOut(t));
      if (t < 1) frameHandle = requestAnimationFrame(step);
      else frameHandle = 0;
    };
    frameHandle = requestAnimationFrame(step);
  }

  /** 没有真实字节时，用阶段预算估一个百分比。 */
  function estimate({phase, loaded, total}) {
    if (Number.isFinite(loaded) && Number.isFinite(total) && total > 0) {
      const fraction = Math.min(1, Math.max(0, loaded / total));
      if (phase === 'download') return 10 + DOWNLOAD_SPAN * fraction;
      return Math.max(PHASE_BASE[phase] ?? 0, 100 * fraction);
    }
    // 已确定在下载、但还没拿到第一个字节：给个小起步，别停在 12%。
    if (phase === 'download') return 16;
    return PHASE_BASE[phase] ?? 0;
  }

  return {
    /**
     * @param {{phase:string,title:string,detail?:string,loaded?:number,total?:number,percent?:number,
     *   retry?:Function,retryLabel?:string}} progress
     */
    show({phase, title: heading, detail: description = '', loaded, total, percent, retry, retryLabel = '重试加载'}) {
      const terminal = phase === 'error' || phase === 'ended' || phase === 'result';
      const hasLoaded = Number.isFinite(loaded) && loaded >= 0;
      const hasTotal = hasLoaded && Number.isFinite(total) && total > 0;
      retryLoad = typeof retry === 'function' ? retry : undefined;
      overlay.dataset.phase = phase;
      overlay.hidden = false;
      if (title.textContent !== heading) title.textContent = heading;
      if (detail.textContent !== description) detail.textContent = description;
      detail.hidden = !description;
      progress.hidden = terminal;
      if (!terminal) {
        // 重连不是重新加载：保持当前百分比，只换文案。
        if (phase !== 'recover')
          animateTo(Number.isFinite(percent) ? percent : estimate({phase, loaded, total}));
        fill.classList.toggle('is-waiting', phase === 'waiting' || phase === 'recover');
        if (hasTotal) amount.textContent = `${formatBytes(loaded)} / ${formatBytes(total)}`;
        else if (hasLoaded) amount.textContent = `已接收 ${formatBytes(loaded)}`;
        else amount.textContent = '';
        amount.hidden = !amount.textContent;
      }
      retryButton.hidden = !retryLoad;
      retryButton.textContent = retryLabel;
      retryButton.disabled = false;
      backLink.hidden = !terminal || !(backUrl || onBack);
      actions.hidden = retryButton.hidden && backLink.hidden;
    },

    hide() {
      overlay.hidden = true;
      if (frameHandle) { cancelAnimationFrame(frameHandle); frameHandle = 0; }
      shown = target = 0;
      paint(0);
      retryLoad = undefined;
    },
  };
}
