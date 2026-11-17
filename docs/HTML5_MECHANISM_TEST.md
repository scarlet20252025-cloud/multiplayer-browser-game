# HTML5：真实按钮和升降平台联动试验

当前结果须以 CI 报告为准，不能仅依据地图位置宣称通过。

## 关卡和类型已经按 firstgid 校验

Tiled 的 gid 是地图局部资源编号，必须从每关 tilesets 的 firstgid 识别，不可以将 gid 26 在每关都当成杠杆。

- 正式关卡 **id=52** 映射 `forest/levels/forest_04_1.json`，已经出现在原游戏 `temple.json` 的关卡列表。
- 水娃出生的中心约为 (1184,124)，附近按钮（pusher）在 (1120,160)，向左约 64 px，按钮位于脚下附近。
- 按钮 `group=2`，对应可移动平台初始约 (496,912)，同属 group2。
- 用原版机制事件驱动平台，不修改游戏 map JSON、移动角色 body 或直接调用机关函数。

源码证据：`game.js` 第 39920–39925 行是原版按钮 `checkState`；第 43295–43300 行的 MechManager 根据 group 关联设备。运行时 `inspectMechanisms()` 会记录真实构造类、类型、地图对象位置和注册联动关系以便复核。

## 真实验证条件

`scripts/verify-html5-mechanisms.mjs` 使用两条真实 WebSocket 会话，测试席位 1 的水娃只发送向左移动输入（无跳跃）。检查输入在权威角色 update 中已消费、按钮 state 真正变化，以及 group2 平台坐标真实移动。所有数据写到私有的 `local/html5-mechanism-results/mechanism-trace.json`；CI 只保存原创 JSON，不分发游戏资源或截图。

先前第 27 关的试验 [#44081865863](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44081865863) 未触发：按钮位于火娃出生点**上方约 60 px**，左移被地形阻挡，不能当作联动成功。第 52 关改为更合适的地形，不意味着自动通过，结论要看实际 CI。

CI 固定研究候选 `game.js` SHA256 为 `337125629748bace45e23b040e54b0d206e4cd78c9c8709d7785faa637e00677`，用户上传包另有哈希，不可混淆。
