**本机双浏览器研究入口：** [安装与启动说明](docs/HTML5_LOCAL_TWO_TAB.md) · `scripts/start-html5-local-room.mjs` 能用本地私有 HTML5 资源启动一个权威服务，并让两个普通浏览器标签页自动加入。该入口仅监听 127.0.0.1；不是已授权的公网游戏发行。

**生命周期验证：** [原生 retry() 与死亡双浏览器保护](docs/HTML5_NATIVE_RETRY.md) 已在固定研究版本真实 CI 中通过；目前是旧场景安全停机，尚非死亡后完整双人继续游戏。

**重开安全边界（2026-11-17）**：[真实 native retry() 使旧房间失效的实测](docs/HTML5_NATIVE_RETRY.md) 已通过，但客户端新关卡重建、死亡触发和恢复联机仍未验收。

**阶段补充：** [按钮释放与箱子最终收敛](docs/HTML5_BOX_PUSH.md) 已在同一个真实 HTML5 游戏权威实例 + 两个原生浏览器观看端中独立跑通两轮；未测试完整通关与用户上传的另一脚本版本。

**新实测（2026-11-17）**：[第 52 关真按钮联动与双浏览器推箱子](docs/HTML5_BOX_PUSH.md) 已通过，测试的是原 Phaser/Box2D 游戏逻辑和客户端原生显示，不是画面串流。仍需在用户上传的不同版本独立复现。

**2026-11-17 新增：** 已通过 [第 52 关按钮与平台的双客户端显示实测](docs/HTML5_MECHANISM_TEST.md)，在真实 Box2D 逻辑下按键触发 group2 按钮，两端均显示升降平台变化；仍未达到整款游戏完整验收。

**进度补充**：研究候选第一关已通过 14 项三浏览器检查，包含真实钻石拾取、收集后新玩家重新加入且正常操控水娃；用户上传原包仍未完成实机验收。详见 [晚加入修复与证据](docs/HTML5_REJOIN_FIX.md)。

# 双人网页游戏联机实验室

**阶段状态更新（2026-11-17）**：HTML5 第一代已完成同一权威实例＋两独立浏览器控制与可见像素验证，第一关箱子已经进入快照。详情和新的待做事项见 [HTML5 VISUAL SYNC STATUS](docs/HTML5_VISUAL_SYNC_STATUS.md)。这不是六部游戏完整联机，也不是用户原包已实机验收。

这个仓库用于研究和验证：**在自己的服务器上运行权威游戏逻辑，把玩家输入和结构化状态通过网络传输，由每个浏览器本地显示游戏。** 对局协议不传视频或屏幕截图。

**当前原游戏适配主线是森林冰火人第一代 HTML5 版。** 接手入口见 [最新交接](docs/HANDOFF_TO_NEXT_AGENT.md)，跳跃、暂停和状态导出的具体工作见 [HTML5 适配报告](docs/HTML5_ADAPTATION_REPORT.md)。原游戏文件只放本地忽略目录；没有将两款原游戏标为已完成联机。

仓库保留 **Node.js 房间服务 + Chromium/Ruffle/AS3 原创探针** 作为网络基础回归。下文的 `npm start` 和 `probe.swf` 是这个已验证的两方块实验；HTML5 研究宿主及验证使用独立脚本，不会替换探针或冒充原版基准。

方案比较、原游戏的最小改造位置和验收步骤见 [架构决策](docs/ARCHITECTURE_DECISION.md)。实际运行结果见 [验证报告](docs/VERIFICATION_REPORT.md) 与 [成功的 GitHub Actions 运行](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44033828759)。

## 当前做到哪里

| 工作 | 当前证据与边界 |
| --- | --- |
| 上传材料审计 | 实际包为反编译文本和 JSON，没有原游戏 SWF、JavaScript 运行文件、图片及音频。见两份源码审计 |
| 冰火人第一代数据提取 | 已提取 32 个正式关卡、316 次工厂调用，13 个原创夹具测试通过；保留一个未知瓦片值，不推测其语义。提取数据不是完整游戏 |
| 自写 AS3 夹具编译 | 已生成 AS3/AVM2 SWF，并记录编译器和产物哈希，见 [build-evidence.json](experiments/as3-probe/build-evidence.json) |
| 房间与传输实现 | 18 项协议/服务器逻辑测试通过；覆盖并发匹配、初始化取消、席位保留、故障终态、输入确认和资源释放 |
| 浏览器端到端验证 | GitHub Actions 中 13 项检查通过：一个真实 AS3 权威实例与两个独立浏览器显示实例、输入与鼠标隔离、实际显示对象位置、初始 tick、重连、退出和快速匹配；截图已检查 |
| 真实权威网络验证 | 8 项检查通过，包含同 tick 短按、非法输入拒绝、输入超时释放、重连及每方向 40 ms 固定延迟实验；这不是原游戏或公网测试 |
| 两款原游戏联机 | 尚未验收。用户本地已验证 HTML5 输入桥，当前继续第一代跳跃、暂停和状态导出；详见 HTML5 适配报告 |

没有实际结果文件，或结果文件的 `status` 不是 `passed`，就不能把相应项目写成已通过。即使独立夹具通过，也只覆盖记录的版本、环境和测试范围。

## 启动实验

需要 Node.js **22 或以上**、npm，以及能够运行 Chromium 的系统。Python 3 用于源码审计和提取测试。使用仓库中的预编译测试 SWF 不需要安装 Flash 插件或 Java；自行重新编译 AS3 夹具时才需要 Java 和对应编译工具。

在仓库根目录执行：

```bash
npm ci
npx playwright install --with-deps chromium-headless-shell
npm start
```

打开 <http://127.0.0.1:8780>。Playwright 的浏览器与系统依赖安装方式以其 [官方浏览器说明](https://playwright.dev/docs/browsers) 为依据；锁定依赖后应安装该版本对应的浏览器。

房间创建时才会启动权威 AS3 运行实例。首页和 `/health` 可以访问，说明 HTTP 服务已启动；这还不能证明 Ruffle 已加载或房间能运行。若创建房间失败，应查看服务终端的 Chromium 启动或 AS3 握手错误。

### 两人操作流程

1. 在两台电脑或两个独立浏览器中打开服务地址。
2. 一人点击“创建房间”，将六位房间码交给另一人；另一人输入房间码后点击“加入”。也可以双方点击“匹配另一位玩家”。
3. 两位玩家的客户端都完成加载后，房间进入运行状态。
4. 每人使用 WASD 或方向键移动自己的方块；空格是按钮 1，鼠标左键是按钮 2。鼠标十字标记按席位独立保存。
5. 观察两个页面收到和显示的 tick、角色位置及独立指针。失焦和断线相关行为应再用自动测试核对。

以上是实验程序的操作，不是两款原游戏的完整玩法。页面中的网络往返和状态载荷是当前连接的观察值，不代表公网延迟保证或服务器容量结论。

### 服务器配置

通过环境变量配置，示例见 [.env.example](.env.example)：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP/WebSocket 监听地址 |
| `PORT` | `8780` | 服务端口 |
| `MAX_ROOMS` | `4` | 实验房间数量上限，是保护阈值，不是压测容量 |
| `CHROMIUM_PATH` | 空 | 可选的已安装 Chromium 路径；留空使用 Playwright 对应浏览器 |

例如，允许同一局域网的设备访问：

```bash
HOST=0.0.0.0 PORT=8780 npm start
```

当前 `npm start` 从进程环境读取配置。若使用 `.env` 文件，可在 Node.js 22 下运行 `node --env-file=.env server/index.mjs`。部署到公网时，可用自己的 HTTPS 反向代理转发 HTTP 和 `/ws` 的 WebSocket 升级请求；页面会根据协议选用 `ws` 或 `wss`。

## 测试与证据

以下命令对应 [package.json](package.json) 中的脚本：

| 命令 | 核查范围 |
| --- | --- |
| `npm test` | Node 层协议、输入及服务器测试；具体范围以 `tests/*.test.mjs` 为准 |
| `npm run test:python` | 源码提取器等 Python 测试，使用自写夹具 |
| `npm run test:network` | 网络实验脚本；应阅读输出中的依赖、模拟方式与覆盖范围 |
| `npm run test:e2e` | 启动真实浏览器，验证权威 AS3 与两客户端显示、输入、状态和房间流程 |
| `npm run check:utf8` | 仓库文本编码检查 |
| `npm run build:probe -- --download` | 从锁定来源取得编译依赖，重新构建自写 AS3 夹具 |

浏览器测试需要先安装 Chromium。首次检查可以依次运行：

```bash
npm test
npm run test:python
npm run check:utf8
npm run test:network
npm run test:e2e
```

最近完成的运行代码提交为 `b1779ed50d5d222a61b5e95d7388c1bec9425801`，CI #3 成功。`evidence/e2e-results.json`、`evidence/network-results.json` 和 `evidence/ci-summary.json` 保存结果与来源；截图保存在 `evidence/screenshots/`。本地系统浏览器受限的尝试另保留在 `evidence/local-runtime-attempt.json`，没有混入成功结论。后续只更新文档和证据的提交不改变该已测代码。

阅读证据时，至少核对 `status`、时间、运行环境、版本、检查项和范围。回环地址上的结果不能代表异地公网；应用层延迟或丢弃消息实验也不能直接代表实际链路丢包。状态载荷计数不包含所有网络协议开销和初始资源下载。当前不公布未测得的并发房间数、带宽或输入延迟承诺。

## 对上传源码做本地实验

完整原游戏源码、提取地图和第三方 SDK 放在本地输入目录或已忽略的 `local/`，公开仓库保存工具、原创夹具和审计结果。

扫描已解包的源码包：

```bash
python3 scripts/audit_archive.py '/path/to/flash-archive-源码版' \
  --output local/reports/archive-audit.json \
  --manifest local/reports/archive-file-manifest.json
```

提取冰火人第一代关卡：

```bash
python3 scripts/audit_fireboy.py \
  --source '/path/to/flash-archive-源码版/02-fireboy-watergirl/decompiled/1-export/script/scripts/level.as' \
  --output local/fireboy/levels.json
```

提取器不会执行 AS3。它记录来源哈希、坐标、工厂参数与 `unsupported` 项；后续游戏适配器必须显式处理未知项。HTML5 关卡缺 tileset 定义，当前没有根据 GID 猜测物理含义。

## 文件导航

| 路径 | 内容 |
| --- | --- |
| [**交接给下一个 Agent**](docs/HANDOFF_TO_NEXT_AGENT.md) | **从这里开始**：当前状态、已验证结论、待做清单、代码位置速查、已踩过的坑 |
| [HTML5 路线验证](docs/HTML5_ROUTE_FINDINGS.md) | HTML5 版 6 部实机运行、Node 可运行性、输入路径定位、输入桥验证 |
| [本地 Agent 交接任务](docs/LOCAL_AGENT_HANDOFF.md) | 上一轮的任务书（补材料、跑基准），已完成 |
| [本地 Agent 检查结论](docs/LOCAL_AGENT_FINDINGS.md) | 材料核对、两款 Flash 原包的基准结果、探针复现 |
| [原游戏材料](docs/ORIGINAL_GAME_MATERIALS.md) | 原包放置方式、入口、依赖关系、重建条件 |
| [架构决策](docs/ARCHITECTURE_DECISION.md) | 非视频同步路线、取舍、原游戏改造与验收顺序 |
| [实际验证报告](docs/VERIFICATION_REPORT.md) | CI 来源、通过项、延迟/载荷测量及未覆盖范围 |
| [自建服务器部署](docs/DEPLOYMENT.md) | 单机、局域网、公网代理和指标边界 |
| [冰火人源码审计](docs/FIREBOY_SOURCE_AUDIT.md) | 输入、Box2D、25/26 时钟差异、32 关提取与缺件 |
| [闪翼源码审计](docs/SHANYI_SOURCE_AUDIT.md) | 反编译质量、输入边沿、Alchemy、慢动作与显示列表依赖 |
| [输入与时钟契约](docs/INPUT_AND_CLOCK_CONTRACT.md) | 席位归属、短按、时钟、失焦和重连的适配约定 |
| [AS3 夹具说明](experiments/as3-probe/README.md) | 桥接 API、编译依赖、SWF 来源与范围 |
| `server/` | HTTP/WebSocket 房间服务、输入协议与 Ruffle 权威实例宿主 |
| `public/` | 实验页面、输入采集、Ruffle 客户端显示与权威端加载页 |
| `tests/`、`scripts/` | 自动测试、运行验证、源码审计与提取工具 |
| `evidence/` | 实验结果记录，须以实际生成的内容为准 |

## 继续接入原游戏

优先核对用户本地 HTML5 第一代 `game.js` 的 SHA-256 与资源清单，运行 [HTML5 适配报告](docs/HTML5_ADAPTATION_REPORT.md) 中的三项实测脚本。研究候选、用户本地包和带仪器的 HTTP 响应均有独立来源记录，不把候选测试替代原包基准。

随后以第一代单关接入房间命令、席位输入消费、权威状态广播和客户端显示，完成双客户端验收后再扩展机关与关卡。Flash 原版路线已排除，相关材料和探针作为历史分析与网络回归保留，不再以补 SWF 为当前前置任务。

实验目录的 MIT 许可只覆盖其注明的原创夹具，不覆盖上传游戏、游戏资源或第三方 SDK。
