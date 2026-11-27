# 公开联机方案研究：坦克动荡、死神 vs 火影

本文件记录对两款 Flash 游戏的公开版本、联机架构和接入现有适配器框架的可行性评估。研究时间：2026-11-19。这里只记录方案，不代表这些游戏已经录入可玩目录；本地没有可授权分发的原包，不能把未验证的地址当成已接入。

## 坦克动荡 / Tank Trouble

### 公开版本

- 原版由 Mads Purup 于 2007 年开发，Sublab Games 运营（[官网](https://tanktrouble.com)、[开发方](https://sublabgames.com)）。
- [Classic 页面](https://classic.tanktrouble.com/) 仍嵌入 `TankTrouble_v4.03.swf`，是本地 2–3 人同屏，不含网络联机。
- 现版官网是 HTML5/Canvas，使用自建 WSS 多区域服务；官方在线协议闭源，不能推断其同步模型。
- 4399 的坦克动荡 1/2 为 Flash，第 3 代为 HTML5；这些页面本身是本地同屏，不提供公开联机 API。
- 开源复刻中最值得参考的是 MIT 许可的 [jolaaa999/TankTrouble](https://github.com/jolaaa999/TankTrouble)：Phaser 3 + Vite + TypeScript 客户端、Colyseus 权威房间、共享确定性迷宫/物理代码（`apps/client`、`apps/server`、`packages/shared`）。
- 另有 Apache-2.0 的 [ethanbaker/tank-trouble](https://github.com/ethanbaker/tank-trouble)（Phaser 3 + socket.io，服务器位置/子弹广播，碰撞由客户端上报，属于弱权威中继），以及已归档的 [kneasle/tank-trouble](https://github.com/kneasle/tank-trouble)（作者结论是 WebSocket 不适合直接做实时同步，建议 WebRTC/WASM）。

### 复用判断

- **可做**：把 Classic 4399/Sublab 包登记为 `flash-ruffle` + `flash-mirror` 的研究包，做单机 + 双标签输入镜像 spike；输入需要保留按下、松开边沿和短按，状态只纠位置/速度，不传画面。Classic SWF 是 CWS v8、没有 `DoABC`，应按 AVM1/AS2 处理；现有 `ShanyiHost.as` 是 AS3 wrapper，不能直接复用，需要另写 AS2 wrapper 或走 Ruffle JS API。
- **可做但工作量大**：基于 MIT 的 jolaaa999/TankTrouble 新建 `html5-phaser` 适配器和权威服务，把客户端入口/资源做成 manifest 包。它不是原版 Flash 包，需要单独适配，不能直接套 `fireboy-html5`。
- **暂不可做**：直连官方 tanktrouble.com 的在线房间；不能把闭源客户端、私有协议和原版资源打包进本仓库；Flash 多实例镜像不承诺确定性锁步，3 人以上同步未验证。

### 建议 manifest（只有拿到本地包后才创建）

```json
{
  "schemaVersion": 1,
  "id": "tank-trouble",
  "title": "坦克动荡 · 实验输入镜像",
  "runtime": "flash-ruffle",
  "adapter": "flash-mirror",
  "online": true,
  "seats": 2,
  "capabilities": {"mirrorInput": true},
  "package": {
    "dir": "tank-trouble",
    "entry": "index.html",
    "levels": "levels.json",
    "templeId": "tank-trouble",
    "storagePrefix": "tank-trouble",
    "wrapper": "tanktrouble-host.swf",
    "game": "TankTrouble_v4.03.swf"
  }
}
```

资源必须放在 `local/private-games/tank-trouble/` 并保持原包只读。实际 manifest 只能在 Ruffle 单机、双标签输入归属、短按/失焦释放和位置纠偏全部验证后登记。

## 死神 vs 火影 / Bleach vs Naruto

现有大厅的双人帧同步实现与兼容构建接口见 [死神 vs 火影帧同步接入](BVN_LOCKSTEP.md)。下文保留早期可移植性调研。

### 公开版本

- 2008 年首发，4399 等站点发行；0.6–2.6 为 AS2，3.0 起为 AS3（[版本说明](https://bvn.huijiwiki.com/wiki/Download%26Tutorial)）。
- 官方 3.4 调试版开源：[5DPLAY-Game-Studio/OpenBleachVsNaruto](https://github.com/5DPLAY-Game-Studio/OpenBleachVsNaruto)，AS3、GPL-3.0、已归档。现行“竞技版”由 [bvn-sports.com](https://bvn-sports.com/) 发行，3.6 之后转 Unity。
- 本地双人各版本支持；Windows 3.05 起支持局域网。3.8.8.6 使用 UDP 17477 发现、TCP 17511 连接（[vs-lan-relay](https://github.com/newbeefish/vs-lan-relay)）。
- 社区互联网大厅 [BVN Online](https://bvnol.com/) 提供 3.3/3.8 多服务器、2v2/3v3；浏览器端自写源码 [keyzf/bvn-online](https://github.com/keyzf/bvn-online)，MIT 只覆盖自写部分。另有越南社区桌面版 [bvsn.online](https://bvsn.online/faq?lang=zh)。

### 公开联机架构

- 没有服务端权威模拟：两名玩家各自在浏览器用 Ruffle 运行一份游戏；Node.js 服务器只负责建房、身份、输入分发和状态比对（[实现指南](https://github.com/keyzf/bvn-online/blob/main/docs/implementation-guide.md)）。
- 帧同步：服务器下发带帧号的双方输入位掩码，并保留短按；两端执行同一帧、回报帧号；3.8 最多领先慢端 4 帧，3.3 为 8 帧；每 30 帧比对状态，不一致即停。
- WebSocket/TCP 有序重传；没有预测回滚、没有完整快照，也不支持原局断线续玩（[变体说明](https://github.com/keyzf/bvn-online/blob/main/docs/variants.md)）。
- 只有 3.3 测试服 2 有观战：独立 live socket 采集玩家 800×600 画布，WebP 最高 24fps，可选音频；观众不运行游戏。这个方案属于视频/截图串流，不符合本项目“不使用视频串流”的默认约束，不能直接照搬。
- 关键目录：`net-server.mjs`、`public/net-engine.js`、`net-clock.js`、`net-client.js`、`lib/live-media.mjs`、`scripts/build-netplay.py`；3.8 适配在 `bvn38/`。

### 复用判断

- **可做**：`flash-ruffle` + `flash-mirror` 的实验性输入镜像只能验证菜单、选人、双端按键和位置纠偏；格斗游戏的 HP、气、回合、胜负都由各端本地判定，会漂移，不能标成公平联机。
- **不应做**：把现有 mirror 适配器宣称为权威或确定性；把观战 live-socket 方案加入本项目（违反无视频串流约束）；把原版 SWF/素材当作 MIT/GPL 资源分发（开源项目只覆盖自写代码，原游戏版权另计）。
- **要做真联机**：需要新增“帧同步”适配层，至少包含受控时钟、输入帧号/位掩码、双方帧回报、慢端领先限制和状态摘要比对；这需要修改原 SWF 的输入/时钟入口或重新编译受控版本，超出 manifest 配置范围。可参考 `keyzf/bvn-online` 的帧同步思路，但不能直接复制其观战媒体层。

### 建议 manifest（只有拿到本地包后才创建）

```json
{
  "schemaVersion": 1,
  "id": "bvn33",
  "title": "死神 vs 火影 3.3 · 实验输入镜像",
  "runtime": "flash-ruffle",
  "adapter": "flash-mirror",
  "online": true,
  "seats": 2,
  "capabilities": {"mirrorInput": true},
  "package": {
    "dir": "bvn33",
    "entry": "index.html",
    "levels": "levels.json",
    "templeId": "bvn33",
    "storagePrefix": "bvn33",
    "wrapper": "bvn33-host.swf",
    "game": "bvn33.swf"
  }
}
```

## 对现有项目的结论

1. 大厅当前使用原创的「迷宫坦克 · 信标争夺」。两席使用大厅分配的独立凭证进入同一场游戏，服务端计算移动、炮弹反弹、护甲和信标进度。
2. 死神 vs 火影的官方 3.4 AIR 发布包包含已编译的角色及地图。大厅已具备双人帧同步；原游戏仍需可运行于浏览器的入口和确定性步进桥接。
3. 这两款游戏都不能靠当前 `flash-mirror` 变成可信的权威联机；最多只能做实验性输入镜像，且需要本地原包和新的 wrapper。
4. 原项目继续优先使用 HTML5 权威适配器（森林冰火人）和 Shanyi 实验镜像；新增游戏必须经过 `scripts/onboard-game.mjs` 的只读探测和真实浏览器验收后才能进入可玩目录。
