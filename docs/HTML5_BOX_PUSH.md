# HTML5 第一代：真实推箱子和按钮平台同步报告

**实测结果：passed，仅限固定研究候选第 52 号关卡。**

[CI #44084005637](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44084005637) 使用一个原 Phaser/Box2D 权威浏览器和两个独立加载原游戏画面的冻结观看端。玩家水娃经 WebSocket 正常按 KeyA 向左移动，先踩下 group2 按钮驱动原版平台，再继续碰撞并推动真正的动态箱子。没有调用角色传送、箱子设置位置、按钮 checkState 或关卡脚本的作弊入口，也没有视频/截图串流。

## 实测数据

| 物体 | 初始 | 实测变化 |
|---|---|---|
| 原按钮 | state=0 | state=1 |
| 联动平台 Y | 912 | 权威触发时 897.92，两端稍后均为 892.80 |
| 动态箱子 X | 1039.998 | 权威接触采样 X=962.904，即左移 77.095 px |
| 箱子本地画面 X | — | 两端均为 979.847，来自**另一个稍晚的**权威快照 |
| 两观看端物理步进 | 0 | 0 |

注意：`authorityPhysicalPushSample` 与 `viewerSnapshotAtLaterMoment` 是不同时刻，不能直接相减当作显示误差。测试实际核对的是每个客户端自己的本地箱子 sprite 是否与**它刚刚收到的权威快照**一致，以及两个观看端是否显示同一位置。

本轮第二步包含 5 项浏览器检查（两端初始化、按钮、平台、冻结物理、原生推箱子），均 passed，错误 0。CI artifact 中还保存了服务器侧 3 项检查和移动轨迹。网页仍有 6 次既有的 `h5api is not defined` 平台加载进度回调异常，未宣称零异常。

## 文件与复现

- `scripts/verify-html5-mechanisms.mjs`：服务器侧两个 WebSocket 输入和按钮／平台联动。
- `scripts/verify-html5-mechanism-viewers.mjs`：三浏览器真实操作、画面跟随及箱子观测。
- `scripts/tiled-objects.mjs`：根据每个关卡自己的 firstgid 识别物品类型，避免把按钮误判成杠杆。
- `evidence/html5/44084005637/box-push-summary.json`：不包含原游戏资产的数值证据及 Actions artifact 校验信息。

```bash
node scripts/verify-html5-mechanisms.mjs --root local/private/html5-online/games \
 --script 1-forest-temple/js/game.js --require-script lib/require.js \
 --entry-path /1-forest-temple/index.html \
 --expected-sha256 98666cf499473dfadb9b708af10ef2e5e13b50300881a32b7c8d65d7756a5700 \
 --level-id 52 --seat 1 --direction=-1 --out local/original-mechanism-test
```

这是用户上传原包的**可执行复现命令**，并不意味着该命令已经在用户 ZIP 对应运行包上实测通过。固定研究候选的成功、用户原包的哈希/静态审计和公网发布权利必须分开记录。

## 仍未验收

按钮松开后的回弹与平台完整复位、杠杆交互、完整关卡通关与死亡重开、用户 ZIP 独立实测、互联网延迟与资源授权。下一步继续围绕这些项目做可失败的真实测试。
