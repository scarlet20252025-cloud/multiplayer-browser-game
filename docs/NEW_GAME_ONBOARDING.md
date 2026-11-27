# 新游戏的联机接入蓝图

状态：2026-11-28。本文把《Q版泡泡堂 7》跑通的那条路整理成可照抄的流程。新游戏从第 0 步开始做，不要跳步；每一步都有可检查的产物。

配套阅读：[通用适配契约](GAME_ADAPTER_CONTRACT.md)（manifest 字段与校验规则）、[联机工程总结](NETPLAY_ENGINEERING_GUIDE.md)（各同步方式的取舍）、[网站设计流程](WEBSITE_DESIGN_WORKFLOW.md)（页面、组件、进度条）。

## 0. 先选同步方式，再写一行代码

| 游戏特征 | 选这个 | 已验证案例 | 代价 |
| --- | --- | --- | --- |
| 原版 Flash/AS3，逻辑确定性可复现，能读到状态摘要 | 逻辑帧同步（`browser-lockstep` / `lockstep-match.mjs`） | 泡泡堂 7、死神 vs 火影 | 需要可重复初始化的地图、种子和计时；检查点必须能导出 |
| 原版 Flash，只能控制输入、无法导出状态 | 双端输入镜像（`flash-mirror`） | 闪翼双星 | 两端会分叉，只能算实验功能 |
| 原版 Phaser/Box2D，物理难以跨浏览器复现 | 单实例权威 + 状态投影（`html5-phaser`） | 森林冰火人 1–4 | 服务器要跑 Chromium；快照要覆盖动态实体 |
| 规则自己写、可服务端模拟 | 服务端权威模拟（`tank-arena` / `platform-brawl`，两者共用同一套权威策略） | 迷宫坦克、云台乱斗 | 规则和画面都要自己实现 |
| 自带服务端（Colyseus/WebSocket） | 外部权威（`html5-external`） | — | 大厅只发房间码和席位 |

判断口诀：**能拿到可信状态就用帧同步，拿不到才退回输入镜像；物理复杂就别硬做帧同步。**

## 1. 先证明「原版能在浏览器里跑」

在任何联机代码之前，先得到一个可复现的本地基线：

- 记录游戏文件哈希、版本、来源；原包放 `local/`、`private-games/`，永不入库。
- 用 `scripts/original-game-host.mjs` 起一个只监听 `127.0.0.1` 的宿主，确认首屏、进关、输入。
- 用 `scripts/verify-original-baseline.mjs` 生成 JSON + 截图。要求 `load.status === 'loaded'`（否则脚本退出码为 1），并且 `checks[]` 里没有 `failed` / `blocked`，才能往下写。
- 需要改原包时，只在**内存副本**里打补丁，并且补丁必须校验 SHA-256；磁盘上的原包保持只读。

产物：`docs/<GAME>_ORIGINAL_BASELINE.md` 一份，写清版本、哈希、能做什么、不能做什么。

## 2. 声明 manifest，让大厅认识它

在 `config/games/<id>.json` 写 v1 manifest。字段含义以 [适配契约](GAME_ADAPTER_CONTRACT.md) 为准，容易踩的点：

- `runtime` 决定 `online` 的取值和必需能力，写错会直接启动失败。
- `capabilities` 是声明不是实现：没实现的能力一律不写 `true`。
- `seats` / `minSeats` 决定大厅卡片和开局条件；对战类至少 2 人。
- `package` 里所有路径必须是相对路径，`tickRate` 只有帧同步需要。
- 新增 adapter 必须同时登记进 `server/game-adapter.mjs` 的 `SUPPORTED_ADAPTERS`，否则报 `adapter is not installed`。

校验：

```bash
node --input-type=module -e "import {loadGameRegistry} from './server/game-adapter.mjs'; \
  console.log((await loadGameRegistry({gamesDir:'config/games',researchDir:'config/research-games'})).playable.map(g=>g.id))"
node --test tests/game-adapter.test.mjs tests/game-probe.test.mjs tests/game-catalog-manifests.test.mjs
```

## 3. 房间层：照抄泡泡堂的六条

1. **席位令牌**：进房时发一个只在当前标签页有效的 token，刷新用它恢复原席位，昵称只用于显示。
2. **准备是「目标值 + 服务端确认」**：按钮发本席位想要的布尔值，收到广播再改 UI；重复提交同一值结果一致。
3. **改自己的选项就取消自己的准备**：换角色、换装扮、换地图、换模式都算，避免「已准备但配置已变」。
4. **规则版本号**：房主改地图/模式时递增，旧版本的准备请求直接拒绝，全员重新确认。
5. **20 秒重连窗口**：断线保留席位并暂停开局；超时才释放。刷新恰好撞上开局，要把同一场的对局地址补发给恢复的席位。时长按游戏可调，迷宫坦克与云台乱斗目前是 45 秒。
6. **房主超时转移**：按在线席位序号最小者接任，接任者继续管地图和模式。

产物：`server/<game>-room.mjs`（或复用 `room-lobby.mjs` 的通用房间）+ `tests/<game>-room.test.mjs`，覆盖上面六条。

## 4. 对局层：三件事必须先做对

- **输入归属**：服务端用席位凭据判断「这个输入是谁的」，再检查序号、角色归属和当前阶段。按下和松开可能落在同一逻辑帧，短按要用边沿保留。
- **失焦与断线清理**：`blur`、`visibilitychange`、WebSocket 关闭时立刻把持续输入清零，否则角色会一直往前走。
- **可重放**：开局要有确定的种子/规则/装扮/空白存档；重连时先补状态再继续，超出历史范围就明确结束，不要在分叉状态上硬撑。

帧同步的最小验收：两个客户端从同一帧开始，各按各的键，跑到第 180 帧时检查点摘要一致；强制断开一端，20 秒内恢复后还能追平。

## 5. 页面层：五个文件起步

| 文件 | 作用 | 从哪抄 |
| --- | --- | --- |
| `public/<game>/index.html` | 页面壳 + 启动遮罩 + 百分比 | `public/tank-arena/index.html` |
| `public/<game>/<game>.mjs` | 连接、输入、渲染循环 | `public/lockstep/client.mjs` |
| `public/<game>/rules.mjs` | 常量与模式定义，服务端也 import 这一份 | `public/tank-arena/rules.mjs` |
| 加载遮罩 | 标题 + 说明 + 百分比 + 进度条 | `public/lockstep/loading.mjs` |
| 大厅卡片文案 | 标题、副标题、人数、封面 | `public/lobby/lobby.mjs` 的 `GAME_STYLE` |

页面必须包含的四个状态：加载中（带真实百分比）、等待其他玩家（100% + 流光）、对局中、结算/返回。移动端至少检查 390px 宽和触屏横屏。

## 6. 进度条不要另写一套

按 [网站设计流程第 7 节](WEBSITE_DESIGN_WORKFLOW.md#7-加载与进度条规范) 的百分比规则实现：

- 有字节按字节，没有字节按阶段预算，只有块数按块数，什么都没有就慢爬到 92% 等就绪。
- 数字必须动：`requestAnimationFrame` + 420ms 缓动；进度条宽度用 CSS transition。
- 只增不减；等待和重连不再爬。
- 必须有 `role="progressbar"` 和 `aria-valuenow`。

## 7. 验收脚本与证据

新游戏至少交四个脚本，命名沿用现有习惯：

| 脚本 | 证明什么 |
| --- | --- |
| `scripts/verify-<game>-room.mjs` | 建房 → 选角/选图 → 准备 → 开局 → 结算 → 再开 |
| `scripts/verify-<game>-sync.mjs` | 双端输入、检查点一致、失步终止 |
| `scripts/verify-<game>-reconnect.mjs` | 断线 20 秒内恢复、刷新后仍是原席位 |
| `scripts/verify-<game>-cache.mjs` | 二次进入不重复下载大资源 |

证据要求：写清构建版本、入口（回环/局域网/公网）、设备与视口、参与人数、实际结果和失败点。回环通过不等于公网通过，静止画面不等于移动画面。

## 8. 上线前检查表

- [ ] manifest 通过注册表校验，`/api/games` 能看到它
- [ ] 大厅卡片有封面或主题色兜底，人数和最低开局人数正确
- [ ] 建房、加入、密码错误、房间已满、席位恢复各有明确提示
- [ ] 加载页有百分比并且能重试；资源 404 时不会白屏
- [ ] 两人（或实际人数）从真实入口完成一局，含一次刷新和一次断线
- [ ] 结算后能再开一局，旧回合的输入不会漏进新局
- [ ] `npm test` 全绿；新增测试覆盖房间、输入、重连
- [ ] 文档：本游戏的 `docs/<GAME>_*.md`、README 导航、`GAME_ADAPTER_CONTRACT` 注册表

## 9. 已经踩过的坑

1. **别把「原版能跑」当成「能联机」**：Flash 站点绑定、4399 外壳、`loadBytes` 链式加载都补文件解决不了。
2. **别在 Node 里跑 `game.js`**：`localStorage` → `window` → jQuery → canvas 逐层阻塞。
3. **别信 UI 上的「加载完成」**：要等原版菜单、暂停面板、地图结构实际就绪再放行。
4. **别只测静止画面**：相机移动、特效密集和多窗口才是真实帧率。
5. **别把未实现的 capability 写成 true**：大厅会按声明放行，玩家看到的是坏掉的按钮。
6. **别 commit 原包、截图封面、构建缓存**：`.gitignore` 已经挡了大部分，新增第三方素材时手动确认。
