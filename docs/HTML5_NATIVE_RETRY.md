# HTML5 关卡重开与房间旧输入隔离（真实浏览器）

日期：2026-11-17。原生方法清单来自 [CI #44099746549](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44099746549)，真实第一代 Phaser `level` 的已观察方法含 `retry()`、`startLevel()`、`checkEndGame()`、`gameFinish()`、`togglePause()`。这不是根据惯例猜的函数。

## 已验证的最小重开边界

[CI #44101050713](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44101050713) 用一个真实 HTML5 游戏权威 Chromium、两条实际 WebSocket 席位连接，调用原游戏**现有** `level.retry()` 处理器：关卡 `levelEpoch` 从 1 增为 2；旧房间立即进入 `LEVEL_EPOCH_CHANGED` 停止状态；双方收到 `lifecycle` 消息，旧输入返回 `ROOM_SUSPENDED`。上述 4 项通过、0 错误。调用未改动原游戏文件，也未人工写角色位置、碰撞、门或钻石。

这不是“玩家死亡后自动复活”或“双方已恢复游玩”：CI 使用 Node 测试接口主动调用真实 retry 方法，**没有**由死亡、通关或玩家 UI 按钮触发它；房间当前选择安全停机，不会擅自重新恢复旧会话。新场景输入桥的重新绑定、客户端两端执行原生重开/重建显示，以及新的 roomEpoch/levelEpoch 同步仍是独立未完成项。

## 现有代码与安全策略

- `server/html5-scene-guard.mjs` 基于真实快照守护 `sourceGameSha256`、`sessionEpoch`、`levelEpoch`、Phaser scene 名称、快照顺序、`level.ended`、两名角色 `dead/dying`，检测到异常后锁存状态，不会自行放行。
- `server/html5-room-core.mjs` 在停机状态拒绝新输入和暂停命令，清空旧按住/边沿；恢复需独立新会话协议。
- `server/html5-research-room.mjs` 在应用旧输入前检查场景变更，发出带原因的生命周期通知；研究用 `invokeNativeRetryForResearch()` 不暴露在对外 WebSocket 中。
- `adapters/fireboy-html5/spectator-client.mjs` 接收生命周期通知时清除本地按住输入，不再向旧房间发送移动或暂停命令。

## 当前回归风险与待做

旧三浏览器测试在捡钻石后执行暂停键的路径上出现过偶发超时；新守卫可能捕获原游戏角色死亡或关卡结束，也可能存在竞态，不能仅因为旧 CI 通过就无视。正在用 `scripts/verify-html5-viewers.mjs` 采集失败时 `room.suspendedReason`、场景和角色死亡标记，确定原因后修复。

用户上传的 HTML5 包另有源码 SHA-256，与 CI 固定研究版本不同；上传的游戏文件、图像、音频和源脚本仍保留在私有环境，不提交到此公开仓库。发行和公网部署需要相应授权。
