# HTML5：钻石已收集后的晚加入恢复（实机修复）

日期：2026-11-17。分支 `work/flash-netplay-lab`、PR #1 保持 Draft。

## 为什么必须修复

第一次针对真实客户端晚加入的 CI [#44074796969](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44074796969) 抓到复现：火娃用正常方向键和游戏自带 Box2D 传感器收走一颗火钻石后，权威状态剩 **6** 颗，新浏览器却显示 **7** 颗，其中一颗火钻石因 `underGround.children[]` 下标变化被错误投影到水钻石位置。**该轮测试实际失败，不可改写为通过。**

## 修复方案

- 服务端 `state-snapshot.mjs` 在关卡建立时登记全部钻石初始位置、属性、稳定 ID；后续销毁后仍保留缺失项，输出 `diamondRoster[{id,character,spawn,present}]`。该登记表随关卡 epoch 重建。
- `html5-research-room.mjs` 在允许玩家输入前就获取完整初始登记表。
- `spectator-projection.mjs` 在新客户端启动同一关卡时，利用**未改动的原始出生坐标与角色属性**映射本地钻石，对 `present=false` 的 ID 隐藏真实精灵。遇到缺失、歧义或不一致的登记项直接拒绝投影。
- 被收走的钻石造成列表索引变化时不再依赖 `sourcePaths` 定位；原已有的实时状态变更和箱子显示适配继续保留。
- 修正了原创测试夹具的排序错误，使其确实产生数组索引移动；失败记录及对应回归也保留。

## 实际测试

[CI #44075683238](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44075683238) 首次验证**钻石收集之后新浏览器加入**：双方和服务器看到相同的 6 颗钻石，位置逐颗对应，13 项通过。

[CI #44076714653](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44076714653) 又测试了**晚加入后操作水娃**：新玩家使用 KeyA，水娃位置由 268.2964 px 向左变为 95.0378 px，两个浏览器最终显示相同位置；服务器输入确认从 -1 前进到 5，客户端物理都保持 0 步。包括原有的 P 键、钻石拾取与箱子初始投影，累计 14 项浏览器检查通过、错误 0。

持续保留的事实摘要：[evidence/html5/44076714653/rejoin-summary.json](../evidence/html5/44076714653/rejoin-summary.json)。完整 CI 生成 JSON 下载请见对应 Actions artifact；CI 从固定第三方研究候选取得资源后只上传自写检查产生的 JSON，不提交原游戏二进制或素材。

## 必须保留的验收边界

研究候选 `game.js` SHA-256 是 `337125629748bace45e23b040e54b0d206e4cd78c9c8709d7785faa637e00677`；用户上传包第一代 `game.js` 为 `98666cf499473dfadb9b708af10ef2e5e13b50300881a32b7c8d65d7756a5700`。**二者不相同。** 本轮的成功不能冒充用户上传版实机成功。

尚待完成：实际推箱子引起的持续变化；按钮/杠杆与升降平台联动；其它钻石、死亡重开、门的完整动画与通关；场景切换时的新 epoch 和重入；公网部署性能与发行许可。
