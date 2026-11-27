function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

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
        <div class="game-loader__track" role="progressbar" aria-label="加载进度" aria-valuemin="0" aria-valuemax="100">
          <span class="game-loader__fill"></span>
        </div>
        <span class="game-loader__amount" aria-hidden="true" hidden></span>
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
  const amount = overlay.querySelector('.game-loader__amount');
  const actions = overlay.querySelector('.game-loader__actions');
  const retryButton = overlay.querySelector('.game-loader__retry');
  const backLink = overlay.querySelector('.game-loader__back');
  let retryLoad;

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

  return {
    show({phase, title: heading, detail: description = '', loaded, total, retry, retryLabel = '重试加载'}) {
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
      if (hasTotal) {
        const fraction = Math.min(1, loaded / total);
        track.setAttribute('aria-valuenow', Math.floor(fraction * 100));
        fill.style.width = `${fraction * 100}%`;
        amount.textContent = `${formatBytes(loaded)} / ${formatBytes(total)}`;
      } else {
        track.removeAttribute('aria-valuenow');
        fill.style.removeProperty('width');
        if (hasLoaded) amount.textContent = `已接收 ${formatBytes(loaded)}`;
      }
      amount.hidden = !hasLoaded;
      retryButton.hidden = !retryLoad;
      retryButton.textContent = retryLabel;
      retryButton.disabled = false;
      backLink.hidden = !terminal || !(backUrl || onBack);
      actions.hidden = retryButton.hidden && backLink.hidden;
    },

    hide() {
      overlay.hidden = true;
      retryLoad = undefined;
    },
  };
}
