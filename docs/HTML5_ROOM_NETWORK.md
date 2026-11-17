# HTML5 原生游戏网络输入实验

独立研究服务器：server/html5-research-room.mjs。运行一个真实的 HTML5 Phaser/Box2D 权威浏览器，两个 WebSocket 客户端按分配席位发送输入并接收同一份结构化快照。网络层不传画面，也不对客户端开放第三方游戏资源。

校验脚本 scripts/verify-html5-room-network.mjs 包含：两席位输入隔离、实际角色位移、共享快照一致性、已消费序号、权威暂停/恢复、短按、伪造席位拒绝、断线暂停。自动化工作流在忽略目录取得固定第三方研究候选，上传且仅上传生成的 JSON，不上传游戏源码/图片。测试报告出现 passed 才能写已通过。

用户原包的私有运行指令：

```
node scripts/verify-html5-room-network.mjs --root /private/html5-online/games --script 1-forest-temple/js/game.js --require-script lib/require.js --entry-path /1-forest-temple/index.html --expected-sha256 98666cf499473dfadb9b708af10ef2e5e13b50300881a32b7c8d65d7756a5700 --out local/html5-room-user
```

本阶段的客户端是网络控制端，不是完整 HTML5 游戏画面客户端。客户端渲染、规则副作用隔离、全机关状态覆盖、异地公网性能及公开发行许可均尚未验收；不要将候选测试结果等同于用户上传版本的结果。
