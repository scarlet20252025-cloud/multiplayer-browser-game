**2026-11-17 死亡处理阶段更新：** [原生重开、自然死亡和双浏览器事件验收](HTML5_NATIVE_RETRY.md) 已通过；双人自动复活的新关卡重新握手尚未开发，旧输入当前正确地被锁定。

最新的原生重开入口与旧席位隔离请先看 [HTML5_NATIVE_RETRY.md](HTML5_NATIVE_RETRY.md)：已验证 native retry 重建 epoch 和拒绝旧输入；双浏览器自动恢复未完成。

**最新进度（2026-11-17）：** 第 52 关按钮按下/复位、平台升降、实际推箱子、双浏览器箱子最终收敛，已通过两次真实 CI。详见 [HTML5_BOX_PUSH.md](HTML5_BOX_PUSH.md)；后续优先补完整通关/死亡重开及用户上传原包的私有环境实测，先前静态交接中的待办仅供历史追踪。

最新实测补充：**[HTML5_BOX_PUSH.md](HTML5_BOX_PUSH.md)** 记录了真实按钮、联动平台和推箱子的两浏览器显示证据；来源为固定研究候选，不是用户原包完成。

> **最新续接说明（2026-11-17）**：本文件的“3 项待做”已被后续实验完成，不能继续当作当前待办。请先阅读 [HTML5_VISUAL_SYNC_STATUS.md](HTML5_VISUAL_SYNC_STATUS.md)：该文档包含三实例实测、箱子补充、权限与后续验收。以下内容作为原始技术交接和历史事实保留。

# 交接给下一个 Agent：森林冰火人 HTML5 版联机适配

更新：2026-11-17　分支 `work/flash-netplay-lab`　基线提交 `193d87d`

**这份文档不依赖任何聊天记录。** 读完它应当能直接接手，不需要重新踩一遍已经排除的路线。

> 2026-11-17 本轮接续：三项任务的实际源码定位和原创适配工具已写入仓库，详见 [HTML5_ADAPTATION_REPORT.md](HTML5_ADAPTATION_REPORT.md)。当前容器浏览器被环境限制；已增加独立 CI 真实运行脚本，结果产生前不记实机 passed。以下既有结论与交接背景保留；以新增报告的最新验证状态判断三项是否已完成。

---

## 0. 现在的状态

**技术障碍已经解决，卡点不在技术上。**

冰火人 HTML5 版可以本地运行、可以进关卡、**输入桥已实机验证**（只写 `isDown` 就能驱动角色，两个角色互相隔离）。剩下的是三件具体的验证与适配工作，见第 3 节。

**方向已经切换**：不要再走 Flash 原版路线。那条路的两个阻塞（发行站点绑定、4399 平台模块）都补文件解决不了，已经证伪。

---

## 1. 仓库里有什么

| 文档 | 内容 |
| --- | --- |
| `docs/LOCAL_AGENT_HANDOFF.md` | 上一轮的任务书（补材料、跑基准）。**已完成，不要重做** |
| `docs/LOCAL_AGENT_FINDINGS.md` | 上一轮的结论：材料核对、两款 Flash 原包的基准结果、探针复现 |
| `docs/ORIGINAL_GAME_MATERIALS.md` | 原包放置方式、入口、依赖、重建条件 |
| `docs/HTML5_ROUTE_FINDINGS.md` | **本次重点**：HTML5 版实测、Node 可运行性、输入路径、输入桥验证 |
| `docs/ARCHITECTURE_DECISION.md` | 官方权威/非视频同步路线与取舍 |
| `docs/INPUT_AND_CLOCK_CONTRACT.md` | 输入与时钟契约（跨引擎通用，HTML5 版也适用） |
| `evidence/original-games/manifest.json` | 原包逐文件哈希与可用性 |
| `evidence/original-games/baseline-results.json` | 原包基准的逐项状态 |

工具：

| 脚本 | 用途 |
| --- | --- |
| `scripts/original-game-host.mjs` | 原包本地基准宿主（只监听 127.0.0.1，防越界） |
| `scripts/verify-original-baseline.mjs` | Playwright 自动基准，输出 JSON + 截图 |
| `scripts/inspect_swf.py` | SWF 包头/标签/AVM 类型检查 |
| `scripts/merge_shanyi_kernel.py` | 闪翼代码包+资源包合并（已验证：结构正确但缺调度器） |
| `scripts/build_material_manifests.py` | 生成两份清单 |

---

## 2. 已验证的事实（**直接采信，不要重复验证**）

| # | 结论 | 证据 | 怎么验证的 |
| --- | --- | --- | --- |
| 1 | 冰火人 **Flash** 原版在本地**跑不起来** | `LOCAL_AGENT_FINDINGS.md` §2 | 三个发行版本都卡在预加载；`AGdom.initDomain()` 只在 loaderURL 含 `addictinggames.com`/`shockwave.com` 时才调 `getServer()` |
| 2 | 闪翼正传原包直接放浏览器**跑不起来**（结论仍有效） | `LOCAL_AGENT_FINDINGS.md` §3、`SHANYI_SOURCE_AUDIT.md` §7 | 外壳请求 `cdn.comment.4399pk.com` 被 CORS 拦 |
| 3 | 闪翼 `core_3`+`core_4` **静态合并不可行** | 同上 §3.3 | 三种合并方案都试过，纯白；根因是四段式链式加载，缺 `fw` 调度器 |
| 3a | 不改原包的自写 AS3 外壳可在 Ruffle nightly 中载入 `core_4_abc.swf` 并进入第一关 | `SHANYI_SOURCE_AUDIT.md` §8 | 外壳 `adapters/shanyi-flash/src/ShanyiHost.as`；wgpu + `maxExecutionDuration:600`；实验性输入镜像已接入大厅 |
| 4 | 冰火人 **HTML5 版 6 部全部可运行** | `HTML5_ROUTE_FINDINGS.md` | 2/3/4/5/6 均出 canvas 且标题正确；1–4 仅缺 `h5api`（不影响玩法） |
| 5 | HTML5 第一代**能进关卡**，32 关选关可用 | 同上 | 主菜单 → 选关 → 解锁 → 进关卡，截图可查 |
| 6 | **输入桥成立**：只写 `cursors.left/right.isDown` 就能驱动角色 | 同上「输入桥实机验证」 | 不按任何键，水娃 1184→894→1156，火娃全程 `x=64` 不动 |
| 7 | 两个角色天然对应两个席位 | 同上 | `level.pers1`(fb) / `level.pers2`(wg) |
| 8 | 物理是 **Box2D**（不是 p2.js） | 同上 | `startSystem(Phaser.Physics.BOX2D)`、`PTMRatio=32`、`world.Step` |
| 9 | `game.js` **不能**脱离 DOM 在 Node 跑 | 同上 | `localStorage` → `window` → jQuery/require/canvas 逐层阻塞；Phaser 无 HEADLESS 模式 |
| 10 | 输入契约跨引擎通用 | 对比两份审计 | HTML5 的 `prohibitJump` 与 Flash 的 `u_pressed`+`prohibjt` 语义一致 |

**探针现状**：`npm test` 0、`check:utf8` 0、`test:network` 8/8、`test:e2e` 13/13 通过；`test:python` 12/13 —— 那 1 项失败是仓库自身的 Windows 换行缺陷（`Path.write_text` 转 CRLF 但断言用原始字符串哈希），已定位未修。

---

## 3. 待做（按优先级）

### 3.1 跳跃边沿（快，半小时）

**要回答**：`prohibitJump` 的"按下锁存、松手清除"在真机是否成立。

**已知**（静态阅读 `game.js:43124-43125`）：

```js
this.prohibitJump && !this.cursors.up.isDown && (this.prohibitJump = !1),
!this.prohibitJump && this.cursors.up.isDown && (地面条件)
```

**做法**：在副本里设 `pers2.cursors.up.isDown = true` 持续 2 秒，看是否只跳一次；再置 false 后重新置 true，看是否第二次跳。记录 `body.y` 变化。

**验收**：能区分"按住只跳一次"和"按住连跳"。

### 3.2 暂停键拦截（快，半小时）

**要回答**：`P` 键暂停是本地行为，联机时必须改成房间命令。

**已知**（`game.js:44830`）：`pauseKey = this.game.input.keyboard.addKey(Phaser.Keyboard.P)`，`onDown.add(this.togglePause)`。

**做法**：确认 `togglePause` 是否只改本地状态、是否影响物理 `paused`。把 `pauseKey.onDown` 解绑或替换成向房间发命令的接口。

**验收**：客户端按 P 不再自行暂停，而是请求服务端。

### 3.3 状态导出（重，是客户端显示分离的前置）

**要回答**：一帧里能读到哪些玩法状态。

**已知**：
- 角色位置：`pers1.body.x/y`、`pers2.body.y`
- 钻石：`createCharObjects` 里 `new Devices.Diamond(...)`（`game.js:45029`），未探实例位置
- 门：`this.door1` / `this.door2`（`game.js:45027-45028`），通关依赖门的动画帧
- 机关：`this.game.MechManager = new k(this.game)`（`game.js:44812`）
- 无敌/全解锁：`GameConfig.cheating.*`

**做法**：遍历 `level` 与 `MechManager`，找出钻石、门、杠杆、按钮、平台的实例容器；记录每类的状态字段（位置/可见/动画帧/是否激活）。

**验收**：能输出一份包含"角色 + 钻石 + 门 + 至少一种机关"的 JSON 快照，且两次连续快照可比较。

### 3.4 其余（低优先）

- 6 部 `game.js` 结构差异（5/6 与 1–4 不同，5/6 无 `storagePrefix`）
- 音频、动画状态能否进快照
- `game.js` 是否依赖 Canvas 才能推进逻辑（决定能否只跑逻辑）

---

## 4. 关键代码位置速查（`games/1-forest-temple/js/game.js`）

| 项 | 行号 | 说明 |
| --- | --- | --- |
| 解锁/无敌开关 | 69–70 | `localStorage['fb-forest:unlock']` / `:invulnerable` |
| 存储前缀 | 51 | `fb-forest`；各代为 `fb-light` / `fb-ice` / `fb-crystal` / `fb-elements`，6 部无此前缀 |
| 游戏实例创建 | 54053 | `(o = new h.Game(m)),` —— 注入点 |
| 渲染配置 | 54029–54042 | `renderer: h.AUTO`、`parent:"container"` |
| 物理初始化 | 44800 附近 | `startSystem(BOX2D)`、`setPTMRatio(32)`、`gravity.y=1e3`、`paused=true` |
| 物理步进重写 | 44840 附近 | `update = function(){ … world.Step(min(0.04, elapsed/1000)) }` |
| 角色创建 | 45016–45030 | `pers1`=fb、`pers2`=wg、`door1`/`door2` |
| 按键注册 | 42786–42788 | `CharCursors`：fb 触屏 / wg WASD / 默认方向键 |
| 输入消费 | 43071–43181 | `character.update()` 读 `cursors.*.isDown` |
| 跳跃锁存 | 43124–43125 | `prohibitJump` |
| 暂停键 | 44830 | `addKey(P)` → `togglePause` |

---

## 5. 本地材料（**不在仓库里**）

仓库只存代码、文档、证据，原包一律不进（版权）。以下在用户机器上：

```
E:\肥鱼不乐园\flash-archive\
├── 02-fireboy-watergirl\html5-online\      60 MB，HTML5 版 1–6 部（本次主线）
│   └── games\<n>-<name>\js\game.js         每部一个 2.2 MB 脚本
├── 02-fireboy-watergirl\flash-original\    7 个原版 SWF（Flash 路线，已放弃）
├── 01-shanyi-binary\                       闪翼双星正传 + 续作 + 脱壳产物
└── _tools\                                 FFDec 26.5.0、Ruffle 0.7.1
```

**如果拿不到这些材料**：能读文档、能改仓库代码、能写适配器，但**跑不了任何实机验证**。
需要用户提供 `html5-online` 目录（或整个 `flash-archive`）。

**注意**：`html5-online` 里的 `game.js` 是**带注释的版本**（不是压缩混淆版），
变量名压缩但结构与注释保留，可读性尚可。

---

## 6. 复现环境

```bash
# 依赖
npm ci
npx playwright install chromium-headless-shell

# 起 HTML5 版静态服务（只需本机）
cd <本地>/html5-online
python -m http.server 8801 --bind 127.0.0.1

# 浏览器打开
#   http://127.0.0.1:8801/games/1-forest-temple/index.html
# 控制台解锁关卡：
#   localStorage.setItem('fb-forest:unlock','1'); location.reload();
```

**注入实例**（在副本里改，原文件不动）：

```bash
cp -r html5-online local/html5-inject
# 把 (o = new h.Game(m)), 改成 (o = window.__game = new h.Game(m)),
```

之后 `window.__game.level.pers1/pers2` 即可访问。

---

## 7. 已经踩过的坑（别再踩）

1. **不要试图用 Ruffle 跑冰火人 Flash 版**——`AGdom` 的站点绑定不是补文件能解决的。
2. **不要试图合并闪翼 `core_3`+`core_4`**——已验证失败，缺 `fw` 调度器，只能改字节码。
3. **不要在 Node 里跑 `game.js`**——`localStorage`→`window`→jQuery→require→canvas 逐层阻塞，最后要软件渲染。
4. **FFDec 的 `-export image/shape/sound` 遇到巨型嵌套 DefineSprite 会静默返回 0 个文件**，不报错。需要先扁平化。
5. **HTTP 404 不算 Playwright 的 `requestfailed`**，要单独监听 `response`，否则会漏掉游戏缺资源。
6. **Ruffle 的 canvas 在 shadow DOM 里**，`page.evaluate` 里手写递归查不到，用 `page.locator('canvas')`。
7. **`Path.write_text()` 在 Windows 会把 `\n` 转 CRLF**，导致 `test:python` 那 1 项失败。
8. **git 没配 user.name/email 时 commit 失败**；仓库既有作者是 `Asryto <scarlet20252025@gmail.com>`，用 `git -c user.name=… -c user.email=…` 临时指定。
9. **`gh` 的 token 失效但 HTTPS push 是通的**（凭据管理器里有 `git:https://github.com`）。判断能否推，用 `git push --dry-run` 比看 `gh auth status` 准。

---

## 8. 边界（不要做的事）

- **不要声称这是"授权版本"**。它是 Coolmath/Kizi 托管的官方 HTML5 重制版，版权仍归 Oslo Albet，抓包部署属保存/研究用途。自建对外服务前仍需发行方许可。
- **不要把 `html5-online`、SWF、原包任何文件提交进仓库**。`.gitignore` 已挡 `local/`、`private-games/`、`*.zip`。
- **不要为了"通过"去删站点绑定、伪造 hosts、改报告**。已经因为这条放弃了 Flash 路线，结论是诚实的。
- **不要直接 force push**，不要合并 PR #1，保持 Draft。
- **不要用改后的副本冒充原包基准**。原包基准必须用未修改的文件。

---

## 9. 一句话给下一个 Agent

主线是 **HTML5 版**，输入桥已验证，接着把**跳跃边沿、暂停拦截、状态导出**三件事做完；
Flash 路线已证伪，不要回头。
