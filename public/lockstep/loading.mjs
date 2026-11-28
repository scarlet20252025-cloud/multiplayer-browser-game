/**
 * 共用的游戏加载遮罩：缤纷嘉年华星星组件（public/loader/）的薄包装。
 *
 * 对外 API 与旧的数值进度条一致，调用方（client.mjs）的状态机不用改：
 * - `show(progress)` 收阶段 + 文案 + 可选字节数；
 * - `reset()` 重新从 0 开始数；
 * - `hide()` 收起遮罩。
 *
 * 三条约定，改之前先读：
 * - **百分比只能向前**。有真实字节时按字节算；没有字节时按阶段预算推进。
 * - **等待别人不是加载**。`waiting` / `ready` / `recover` 固定 100%，文案改成等待。
 * - **错误可重试**。`error` 停在当前进度，露出重试与返回。
 */
import {createCarnivalLoader} from '../loader/carnival-loader.mjs';

const PHASE_STAGE = {
  connect: 'download', cache: 'download', download: 'download',
  verify: 'verify', initialize: 'initialize',
};

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function mountGameLoader(container, {backUrl, onBack} = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'game-loader';
  overlay.hidden = true;
  container.classList.add('game-loader-host');
  container.append(overlay);

  const actions = document.createElement('div');
  actions.className = 'game-loader__actions';
  actions.hidden = true;
  const retryButton = document.createElement('button');
  retryButton.type = 'button';
  retryButton.className = 'game-loader__retry';
  retryButton.textContent = '重试加载';
  retryButton.hidden = true;
  const backLink = document.createElement('a');
  backLink.className = 'game-loader__back';
  backLink.textContent = '返回房间';
  backLink.hidden = true;
  if (backUrl) backLink.href = backUrl;
  actions.append(retryButton, backLink);

  let loader = null;
  let pending = null;
  let retryLoad;

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

  createCarnivalLoader(overlay, {layout: 'inline', compact: true}).then((instance) => {
    loader = instance;
    // 重试/返回按钮放进卡片里，跟着组件一起居中和换肤。
    instance.slot.append(actions);
    if (pending) emit(pending);
  });

  function emit(progress) {
    const terminal = progress.phase === 'error' || progress.phase === 'ended' || progress.phase === 'result';
    const stage = PHASE_STAGE[progress.phase] ?? 'initialize';
    const hasLoaded = Number.isFinite(progress.loaded) && progress.loaded >= 0;
    const hasTotal = hasLoaded && Number.isFinite(progress.total) && progress.total > 0;
    const bytes = hasTotal ? `${formatBytes(progress.loaded)} / ${formatBytes(progress.total)}`
      : hasLoaded ? `已接收 ${formatBytes(progress.loaded)}` : '';

    overlay.dataset.phase = progress.phase;
    if (progress.phase === 'error') {
      loader.show({phase: 'error', stage, title: progress.title, detail: progress.detail ?? ''});
    } else if (progress.phase === 'ended' || progress.phase === 'result') {
      loader.show({phase: 'done', stage: 'initialize', title: progress.title, detail: progress.detail ?? ''});
    } else if (progress.phase === 'waiting' || progress.phase === 'ready' || progress.phase === 'recover') {
      loader.show({phase: 'waiting', stage: 'initialize', title: progress.title, detail: progress.detail ?? '', percent: 100});
    } else {
      loader.show({
        phase: 'running', stage, title: progress.title, detail: progress.detail ?? '',
        percent: Number.isFinite(progress.percent) ? progress.percent : null,
        loaded: hasTotal ? progress.loaded : undefined,
        total: hasTotal ? progress.total : undefined,
        bytes,
      });
    }

    retryLoad = typeof progress.retry === 'function' ? progress.retry : undefined;
    retryButton.hidden = !retryLoad;
    retryButton.textContent = progress.retryLabel ?? '重试加载';
    retryButton.disabled = false;
    backLink.hidden = !terminal || !(backUrl || onBack);
    actions.hidden = retryButton.hidden && backLink.hidden;
  }

  return {
    show(progress) {
      overlay.hidden = false;
      pending = progress;
      if (loader) emit(progress);
    },
    hide() {
      overlay.hidden = true;
      loader?.hide();
    },
    reset() {
      loader?.reset();
    },
  };
}