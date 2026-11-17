# HTML5 第一关：三浏览器权威同步与阶段续接

日期：2026-11-17。工作分支 `work/flash-netplay-lab`；PR #1 继续保持 Draft，不合并、不 force push。

## 阶段结果与证据

**研究候选第一关的三实例完整数据链已实机跑通**：一个 Chromium/Phaser/Box2D 权威实例 + 两个独立浏览器游戏画面实例，各自在键盘操作后通过 WebSocket 发送席位输入；权威端推进原逻辑，客户端在本地冻结物理并使用真实资源显示结构化状态。没有传视频或截图。

- [CI #44062443332](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44062443332)：双 WebSocket 客户端，9 项真实房间控制检查通过。
- [CI #44071295975](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44071295975)：第一次像素区域变化实测通过；比较区域 59,400 像素，空闲变化 474、移动后变化 8,009。
- [CI #44071860409](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44071860409)：新增 Box 快照与投影后，17 个实体映射和三浏览器回归通过。
- [CI #44072255039](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44072255039)：加入**真实箱子初始位置**与两端一致性的检查，8 项实际断言均通过；原始 JSON 见 [evidence/html5/44072255039/viewer-report.json](../evidence/html5/44072255039/viewer-report.json)。

固定研究候选脚本 SHA-256 为 `337125629748bace45e23b040e54b0d206e4cd78c9c8709d7785faa637e00677`。最新 CI 的可见变化像素：空闲 0、玩家移动后 8,451，观察区域 70,616 像素。两端游戏 Box2D 步进均为 0；同步对象包括 2 角色、7 钻石、2 门、6 机关/物体（其中一个是 `box`），总计 17 个。

CI 仅保留数值和 PNG 哈希，不将原游戏截图、图片、音效或运行源码上传到本公开仓库。固定候选出现 6 次已知 `h5api is not defined` 进度回调异常，记录在 diagnostics 中；尚未宣称零异常。

## 已实现模块

| 文件 | 职责 |
| --- | --- |
| `server/html5-room-core.mjs` | 双席位、输入与暂停命令校验，断线和租约语义 |
| `server/html5-research-room.mjs` | 同一真正的 HTML5 原游戏权威实例、两连接 WebSocket 广播 |
| `adapters/fireboy-html5/authority-input.mjs` | 包装真实角色 update，短按按下/松开分次消费后才 ACK |
| `adapters/fireboy-html5/state-snapshot.mjs` | 角色、钻石、门、杠杆、按钮、平台、可移动 `box` 的观察性快照 |
| `adapters/fireboy-html5/spectator-projection.mjs` | 观看端冻结本地物理，按权威快照更新各真实显示对象 |
| `adapters/fireboy-html5/spectator-client.mjs` | 浏览器键盘事件、WebSocket 连接、观看端视图 |
| `scripts/verify-html5-viewers.mjs` | 三实例、键盘移动、两端精灵一致、物理不推进、截图像素检查、箱子一致 |
| `scripts/verify-html5-room-network.mjs` | 双 WebSocket 操控、短按、暂停、伪造席位与断线测试 |

可移动箱子的源码定位来自**用户实际上传包** `games/1-forest-temple/js/game.js`：`BoxPrototype` 第 38169 行、`Box` 第 38253 行、`box: Devices.Box` 第 43308 行以及关卡对象创建第 44814 行。新增适配是原创代码，未复制或公开原包文本。

## 用户原包未实机验收，禁止冒充候选通过

用户上传文件 `html5-online-20261117.zip`（26,432,078 字节）经过真实 ZIP 静态审计：ZIP SHA-256 `d084d355d327a39293c9f9252c2f9c34dfaaa9b1c6145bf991f8ae2397def592`；第一代 `game.js` SHA-256 `98666cf499473dfadb9b708af10ef2e5e13b50300881a32b7c8d65d7756a5700`。它不同于 CI 的固定研究候选，不能把 CI 的候选通过状态当作用户包通过。

此容器的浏览器网络/导航被策略阻塞（ERR_BLOCKED_BY_ADMINISTRATOR），因此只完成 ZIP 与源码静态验证。用户本机或受控专用 runner 可以在依赖安装后使用私人文件运行：

```powershell
node scripts/verify-html5-room-network.mjs --root "E:\肥鱼不乐园\flash-archive\02-fireboy-watergirl\html5-online\games" --script 1-forest-temple/js/game.js --require-script lib/require.js --entry-path /1-forest-temple/index.html --expected-sha256 98666cf499473dfadb9b708af10ef2e5e13b50300881a32b7c8d65d7756a5700 --out local/html5-user-room

node scripts/verify-html5-viewers.mjs --root "E:\肥鱼不乐园\flash-archive\02-fireboy-watergirl\html5-online\games" --script 1-forest-temple/js/game.js --require-script lib/require.js --entry-path /1-forest-temple/index.html --expected-sha256 98666cf499473dfadb9b708af10ef2e5e13b50300881a32b7c8d65d7756a5700 --out local/html5-user-viewers
```

以上命令的输出属于 `local/` 忽略目录，必须根据**当次**报告判断状态；不要把旧 JSON 当本次结果。请勿将原包、SWF、游戏图片或声音、截图提交到公开仓库。

## 下一阶段（未完成）

1. **实际交互回归**：玩家推动箱子、触发杠杆/按钮、收集钻石、门动画与通关状态；目前只验证箱子的初始映射和更新字段/夹具。
2. **完整状态与显示**：角色更多动作帧、对象增删、动态机关、多层遮挡、音效事件、关卡切换；当前 `snapshot.coverage.completeGameState=false`。
3. **会话健壮性**：晚加入/重连时的全量快照、实体稳定 ID、断线释放、游戏结束处理与版本校验。
4. **用户上传原包实测与公网性能**：在用户本地私人目录取得新报告，随后再评估自建服务器容量；公开发行游戏资源前需解决对应权利授权。

此阶段属于受控私人研究实验，不应描述为发行方授权游戏服务，也不能将前三实例测试当成原游戏全部玩法已经联机。

## 2026-11-17 浏览器 P 键和主动退出完整验证

在三浏览器研究测试中，另新增真实浏览器键盘路径与退出路径：第一名玩家在观看端按 **P**，权威端 `game.paused=true`（房间 revision 1）；第二名玩家按 **P** 恢复，revision 2 且权威端 `game.paused=false`；第二名玩家调用观看端退出后，剩余玩家收到等待状态，权威端再次暂停。

[GitHub Actions #44072833908](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44072833908) 对应固定研究候选完成 **11 项实际浏览器检查**，全部通过，失败数为零；其原始 JSON 保存到 [evidence/html5/44072833908/viewer-report.json](../evidence/html5/44072833908/viewer-report.json)。可见画面区域像素变化从无人操作的 821 增加到角色移动后的 8,684（区域 73,720 像素）；两端物理步骤继续为 0；同步对象总数 17（包括 1 个 box）。本轮仍出现 6 次已记录的 `h5api is not defined` 进度回调异常。

该测试验证了**浏览器实际操作 → 服务器状态变化 → 两浏览器真实画面**以及 P 键/离开房间行为，但不覆盖掉线重连后的全关卡恢复、箱子被推动后的真实玩法、钻石被收集后的状态和通关动画。用户上传 ZIP 的版本并非本 CI 使用的固定研究候选；继续保留不同来源的独立状态记录。

## 2026-11-17 — 真实钻石收集（新增）

[CI #44074232490](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44074232490) 对固定研究候选实现了**正常浏览器按键引发原生 Box2D 接触后收集火钻石**。权威钻石数量 7→6，火娃个人钻石计数 0→1，两份冻结观看端均显示 6 颗钻石。测试不调用 `Diamond.grabbed()`，不传送角色，不直接销毁对象；浏览器两端物理步进仍为 0。

火属性钻石的权威坐标为 (656, 848)，本轮有 8 组火娃轨迹样本。完整 JSON 留在该 CI 的 [artifact](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44074232490)（存储期限受 GitHub Actions 设定限制），持续保留的数值摘要在 `evidence/html5/44074232490/collection-summary.json`。本轮合计 12 项浏览器断言通过，6 次已知 `h5api is not defined` 进度错误仍记录，不能说完全无错误。

**仍未验证**：已收集后新玩家重进场时的钻石映射、实际推箱子、按钮/杠杆联动、死亡重开、关卡完成与用户上传原包。后续测试必须针对真实玩法事件，不得通过直接设角色坐标或调用触发方法绕过玩法。

## 2026-11-17 — 晚加入钻石恢复与重新接管

真实测试首先发现后加入浏览器错误显示 7 颗钻石（权威只剩 6），见 [CI #44074796969](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44074796969)；已通过初始钻石稳定登记表和 tombstone 修复。最新 [CI #44076714653](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44076714653) 14 项通过，涵盖真实拾取、晚加入显示与按键重新接管水娃，详细见 [HTML5_REJOIN_FIX.md](HTML5_REJOIN_FIX.md)。

## 2026-11-17：实际推箱子与联动平台的三浏览器回归

[CI #44084005637](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44084005637) 真实让水娃踩下 group2 按钮，并继续向左推动动态箱子。服务器侧原生箱子从 X≈1039.998 到 X≈962.904；两份冻结观看端在随后同一权威状态中显示箱子 X≈979.847，客户端物理仍为零。事件时刻不同，不可误报为服务器/客户端延迟误差。完整字段、来源版本和未完成项详见 [HTML5_BOX_PUSH.md](HTML5_BOX_PUSH.md)。
