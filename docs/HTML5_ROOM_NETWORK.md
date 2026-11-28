# HTML5 原生游戏网络输入实验

独立研究服务器：server/html5-research-room.mjs。运行一个真实的 HTML5 Phaser/Box2D 权威浏览器，两个 WebSocket 客户端按分配席位发送输入并接收同一份结构化快照。网络层不传画面，也不对客户端开放第三方游戏资源。

校验脚本 scripts/verify-html5-room-network.mjs 包含：两席位输入隔离、实际角色位移、共享快照一致性、已消费序号、权威暂停/恢复、短按、伪造席位拒绝、断线暂停。自动化工作流在忽略目录取得固定第三方研究候选，上传且仅上传生成的 JSON，不上传游戏源码/图片。测试报告出现 passed 才能写已通过。

用户原包的私有运行指令：

```
node scripts/verify-html5-room-network.mjs --root /private/html5-online/games --script 1-forest-temple/js/game.js --require-script lib/require.js --entry-path /1-forest-temple/index.html --expected-sha256 98666cf499473dfadb9b708af10ef2e5e13b50300881a32b7c8d65d7756a5700 --out local/html5-room-user
```

本阶段的客户端是网络控制端，不是完整 HTML5 游戏画面客户端。客户端渲染、规则副作用隔离、全机关状态覆盖、异地公网性能及公开发行许可均尚未验收；不要将候选测试结果等同于用户上传版本的结果。

## 2026-11-17 第一轮实测与修复

首轮 CI [44062209099](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44062209099) 验证到了最后一步，但断线测试误读了连接初期的旧 room 消息，判定失败；保留该失败记录。修正为只接受断线操作后的新消息后，CI [44062443332](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44062443332) 完整成功，使用研究候选哈希 337125629748bace45e23b040e54b0d206e4cd78c9c8709d7785faa637e00677。9 项实际检查均通过：两席位/第一关、单独控制水娃、两个 WebSocket 收到相同权威快照、单独控制火娃、暂停、恢复、短按已消费确认、伪造席位拒绝、断线暂停。

实测移动增量：水娃 +41.024 px，火娃 +34.648 px；同次广播状态有 2 角色、7 钻石、2 门、5 机关。这里测的是原始游戏逻辑在服务器浏览器上的实际反应，不是动画截图或假对象；不过两个网络客户端尚未运行完整游戏显示程序，不能称为完整原版双端联机。公网、容量、用户上传 ZIP 版本均未完成实机验收。

原始生成 JSON 以不含第三方素材的形式固定于 evidence/html5/44062443332/room-network-report.json。GitHub Actions 原产物的 ZIP SHA-256 为 2a99c61762e2554f164cbb1c8c4d6b7ec877deb7f659cf6a9eecf98c7a450700。
