# 真实游戏机关触发试验（无作弊、无视频串流）

这个实验测试森林冰火人 HTML5 正式关卡 27 的杠杆与同组平台。采用两个真正的 WebSocket 客户端，仅通过服务器已验证的席位输入字段 moveX/buttons（含短暂跳跃）驱动原游戏。不会写入角色物理位置、机关 state、碰撞或地图。

选择依据：用户实际上传的 forest_27.json 中杠杆位于 (640,704) 左右、所属 group 3；同组平台在 (384,800)。火娃初始位置近于杠杆。原版 JS 的 Lever.checkState 根据物理关节角度决定状态，MechanismManager 根据 group 关联平台。

验收要求：同一关中真实角色有输入消费确认、杠杆 state 改变、同组平台实体位置移动。只有三项都有测量证据才标 passed，否则 blocked，保留完整采样时间线。CI 使用固定研究候选；它与用户上传 ZIP 不是同一源码 SHA，不能混淆结论。

测试运行：`node scripts/verify-html5-mechanisms.mjs --root local/html5-candidate/output/A --script js/init.eb02fbdab2aa1d24.js --level-id 27 --seat 0 --direction -1 --out local/html5-mechanism-results`。来源权利和原包不上传规则保持不变。
