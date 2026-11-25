# 死神 vs 火影帧同步接入

## 3.3 浏览器联机

大厅可以对接独立运行的 BVN Online 3.3 服务。采用 Keyzf 的固定提交 `c7da486`，保留原版游戏和该实现的选人、资源加载握手与逐帧输入。两名玩家各自在本机渲染，游戏服务比较同帧状态。大厅发起双人对战，确认后分配两个独立席位，并在退出后恢复选房。[BVN Online 源码](https://github.com/keyzf/bvn-online/tree/c7da486f78b1b9217d2e158e4c0505f2084e9ffd)

两名玩家的帧状态均确认进入战斗后，大厅可为持有房间密码的观众发放独立凭证。观战页接收第一位玩家游戏画布的低频率画面，无需加载游戏包，当前观战画面为静音。任一玩家离开、断线或房间关闭时，观战页返回大厅并显示原因。

SWF 和 Ruffle 运行文件按内容版本提供。浏览器通过 IndexedDB 保存约 69 MB 的主游戏包，刷新或同一浏览器再开标签时可从本地读取。切换资源版本或清除站点数据后会重新下载。每次进入仍需初始化 Ruffle 和游戏。

本地验收复现了原版补丁的发布哈希。两个独立 Chromium 会话从大厅进入同一局 1v1，完成选人、援助和地图加载。P1、P2 分别损失 80 和 480 点血量，34 个带战斗状态的共同帧检查点逐项一致，双方均返回原房间。验收期间没有连接媒体 WebSocket。

### 私有部署

1. 从固定提交准备 BVN Online 工作目录，执行 `npm ci --ignore-scripts`。提供该版本 [构建说明](https://github.com/keyzf/bvn-online/blob/c7da486f78b1b9217d2e158e4c0505f2084e9ffd/docs/game-build.md) 指定的原版 SWF。
2. 用 FFDec 26.2.1 执行上游 `scripts/build-netplay.py`。在本项目运行 `node scripts/prepare-bvn33-sidecar.mjs <BVN Online 目录>`。脚本检查产物 SHA‑256，并接入大厅的席位分配、房间生命周期和观战凭证接口。
3. 在 BVN Online 目录设置 `HOST` 和 `PORT`，运行 `node server.mjs`。建议局域网服务绑定 Wi‑Fi 地址，BVN 端口默认 18745。
4. 启动大厅时配置 `BVN33_SERVICE_URL` 为该服务地址。浏览器侧另有地址时可指定 `BVN33_PUBLIC_URL`，让两服务使用同一个浏览器可访问的主机名。
5. 用 `node scripts/verify-bvn33.mjs <现有 HTML5 游戏根目录> <BVN 服务地址>` 验证从大厅开局到实际对战。传入 `--watch` 可用第三个浏览器一并验证观战。该脚本在独立端口和房间注册表中运行。
6. 用 `node scripts/verify-bvn33-cache.mjs <内部格斗服务地址> <浏览器访问的格斗服务地址> <大厅地址>` 验证首次下载后刷新及新标签零重复请求，并检查双方能到达选人画面。

## 通用帧同步实验

大厅已支持双人帧同步会话。验证使用画布测试构建，原版选人、出招、结算及公网稳定性仍待实机验收。

已核对 5DPLAY 的 3.4 发布包 `RELEASE_20261031` 的 SHA-256 和目录。包内有 75 个角色和 15 个地图 SWF，AIR 配置将 `FighterTester.swf` 声明为桌面入口。完整发布包在 Ruffle nightly 的 Canvas 后端加载成功，但在 AVM2 构造时因缺少 `BitmapData.draw` 支持停止。此前尝试的浏览器构建使用空 UI 占位，只适用于启动探针。 [5DPLAY 发布文件](https://github.com/5DPLAY-Game-Studio/OpenBleachVsNaruto/releases/expanded_assets/RELEASE_20261031)

## 房间和对局

1. 两名玩家在大厅加入同一个房间。一方发起，另一方确认。两张对战页面使用各自的一次性席位凭证连接大厅的 `/lockstep`，沿用大厅监听端口。
2. 两端加载同一构建，用服务器提供的随机种子初始化，再提交初始状态摘要。摘要一致后以每秒 30 帧推进。
3. 服务器广播顺序一致的方向、按键状态和按下边沿。一次按下和松开即使都发生在两帧之间，也能在下一帧收到按下边沿。最多允许 4 帧尚未得到双方确认。
4. 双方比较第 1 帧、此后每 30 帧以及结算帧的状态摘要。胜负和摘要都一致时才显示结果。断线、超时或不同步会结束会话，双方可以返回同一房间重新开局。

游戏模拟和画面在浏览器本地运行。中继负责排序与一致性检查。当前协议适用于好友对战。

## 接入兼容构建

默认包目录为 `local/private-games/bleach-vs-naruto/`，也可以用现有启动器的 `--shanyi-root` 指定私有包父目录。兼容构建包含以下入口。

| 文件 | 用途 |
| --- | --- |
| `levels.json` | 大厅可发起的模式，例如 `{"levels":[{"id":0}]}` |
| `netplay.mjs` | 对战桥接模块 |
| 构建依赖和资源 | 从包内相对 URL 加载，由运行者提供 |

大厅生成 `index.html`。`netplay.mjs` 向它导出 `createGame({mount, levelId, seed, tickRate})`，可异步完成资源加载。返回的对象实现以下接口。

- `step({frame, masks, pressed})` 同步推进一帧并渲染。两个输入数组按 P1、P2 排列。游戏照常进行时返回 `undefined`，结算时返回 `{winner: 0}`、`{winner: 1}` 或 `{winner: null}`（平局）。
- `stateHash()` 返回 8 至 64 位小写十六进制摘要。摘要应覆盖战斗状态、选人与场景、回合时钟和 PRNG 状态。初始化时的摘要也必须能跨浏览器一致重现。
- `dispose()` 可选，用于释放监听器和运行时。

输入位定义位于 `public/lockstep/protocol.mjs`。桥接需要在引擎输入层消费两个席位的位掩码，由 `step` 控制模拟时钟，并用同一随机种子驱动玩法。普通 SWF、AIR 可执行文件和缺资源的探针构建都无法直接提供这组接口。

## 验收

装好仓库依赖及 Playwright Chromium 后执行 `node scripts/verify-lockstep.mjs`。脚本创建临时测试包和房间，实测两个独立浏览器上下文的建房、邀请、开局、席位输入、短按、胜负、不同步、重赛和断线。

拿到兼容构建后，还须用实际游戏跑完选人、双方操作、一次完整结算和再开一局，并比对双方结果。官方 3.4 源码的资源发布方式见 [5DPLAY 构建文档](https://github.com/5DPLAY-Game-Studio/OpenBleachVsNaruto#如何从源码构建)。
