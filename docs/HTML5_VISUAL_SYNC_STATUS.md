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
