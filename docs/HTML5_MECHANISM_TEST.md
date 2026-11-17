# 真实第 27 关：按钮和升降平台联动试验

当前判定：**待真实回归，不提前标 passed**。

## 源码核实：地图的 gid 不是固定物品类型

用户上传的第一代森林圣殿关卡 `data/forest/levels/forest_27.json` 的 Objects tileset 的 `firstgid=26`。因此地图对象 `gid=26` 对应相对 tile ID 0，也就是 **pusher（按钮）**，不是杠杆。之前把该数字当作全局固定枚举，误选了地图远处的杠杆。

运行时诊断 [CI #44081412726](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44081412726) 已证实：
- 火娃的初始位置约 (768, 733)。
- 附近的 `pusher` 按钮位于 (672, 672)，属于 `group=3`。
- 对应移动平台位于 (400, 848)，同为 `group=3`。
- 远处两根 `lever` 为其他组，不应当作本试验目标。

具体源码：`game.js` 的 `Pusher.checkState` 在 39920–39925 行，以 `joint.GetJointTranslation()` 判断按钮按压，随后发射原版 signal；`MechManager.deviceChanged` 位于 43295–43300 行，按 group 更新关联机关。地图机关类别必须依据每一关 tileset 的 `firstgid` 与 `tiles[].type` 解析，或实际运行对象的 `options.type` 校验。

## 研究试验和通过标准

`scripts/verify-html5-mechanisms.mjs` 使用两条正常 WebSocket 席位连接，由火娃向左移动，接近按钮时按真实跳跃键；不写角色/按钮/平台坐标，不调用 `checkState()`，不制造人工碰撞。

必须同时看到服务器已消费火娃输入、**按钮的真实 state 改变**、**同组平台的实体位置移动**才能判定该试验 passed。失败时输出 `local/html5-mechanism-results/mechanism-trace.json`，含所有发现的运行时实体、按钮、平台、输入确认和轨迹。固定研究候选版本的通过不能替代用户上传版的实机回归。

## 状态边界

前两轮 CI 有可追溯失败：[#44080544314](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44080544314) 错选远处杠杆、[#44080901689](https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44080901689) 因“近处按钮并非杠杆”误报没有配套平台。这些都是工具/分类假设错误，不是原版联机已成功或已失败的证明。详细信息和新测试以最新 Actions 结果为准。
