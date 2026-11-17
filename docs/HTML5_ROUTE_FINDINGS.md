# HTML5 版实机验证：比 Flash 路线更适合自建联机

验证日期：2026-11-17。执行环境同 `docs/LOCAL_AGENT_FINDINGS.md`。

---

## 结论

本地已有的 **HTML5 重制版（1–6 部）全部可以在 `127.0.0.1` 上完整运行**，
不受任何发行站点绑定限制，也不需要 Ruffle 或 Flash。

这是目前**唯一被实测证明能进入关卡并操作双角色**的冰火人运行形态，
应当取代 Flash 路线成为联机适配的主线。

| 版本 | 标题 | 加载 | 错误 |
| --- | --- | --- | --- |
| 1 森林神殿 | Fireboy & Watergirl in The Forest Temple | 通过 | 3 条 `h5api is not defined`（无害） |
| 2 光之神殿 | …The Light Temple | 通过 | 同上 |
| 3 冰之神殿 | …The Ice Temple | 通过 | 同上 |
| 4 水晶神殿 | …The Crystal Temple | 通过 | 同上 |
| 5 元素 | Fireboy & Watergirl Elements | 通过 | 无 |
| 6 童话 | Fireboy & Watergirl 6 Fairy Tales | 通过 | 无 |

`h5api` 是 Coolmath/Kizi 的宿主平台 JS SDK，抓包时未一并取得。
它只影响排行榜与统计上报，**不影响玩法**，也不需要伪造。

---

## 实测步骤与结果（第一代）

在 `02-fireboy-watergirl/html5-online/` 起静态服务（`python -m http.server 8801 --bind 127.0.0.1`）后：

| 步骤 | 观察 |
| --- | --- |
| 打开 `games/1-forest-temple/index.html` | Kizi 标志、`Fireboy & Watergirl in The Forest Temple` 标题、`开始游戏` 按钮、火娃/水娃立绘 |
| 点击「开始游戏」 | 进入 32 关的节点式选关地图，底部当前关高亮，含 `返回` / `显示关卡数` |
| 直接点关卡 | 提示「这个级别尚不可用，完成更多关卡解锁」——**关卡被进度锁住** |
| 注入解锁开关后点关卡 | **进入关卡**：绿色砖墙地形、火娃左上、水娃右上、红/蓝钻石、三个链条按钮机关、底部熔岩/水池/酸液、左右两扇出口门、顶部计时 00:05 |
| 按 `ArrowRight` 再按 `D` | 火娃与水平分别移动，位置变化可从截图确认 |

### 内置开关（源码位置）

`games/1-forest-temple/js/game.js:51、69–70`：

```js
var storagePrefix = 'fb-forest';
GameConfig.cheating.isInvulnerable = !!localStorage.getItem(storagePrefix + ':invulnerable');
GameConfig.cheating.isFullUnlock   = !!localStorage.getItem(storagePrefix + ':unlock');
```

注入 `localStorage['fb-forest:unlock'] = '1'` 即全解锁；
`fb-forest:invulnerable` 为无敌。各代前缀：

| 部 | storagePrefix |
| --- | --- |
| 1 | `fb-forest` |
| 2 | `fb-light` |
| 3 | `fb-ice` |
| 4 | `fb-crystal` |
| 5 | `fb-elements` |
| 6 | 未使用该前缀（`game.js` 为合并压缩版，结构不同） |

这是游戏**自己提供的调试开关**，不是破解；用它解锁关卡不修改任何游戏文件。

---

## 与 Flash 路线的对比

| 维度 | Flash 原版（Ruffle） | HTML5 重制版 |
| --- | --- | --- |
| 冰火人能否在 `127.0.0.1` 运行 | **不能**，`AGdom` 站点绑定 | **能**，已实测进关卡 |
| 闪翼正传能否运行 | **不能**，4399 平台模块 + 链式加载 | 无对应版本 |
| 是否需要 Ruffle | 需要 | 不需要 |
| 代码可读性 | 反编译 AS3，变量名完整 | 压缩 JS（`game.js` 单文件，1–2 MB） |
| 可修改性 | 需改字节码（ABC） | 可直接改 JS / 运行时注入 |
| 服务端成本 | 每房间一个 Chromium + Ruffle | 纯 JS，可 Node 内直接跑逻辑 |
| 素材完整性 | 内嵌，已验证 | 完整（含 tileset 与关卡 JSON） |

**关键差异**：Flash 路线的两个阻塞（站点绑定、平台模块）都**不是靠补文件能解决的**；
HTML5 路线没有这类问题，代价是要在压缩 JS 上做适配。

---

## 对后续联机适配的影响

1. **主线应切到 HTML5**：输入点、主循环、碰撞都在 JS 里，可以直接 hook，
   不必再和 4399 的加壳、`fw` 的链式加载打交道。
2. **服务端可以不用 Chromium**：HTML5 版的物理与规则是纯 JS，
   理论上可以抽到 Node 里跑权威逻辑，省掉每房间一个浏览器进程。
   这一步需要先确认 `game.js` 是否依赖 DOM/Canvas 才能推进 —— **尚未验证**。
3. **输入语义仍按 `docs/INPUT_AND_CLOCK_CONTRACT.md`**：火娃方向键、水娃 WASD，
   持续按住与边沿都要保留。HTML5 版的按键处理需要单独定位（尚未做）。
4. **关卡数据可直接读**：`games/<n>/data/**/*.json` 是 Tiled 风格，
   含 `Ground/Chars/Objects` 层，但 tileset 语义仍需对照运行代码确认，
   不能按 GID 数字猜。

### 仍需验证的项

- [x] `game.js` 是否能在 Node 中脱离 DOM 运行（**已测，结论见下节**）
- [ ] 输入读取点与主循环位置（决定 hook 点）
- [ ] 关卡数据与运行逻辑的对应（GID → 碰撞/机关语义）
- [ ] 6 部的 `game.js` 结构差异（5/6 与 1–4 不同）
- [ ] 音频、动画、机关状态能否进快照

---

## 能否脱离 DOM 在 Node 里跑：不能，但也不需要 Ruffle

### 实测的阻塞链

直接 `require('js/game.js')`，按顺序撞到：

| 步骤 | 错误 | 位置 |
| --- | --- | --- |
| 1 | `ReferenceError: localStorage is not defined` | `game.js:69`（读取作弊开关） |
| 2 | 补 `localStorage` 后 → `ReferenceError: window is not defined` | `game.js:54`，`startGame()` 在顶层被调用 |
| 3 | 后续待撞：jQuery 的 `$`、require.js 的 `define`、Phaser 的 canvas/WebGL | 静态分析确认 |

`game.js` 在 IIFE 之前就有顶层执行（`GameConfig` 赋值、`startGame()` 调用），
所以不是"加一层沙箱就能隔离"的结构。

### 静态分析给出的依赖面

| 项目 | 实际值 | 影响 |
| --- | --- | --- |
| 入口 | `index.html` 用 `require.js`，`data-main="js/game.js"` | AMD 而非 CommonJS |
| AMD 模块数 | 164 个 | 需完整 require 环境 |
| 渲染器 | `new h.Game({renderer: h.AUTO, …})` | 自动选 WebGL / Canvas |
| 渲染模式常量 | 只有 `WEBGL_RENDERER = 0`、`CANVAS_RENDERER = 1` | **这个裁剪版没有 `HEADLESS`（3）** |
| DOM 依赖 | `window.innerWidth`、`devicePixelRatio`、`document.` 114 处、`canvas` 170 处、`WebGL` 160 处 | 强耦合 |
| jQuery | `$(window).width()`、`$.ajaxSetup` | 需 jQuery |
| 页面事件 | `window.onblur` / `onfocus` / `onpagehide` / `onpageshow` | 依赖页面生命周期 |
| 状态暴露 | 游戏实例在 IIFE 内，`window` 上只有 `Devices`/`URL`/`requestAnimationFrame` 等 | **外部无法读游戏状态** |

### 一个积极发现：物理引擎是纯 JS

164 个 AMD 模块里包含完整的 **p2.js**（`../objects/Body`、`../math/vec2`、`../collision/AABB`、
`../constraints/*`、`../equations/*`）。p2.js 不依赖 DOM。

这意味着"只跑权威逻辑"在原理上可行，但要把玩法逻辑从 Phaser 的 state 里剥出来，
工作量远大于直接跑浏览器。

### 结论与成本排序

| 方案 | 可行性 | 成本 |
| --- | --- | --- |
| **Chromium 跑原生 JS（推荐）** | 已验证（本文件上面的实测） | 每房间一个 browser context，**但不需要 Ruffle 模拟 Flash/AS3**，明显轻于原方案 |
| 剥离 p2.js 逻辑做纯 Node 权威端 | 原理可行 | 大：需拆 Phaser state、重建关卡与机关、对齐手感 |
| 在 Node 里重建浏览器环境 | 不推荐 | 极高：localStorage → window → jQuery → require → canvas/WebGL 逐层补桩，最后仍要软件渲染 |

**对项目决策的含义**：服务端仍然需要浏览器进程，但这条路的"浏览器"跑的是原生 JS，
不需要 Flash 运行时，启动与 CPU 开销都低于 Ruffle 权威宿主。
若长期要省掉浏览器，方向是第二条（剥离 p2.js），而不是第三条。

---

## 复现

```bash
# 1. 起静态服务（只监听本机）
cd 02-fireboy-watergirl/html5-online
python -m http.server 8801 --bind 127.0.0.1

# 2. 浏览器打开
#    http://127.0.0.1:8801/games/1-forest-temple/index.html
#    控制台执行解锁后再点关卡：
#    localStorage.setItem('fb-forest:unlock','1'); location.reload();
```

HTML5 版是本地材料，**不进公开仓库**（版权归 Oslo Albet，抓包所得）。
本仓库只记录验证方法、开关位置与结论。

## 版权与合规

这不是授权版本。它是 Coolmath/Kizi 托管的官方 HTML5 重制版，
版权仍归原作者，抓包部署属于保存/研究用途。
自建对外提供服务前仍需取得发行方许可；
本文只陈述"技术上能否运行"，不构成分发授权。
