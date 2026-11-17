# 双人网页游戏联机实验室

这个仓库用于研究和验证：**在自己的服务器上运行权威游戏逻辑，把玩家输入和结构化状态通过网络传输，由每个浏览器本地显示游戏。** 对局协议不传视频或屏幕截图。

当前主要验证路径是 **Node.js 房间服务 + 服务端 Chromium/Ruffle/AS3 + 客户端 Ruffle 显示实例**。仓库内的 `probe.swf` 是自写测试程序，包含两个可移动方块和独立鼠标标记。它用于检验 AS3 桥接、房间、输入归属与状态应用；《森林冰火人》和《闪翼双星》原版接入仍需补齐 SWF/资源并完成专用适配。

方案比较、原游戏的最小改造位置和验收步骤见 [架构决策](docs/ARCHITECTURE_DECISION.md)。

## 当前做到哪里

| 工作 | 当前证据与边界 |
| --- | --- |
| 上传材料审计 | 实际包为反编译文本和 JSON，没有原游戏 SWF、JavaScript 运行文件、图片及音频。见两份源码审计 |
| 冰火人第一代数据提取 | 已提取 32 个正式关卡、316 次工厂调用，13 个原创夹具测试通过；保留一个未知瓦片值，不推测其语义。提取数据不是完整游戏 |
| 自写 AS3 夹具编译 | 已生成 AS3/AVM2 SWF，并记录编译器和产物哈希，见 [build-evidence.json](experiments/as3-probe/build-evidence.json) |
| 房间与传输实现 | 已提供创建、加入、快速配对、输入缓冲、快照、重连和释放输入的代码；具体测试结论以测试输出和 `evidence/*.json` 为准 |
| 浏览器端到端验证 | 当前工作环境的 Chromium 启动受 socket 限制，标准浏览器下载也未成功；需要在正常服务器或仓库 CI 运行并保存证据。不能从编译成功推断浏览器测试通过 |
| 两款原游戏联机 | 尚未验收。原游戏缺运行包，不能把自写方块实验或关卡提取当作原版联机成功 |

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

浏览器测试脚本应生成 `evidence/e2e-results.json`；其他实验结果按脚本说明保存在 `evidence/`。仓库 CI 的最终结果和附带产物用于补齐本地环境未能完成的运行验证。不要把测试脚本存在、工作流已提交或任务已启动写成测试已通过。

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
| [架构决策](docs/ARCHITECTURE_DECISION.md) | 非视频同步路线、取舍、原游戏改造与验收顺序 |
| [自建服务器部署](docs/DEPLOYMENT.md) | 单机、局域网、公网代理和指标边界 |
| [冰火人源码审计](docs/FIREBOY_SOURCE_AUDIT.md) | 输入、Box2D、25/26 时钟差异、32 关提取与缺件 |
| [闪翼源码审计](docs/SHANYI_SOURCE_AUDIT.md) | 反编译质量、输入边沿、Alchemy、慢动作与显示列表依赖 |
| [输入与时钟契约](docs/INPUT_AND_CLOCK_CONTRACT.md) | 席位归属、短按、时钟、失焦和重连的适配约定 |
| [AS3 夹具说明](experiments/as3-probe/README.md) | 桥接 API、编译依赖、SWF 来源与范围 |
| `server/` | HTTP/WebSocket 房间服务、输入协议与 Ruffle 权威实例宿主 |
| `public/` | 实验页面、输入采集、Ruffle 客户端显示与权威端加载页 |
| `tests/`、`scripts/` | 自动测试、运行验证、源码审计与提取工具 |
| `evidence/` | 实验结果记录，须以实际生成的内容为准 |

## 继续接入原游戏需要的材料

优先补齐与已审计版本一致、可以运行且允许使用的原始 SWF 和资源。若有原 Flash 工程、库符号或完整 HTML5 源码，也应一并保留。当前文本反编译包缺少的内容可能包含关卡实例、碰撞形状和时间轴，不能只补一张图片就恢复。

建议首先以冰火人第一代做单关适配：先建立未修改原包基准，再接入输入、权威状态和客户端显示；通过后才扩展机关和其他关卡。闪翼正传因反编译伪指令、Alchemy 与动画碰撞依赖更重，应单独设兼容性验证。详细接入条件见架构决策。

实验目录的 MIT 许可只覆盖其注明的原创夹具，不覆盖上传游戏、游戏资源或第三方 SDK。
