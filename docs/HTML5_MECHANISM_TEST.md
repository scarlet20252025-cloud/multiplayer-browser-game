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

## 2026-11-17：第 52 关机关触发与三浏览器显示全部实机通过

[CI #44082384451](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44082384451) 用网络席位 1 的水娃按普通左方向键，触发了 group2 原生按钮（状态 0→1），联动平台开始升起；其纵坐标从 912 下降到约 895.55（屏幕坐标向下），未直接改动对象位置。

[CI #44082985364](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44082985364) 增加了**两个各自独立加载原游戏素材的冻结浏览器客户端**。同一轮服务器按钮状态 1，按钮 Y≈173.18598，平台 Y≈900.48；两个客户端显示数据与所收到的权威快照一致，客户端 Box2D Step 都保持为 0。源版本、两端具体坐标、CI artifact 哈希保存在 [evidence/html5/44082985364/mechanism-summary.json](../evidence/html5/44082985364/mechanism-summary.json)。

原包不同版本未做同条件实机验证；仍有 6 次已知平台进度回调 `h5api is not defined` 诊断。推箱子、按钮松开后的完整复位、关卡胜负与多关联动仍待验证，不能概括为全部机关已联机。
