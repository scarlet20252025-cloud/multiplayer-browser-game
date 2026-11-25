# 通用游戏适配契约（Game Adapter Contract）

状态：2026-11-18 已实现并接入本机大厅；回归测试覆盖 manifest、探测器和目录加载。

目标：让大厅、房间、投票、存档只依赖一份声明式 manifest，不再硬编码某一款游戏。新游戏通过适配器接入；无法满足运行时条件的包只能进入研究注册表，并由机器可读的 blocker 说明原因。

## 1. 运行时分层

运行时策略定义在 `server/game-adapter.mjs` 的 `RUNTIME_POLICY`，代码是唯一事实来源。

| runtime | 可联机 | 必需能力 | 默认结论 |
| --- | --- | --- | --- |
| `html5-phaser` | 是（权威/观看） | `authority` `spectator` `levelVote` `restartVote` `returnVote` | 通过探测后可进入大厅 |
| `html5-external` | 是（外部权威服务） | `authority` `levelVote` `restartVote` `returnVote` | 自带 Colyseus/WebSocket 服务；大厅只分配房间码和按席位入口 |
| `browser-lockstep` | 是（双人帧同步） | `lockstep` `levelVote` | 私有构建通过确定性步进接口接入大厅 |
| `flash-ruffle` | 是（仅输入镜像） | `mirrorInput` | 需已审计 wrapper + 本地 Ruffle；实验标签 |
| `flash-native` | 否 | — | blocker：`NO_BROWSER_RUNTIME` |

`flash-ruffle` 只允许 `flash-mirror` 适配器：两名玩家各自在本机标签页运行同一份 SWF，回环 WS 转发键盘/点击/在线状态，并以约 30Hz 交换各自英雄的位置与速度用于对端纠偏；不存在服务器权威状态、完整快照或画面传输。它不能声明 `authority` 或 `spectator`；`save` 可选。
`flash-native` 只允许作为研究对象；桌面 Flash projector 可运行不等于浏览器大厅可运行。

## 2. Manifest v1

可联机示例（`config/games/forest.json`）：

```json
{
  "schemaVersion": 1,
  "id": "forest",
  "title": "森林神庙",
  "subtitle": "Forest Temple",
  "runtime": "html5-phaser",
  "adapter": "fireboy-html5",
  "order": 1,
  "online": true,
  "capabilities": {
    "authority": true,
    "spectator": true,
    "levelVote": true,
    "restartVote": true,
    "returnVote": true,
    "save": true
  },
  "package": {
    "dir": "1-forest-temple",
    "entry": "index.html",
    "levels": "data/forest/temple.json",
    "templeId": "forest",
    "storagePrefix": "fb-forest"
  },
  "evidence": ["docs/HTML5_ROUTE_FINDINGS.md", "docs/INPUT_AND_CLOCK_CONTRACT.md"]
}
```

Flash 输入镜像示例（`config/games/shanyi.json`）：

```json
{
  "schemaVersion": 1,
  "id": "shanyi",
  "title": "闪翼双星",
  "runtime": "flash-ruffle",
  "adapter": "flash-mirror",
  "online": true,
  "capabilities": {"mirrorInput": true},
  "package": {
    "dir": "shanyi", "entry": "index.html", "levels": "levels.json",
    "templeId": "shanyi", "storagePrefix": "shanyi",
    "wrapper": "shanyi-host.swf", "game": "core_4_abc.swf"
  },
  "evidence": ["docs/SHANYI_SOURCE_AUDIT.md#8"]
}
```

研究对象示例（`config/research-games/shanyi-native-research.json`）：

```json
{
  "schemaVersion": 1,
  "id": "shanyi-native-research",
  "title": "闪翼双星（原生等价性研究）",
  "runtime": "flash-native",
  "online": false,
  "blockers": ["NO_BROWSER_RUNTIME", "CHAINED_LOADBYTES"],
  "evidence": ["docs/SHANYI_SOURCE_AUDIT.md#7"]
}
```

校验规则：

- `id` 匹配 `^[a-z][a-z0-9-]{1,31}$`，且在可联机与研究注册表之间全局唯一。
- `online` 必须等于该 runtime 的策略值；`flash-native` 不可声明为联机。
- HTML5 联机游戏必须声明的五项能力全部为 `true`；`flash-ruffle` 必须声明 `mirrorInput` 且不得声明 `authority`/`spectator`；`save` 可选，只有声明 `save: true` 的游戏才会写入房间存档；未知能力直接拒绝。
- 联机游戏必须声明已安装的 `adapter`（HTML5 默认 `fireboy-html5`，Flash 强制 `flash-mirror`）；未安装的适配器会被拒绝。离线游戏不得声明 adapter。
- `flash-ruffle` 的 `package` 必须同时提供 `wrapper` 与 `game` 两个相对路径；两者都必须在 `package.dir` 内。
- `order` 是可选整数（0..999），决定大厅中的游戏顺序；未声明时排在已声明项之后，再按 id 排序。当前顺序为森林、光明、冰雪、水晶、闪翼双星。
- 联机游戏不得声明 blocker；离线游戏必须至少有一个大写下划线 blocker。
- `package` 内所有路径必须是相对路径，不能包含 `..`，不能以 `/` 或 `\` 开头。
- `evidence` 只能是安全的相对引用，可带 `#section`。
- 未知 `schemaVersion`、未知 runtime、非法 JSON 均失败关闭。

## 3. 探测与准入

`server/game-probe.mjs` 只读探测，不执行游戏代码、不改动包体：

- SWF：校验 `FWS/CWS/ZWS` 头、声明长度、解压上限、RECT/帧率/帧数；扫描 latin1 常量池中的 `loadBytes`、`4399`、`A4399dv`、`checkAndPlay`、`DoABC`。
  - 链式加载 + 平台壳信号 → `flash-native`，blockers 含 `CHAINED_LOADBYTES`、`PLATFORM_SHELL`。
  - 普通 SWF → `flash-ruffle`，blocker 为 `RUFFLE_COMPATIBILITY_UNVERIFIED`。
  - 两种情况都保留 `NO_BROWSER_RUNTIME`，探测结论均为 `RESEARCH_ONLY`。

  探测结论是自动准入的上限，不是联机能力的证明；`flash-ruffle` → 输入镜像的准入另需人工审计的 wrapper（`adapters/shanyi-flash/`）、明确关卡清单和实测证据，并且 manifest 只能声明 `mirrorInput`。没有 wrapper 和证据的 SWF 包不会进入大厅。
- HTML5：检查 `index.html` 的 `data-main` / `require.js`、`game.json`、四套 `data/<temple>/temple.json` 中可读的一份，统计有效关卡。缺项给出 `HTML5_ENTRY_MISSING`、`HTML5_LEVELS_MISSING` 等显式 issue，`onlineEligible` 仅在所有 issue 消失时为 `true`。

目录加载本身也是准入门：`server/game-catalog.mjs` 会再次核对 `index.html` 入口、`temple.json` 的 `id` 与 manifest 的 `templeId`、关卡数量与字段；任一不符则拒绝启动，而不是静默跳过。

## 4. 注册表与生产接线

- `config/games/`：可联机游戏。`local/serve.mjs` 启动时通过 `manifestsDir` 指向这里；`scripts/start-game-lobby.mjs` 默认也从这里加载。
- `config/research-games/`：研究包。`loadGameRegistry({gamesDir, researchDir})` 同时加载两者并强制全局 id 唯一；研究包不会进入大厅目录。
- `scripts/start-game-lobby.mjs` 选项：`--manifests <dir>`（默认 `config/games`）、`--flash-root <dir>`（默认 `local/private-games`，Flash 包目录的本地根）、`--ruffle-dir <dir>`（默认 `local/tmp/ruffle-nightly`）。不传 `--manifests` 且目录不存在时才回退到旧的 `DEFINITIONS`。
- Flash 包通过 `extraRoots` 按游戏 id 映射到独立服务根：`/game/<gameId>/<file>` 只读提供 wrapper/game；Ruffle 自身文件经允许列表路由 `/__ruffle__/` 提供；`scripts/shanyi-mirror-client.mjs` 由 `/__research__/` 提供。
- 大厅公开目录新增 `runtime`、`adapter` 与 `experimental`，供前端识别游戏类型；权威/观看/镜像适配器均按 manifest 的 `adapter` 装配。
- `GET /api/rooms` 返回持久化房间广场：房间名、创建时间、各游戏存档和当前在线/占位人数，不返回密码哈希或 token。大厅 UI 分为「房间广场」和「创建房间」两块；广场支持按房间名搜索，点击「进入房间」后在密码弹窗中输入密码。加入只针对已存在房间，找不到时返回 `ROOM_NOT_FOUND`，不会隐式创建。
- 房间无人在线时仍可从广场加入：曾经连接过、现已离线的席位可被新玩家顶替；仅“已占位但从未连上”的席位保留 `ROOM_FULL`，避免抢走正在进入的玩家。创建面板下方显示本机最近房间，本标签页仍有有效 token 时可直接返回，否则进入密码面板。
- 进入关卡前有两层等待：大厅要求双方大厅席位都连接后才能提议/确认；游戏页要求双方 Ruffle 实例都上报 ready 后才解除“等待双方就位”遮罩，按键、点击和中继输入在就绪前一律不生效。

## 5. 新游戏接入流程

```bash
# 1. 探测（只读）
node scripts/onboard-game.mjs --html5 "E:/path/to/pack"

# 2. 合格时生成 manifest 草案
node scripts/onboard-game.mjs --html5 "E:/path/to/pack" \
  --manifest-out config/games/new-game.json

# 3. Flash 包探测（研究注册表）
node scripts/onboard-game.mjs --swf "E:/path/to/game.swf"

# 4. 校验注册表
node --input-type=module -e "import {loadGameRegistry} from './server/game-adapter.mjs'; \
  console.log(await loadGameRegistry({gamesDir:'config/games',researchDir:'config/research-games'}))"
```

退出码：`0` 表示可直接联机，`2` 表示仅研究或探测不合格；报告会列出 blockers/issues。

新增 HTML5 游戏时，除了 manifest，还必须提供与 `adapter` 对应的权威/观看适配器。当前只安装了 `fireboy-html5`（`adapters/fireboy-html5/`），四款神庙游戏共用同一引擎适配器；不同引擎需要新增适配器模块，并把它登记到 `SUPPORTED_ADAPTERS` 后才允许声明。manifest 的 `capabilities` 是声明，不是实现；未实现的能力不得设为 `true`。

## 6. 当前注册表

| id | runtime | 状态 | 说明 |
| --- | --- | --- | --- |
| `forest` | html5-phaser | 可联机 | 48 关，含返回选关投票 |
| `light` | html5-phaser | 可联机 | 41 关 |
| `ice` | html5-phaser | 可联机 | 53 关 |
| `crystal` | html5-phaser | 可联机 | 39 关 |
| `shanyi` | flash-ruffle | 实验·输入镜像 | wrapper + Ruffle nightly 可进入第一关；键鼠边沿经回环 WS 镜像，无权威/画面 |
| `shanyi-native-research` | flash-native | 仅研究 | 原生 projector 可玩；浏览器加载链证据保留为研究注册表 |
| `tank-trouble` | tank-arena | 可联机 | 原创双人迷宫坦克；大厅分配独立席位，服务端处理护甲、反弹、信标占领和得分 |
| `bleach-vs-naruto` | browser-lockstep | 待兼容构建 | 大厅已支持双人帧同步；私有包接口见 [帧同步接入](BVN_LOCKSTEP.md) |
| `bleach-vs-naruto-research` | flash-native | 仅研究 | 官方 3.4 发布包需要 AIR，浏览器步进桥待实机验证 |

`shanyi-native-research` 和 `bleach-vs-naruto-research` 属于研究登记。`shanyi` 的实验性输入镜像见 `docs/SHANYI_SOURCE_AUDIT.md` 第 8 节。`tank-trouble` 的双浏览器验收使用 `scripts/verify-tank-trouble.mjs`。

## 7. 不可突破的边界

- 本机/局域网默认监听 `0.0.0.0`（`local/serve.mjs` 自动探测局域网 IPv4 并公布），也可显式设置 `MULTIPLAYER_HOST` / `MULTIPLAYER_PUBLIC_HOST`；未增加面向用户的外部 access token。当前没有 TLS，不应直接暴露到公网；房间密码和内部席位凭证只用于房间流程。
- 原始 SWF 与资源目录只读；探测和联机都不写回原目录。
- 原始包体、提取资源不进入公开仓库；使用 `local/`、`private-games/` 或用户数据目录。
- 对局传输结构化输入与状态快照，不传视频或截图；Flash 镜像层只传输入边沿、在线状态和各自英雄的位置/速度用于纠偏，同样不传画面。两个标签页各自模拟，不保证确定性锁步。
- Ruffle 二进制与原始 SWF 都放在本地忽略目录，不进入公开仓库。
- 未经用户确认不提交、不推送。

## 8. 回归

```bash
node --test tests/game-adapter.test.mjs tests/game-probe.test.mjs tests/game-catalog-manifests.test.mjs
node --test tests/*.test.mjs
node scripts/verify-shanyi-mirror.mjs   # 单标签页：大厅 → 会话 → Ruffle 菜单 → 点击进入
node scripts/verify-shanyi-dual.mjs     # 双标签页：两端启动 + 点击镜像 + 画布尺寸
node scripts/verify-shanyi-sync.mjs     # 双标签页进关：按键归属 + 位置纠偏 + 暂停同步
node scripts/verify-auto-restart-stress.mjs # HTML5 权威端 6 轮连续死亡自动重开
```

当前全套 162 项 Node 测试通过（含适配器、只读探测器、manifest 目录加载、镜像中继、ready 门禁、房间广场、离线席位替换、“Flash 不写存档”和死亡自动重开回归）；三项 Shanyi E2E 均在 127.0.0.1 上通过，HTML5 自动重开 6 轮压力与双浏览器 E2E 也已通过。
