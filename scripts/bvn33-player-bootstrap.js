(() => {
  const fragment = new URLSearchParams(location.hash.slice(1));
  let back;
  try {
    const saved = sessionStorage.getItem('bvn-lobby-return:' + fragment.get('room'));
    const target = new URL(fragment.get('back') || saved);
    if (['http:', 'https:'].includes(target.protocol) && target.hostname === location.hostname &&
        target.pathname === '/' && !target.username && !target.password) back = target.href;
  } catch {}
  const managed = fragment.has('seat') || Boolean(back);
  if (managed) document.documentElement.classList.add('bvn-managed');

  function stylesheet(search, limit) {
    return new Promise(resolve => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = './style.css' + search;
      const finish = ready => {
        clearTimeout(timer);
        link.onload = link.onerror = null;
        if (!ready && limit) link.remove();
        resolve(ready);
      };
      link.onload = () => finish(true);
      link.onerror = () => finish(false);
      const timer = limit && setTimeout(() => finish(false), limit);
      document.head.appendChild(link);
    });
  }

  window.addEventListener('DOMContentLoaded', async () => {
    if (!managed) {
      void stylesheet('', 0);
      try { await import('./client.js'); }
      catch { document.getElementById('lobby-message').textContent='游戏暂时无法启动，请刷新重试。'; }
      return;
    }

    const panel = document.getElementById('bvn-launch');
    const text = document.getElementById('bvn-launch-status');
    const retry = document.getElementById('bvn-launch-retry');
    const returnLink = document.getElementById('bvn-launch-return');
    if (back) returnLink.href = back;
    retry.onclick = () => location.reload();
    panel.hidden = false;
    let activeSearch, accept;
    function status(value, canRetry = false) {
      text.textContent = value;
      retry.hidden = !canRetry;
    }
    window.bvnLobbyBoot = {
      status,
      connected() { panel.hidden = true; },
      moduleReady(search) {
        if (search !== activeSearch) return false;
        accept(true);
        return true;
      },
    };

    const delays = [0, 500, 1000, 2000];
    async function withRetries(operation, message) {
      for (const [index, delay] of delays.entries()) {
        if (index) {
          status(message);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
        const search = index ? '?launch=' + index : '';
        if (await operation(search)) return true;
      }
      return false;
    }
    if (!await withRetries(search => stylesheet(search, 5500), '正在重新加载游戏界面…')) {
      status('游戏界面暂时无法加载，可使用原席位重试。', true);
      return;
    }

    async function loadModule(search) {
      activeSearch = search;
      const ready = new Promise(resolve => { accept = resolve; });
      const imported = import('./client.js' + search).then(() => true, () => false);
      let timer;
      const result = await Promise.race([ready, imported, new Promise(resolve => {
        timer = setTimeout(() => resolve(false), 6500);
      })]);
      clearTimeout(timer);
      if (!result) activeSearch = null;
      return result;
    }
    if (!await withRetries(loadModule, '正在重新加载联机组件…'))
      status('联机组件暂时无法加载，可使用原席位重试。', true);
  }, {once:true});
})();
