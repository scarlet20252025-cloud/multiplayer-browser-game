/**
 * 缤纷嘉年华星星加载组件的共用适配层。
 *
 * 各游戏原来各有一套「百分比读数 + 轨道 + 420ms 数字补间」的实现，样式与
 * 手感各不相同。这里把差异收进一个入口，页面只描述状态，其余交给组件。
 *
 * 三条约定，改动前先读：
 * - **数字只向前**。同一个实例里进度不会倒退；重新开始时显式调用 reset()。
 * - **等待不是加载**。`waiting` / `recover` 显示满格并在文案里说明在等谁。
 * - **完成由业务事件决定**，不是下载完就算完。
 */

const HERE = new URL('.', import.meta.url);
const STAGES = new Set(['download', 'verify', 'initialize']);
const STATES = new Set(['idle', 'running', 'paused', 'error', 'done']);
const TWEEN_MS = 420;

let corePromise;

function injectStylesheet() {
  const href = new URL('loader.css', HERE).href;
  if (document.querySelector(`link[data-carnival-loader]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.carnivalLoader = '';
  document.head.append(link);
}

/** 组件本体是普通脚本（挂在 window 上），这里只加载一次。 */
export function loadCarnivalCore() {
  if (typeof window !== 'undefined' && window.CarnivalLoader) return Promise.resolve(window.CarnivalLoader);
  if (corePromise) return corePromise;
  injectStylesheet();
  corePromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('loader.js', HERE).href;
    script.onload = () => (window.CarnivalLoader ? resolve(window.CarnivalLoader) : reject(Error('加载组件未注册')));
    script.onerror = () => reject(Error('加载组件脚本请求失败'));
    document.head.append(script);
  });
  return corePromise;
}

const easeOut = (t) => 1 - (1 - t) ** 3;

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

/**
 * @param {Element} host 挂载点。overlay 布局下会铺满 host 的定位父级。
 * @param {{layout?:'overlay'|'inline', compact?:boolean, motion?:boolean, label?:string}} options
 */
export async function createCarnivalLoader(host, { layout = 'overlay', compact = false, motion = true, label = '游戏加载进度' } = {}) {
  if (!(host instanceof Element)) throw TypeError('createCarnivalLoader 需要有效的挂载节点');
  const CarnivalLoader = await loadCarnivalCore();

  const overlay = document.createElement('div');
  overlay.className = layout === 'overlay' ? 'cl-overlay' : 'cl-overlay cl-overlay--inline';
  // 既有验收脚本按旧遮罩的选择器读取阶段与文案（.game-loader[data-phase]、
  // .game-loader__detail），保留这两个钩子，避免为换皮重写整套验证。
  overlay.classList.add('game-loader');
  overlay.hidden = true;
  overlay.setAttribute('role', 'status');
  overlay.setAttribute('aria-live', 'polite');
  overlay.setAttribute('aria-label', label);

  const slot = document.createElement('div');
  slot.className = 'cl-slot';
  overlay.append(slot);
  host.append(overlay);

  const ui = new CarnivalLoader(slot, { compact, motion });
  // 既有验收脚本按 `.game-loader__detail` 读取进度文案：直接挂在组件自己的
  // 说明行上，不另造重复节点。
  slot.querySelector('.cl-detail')?.classList.add('game-loader__detail');

  let shown = 0;
  let target = 0;
  let frame = 0;
  let tweenFrom = 0;
  let tweenAt = 0;
  let resetPending = false;
  let lastPhase = 'idle';
  let lastDetail = '';
  let lastBytes = '';

  const paint = (value, stage) => {
    shown = value;
    ui.update({ progress: value, stage, state: lastPhase, detail: lastDetail, bytes: lastBytes });
  };

  const animateTo = (next, stage) => {
    const clamped = Math.min(100, Math.max(0, next));
    if (clamped <= target) {
      // 目标没变也要把文案刷新出去，否则阶段变化会被吞掉。
      ui.update({ progress: target, stage, state: lastPhase, detail: lastDetail, bytes: lastBytes });
      return;
    }
    target = clamped;
    if (frame) return;
    tweenFrom = shown;
    tweenAt = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - tweenAt) / TWEEN_MS);
      paint(tweenFrom + (target - tweenFrom) * easeOut(t), stage);
      frame = t < 1 ? requestAnimationFrame(step) : 0;
    };
    frame = requestAnimationFrame(step);
  };

  /** 没有真实字节时用阶段预算估进度，保证数字一直在动。 */
  function estimate({ base, span = 0, fraction }) {
    if (Number.isFinite(fraction)) return base + span * Math.min(1, Math.max(0, fraction));
    return base;
  }

  return {
    /** 组件自身的根节点，个别页面需要读取量测结果时用。 */
    get element() {
      return overlay;
    },

    /** 组件卡片节点，调用方要往卡片里塞按钮时用。 */
    get slot() {
      return slot;
    },

    get visible() {
      return !overlay.hidden;
    },

    /**
     * @param {{phase?:string, state?:string, stage?:string, title?:string, detail?:string,
     *   percent?:number|null, loaded?:number, total?:number, retry?:Function, bytes?:string}} view
     */
    show({ phase = 'running', state, stage = 'download', title, detail = '', percent = null, loaded, total, bytes } = {}) {
      const nextState = state ?? (
        phase === 'error' ? 'error'
          : phase === 'done' || phase === 'ready' ? 'done'
            : phase === 'paused' ? 'paused' : 'running'
      );
      lastPhase = STATES.has(nextState) ? nextState : 'running';
      const terminal = lastPhase === 'error';
      const nextStage = STAGES.has(stage) ? stage : 'download';

      let value = percent;
      if (value === null && Number.isFinite(loaded) && Number.isFinite(total) && total > 0) {
        value = nextStage === 'download'
          ? estimate({ base: 10, span: 62, fraction: loaded / total })
          : estimate({ base: 72, span: 24, fraction: loaded / total });
      }

      lastDetail = detail || '';
      lastBytes = bytes ?? (Number.isFinite(loaded) && Number.isFinite(total) && total > 0
        ? `${formatBytes(loaded)} / ${formatBytes(total)}`
        : Number.isFinite(loaded) ? `已接收 ${formatBytes(loaded)}` : '');

      overlay.hidden = false;
      overlay.dataset.phase = phase;
      if (title) ui.update({ title });
      if (terminal) resetPending = true;

      if (resetPending && lastPhase !== 'error') {
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        shown = target = 0;
        resetPending = false;
      }

      if (lastPhase === 'error') {
        ui.update({ stage: nextStage, state: 'error', progress: shown, detail: lastDetail, bytes: '' });
        return;
      }
      if (lastPhase === 'done') {
        target = Math.max(target, 100);
        if (frame) { cancelAnimationFrame(frame); frame = 0; }
        paint(100, nextStage);
        ui.update({ stage: 'initialize', state: 'done', progress: 100, detail: lastDetail, bytes: '' });
        return;
      }
      if (Number.isFinite(value)) animateTo(value, nextStage);
      else ui.update({ progress: target, stage: nextStage, state: lastPhase, detail: lastDetail, bytes: lastBytes });
    },

    /** 未知总量：不给假百分比，组件自己居中弹跳。 */
    unknown({ stage = 'initialize', detail = '' } = {}) {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      shown = target = 0;
      lastPhase = 'running';
      lastDetail = detail;
      lastBytes = '';
      overlay.hidden = false;
      ui.update({ progress: null, stage, state: 'running', detail, bytes: '' });
    },

    /** 等待别人不是加载：满格 + 文案。 */
    waiting({ detail = '', stage = 'initialize' } = {}) {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      shown = target = 100;
      lastPhase = 'running';
      lastDetail = detail;
      lastBytes = '';
      overlay.hidden = false;
      ui.update({ progress: 100, stage, state: 'running', detail, bytes: '' });
    },

    error({ title = '加载遇到问题', detail = '' } = {}) {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      lastPhase = 'error';
      lastDetail = detail;
      lastBytes = '';
      overlay.hidden = false;
      ui.update({ stage: 'download', state: 'error', progress: shown, detail, bytes: '' });
    },

    hide() {
      overlay.hidden = true;
    },

    /** 重新开始一次完整加载：数字归零重新数。 */
    reset() {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      shown = target = 0;
      resetPending = false;
      lastPhase = 'running';
      paint(0, 'download');
    },

    setMotion(enabled) {
      ui.setMotion(!!enabled);
    },

    destroy() {
      if (frame) { cancelAnimationFrame(frame); frame = 0; }
      ui.destroy();
      overlay.remove();
    },
  };
}

/** 距离某阶段还剩多少的预算，给只能报阶段、没有字节的业务用。 */
export const PHASE_BUDGET = Object.freeze({
  connect: 4,
  cache: 10,
  download: 12,
  verify: 72,
  initialize: 80,
  ready: 96,
});