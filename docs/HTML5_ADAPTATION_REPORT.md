# HTML5 第一代：跳跃、暂停与状态导出

日期：2026-11-17。主线保持 HTML5、单权威和非视频同步，Flash 已排除路线不重试。

## 1. 本轮输入与结论范围

接手基线为 `96c3ec7fdc4fcbe2e6e717c74cf52b96e5ab1604`。先读取了 `HANDOFF_TO_NEXT_AGENT.md`，沿用本地 Agent 已完成的输入桥等结论。

当前环境没有用户电脑上的 `html5-online`。本轮沿先前归档 README 已列出的来源取得第一代**研究候选**：

- 来源仓库：<https://github.com/1224HuangJin/Fireboy-and-Watergirl>。
- 固定提交：`8568034556f567b5c429c0223dc1bf6dd2409277`。
- 脚本：`output/A/js/init.eb02fbdab2aa1d24.js`，2,218,873 字节、54,323 行。
- SHA-256：`337125629748bace45e23b040e54b0d206e4cd78c9c8709d7785faa637e00677`。
- 跳跃 43124、P 注册 44830、角色创建 45023、Game 创建 54053 等锚点与交接文档吻合；**用户本机 game.js 的哈希尚未提供，不能确认逐字节相同**。

这是第三方研究副本，不是发行方提供的授权自建版本，也不作为未修改原版基准。候选自身已有 GameConfig/调度改写，以及 54095–54099 的域判断改写；本轮不修改这些逻辑。候选入口还包含额外的 `multiplayer.js` 和上报脚本，研究宿主不加载该入口，而使用独立、明确标识的实验 HTML。

游戏与素材版权仍归原作者。本仓库只提交原创适配器、工具和生成的观察数据。原包、研究候选、资源、第三方 HTML/JS 一律留在忽略目录；本轮没有把它们提交到公共仓库。

## 2. 验证状态

当前容器的固定 Playwright 浏览器未安装，系统 Chromium 启动又遇到 `socket() failed: Operation not permitted`。没有绕过环境限制。

已完成：真实候选源码的静态定位、原创观察/适配模块、自动运行脚本。55 项 Node 测试和 13 项 Python 测试在当前环境通过，新增模块的测试使用原创夹具，不等于原游戏实测。

真实浏览器验证交给独立工作流 `Verify HTML5 candidate adaptation`。**在生成实际运行结果之前，本节不将三项原游戏检查标为 passed。** 工作流仅在临时忽略目录取固定候选，产物只上传生成的 JSON；不上传原包、HTML、JS、素材或游戏截图。

| 任务 | 已完成的代码与静态结果 | 本轮浏览器状态 |
| --- | --- | --- |
| 跳跃边沿 | 记录真实 Box2D Step 后的 body.y、输入、锁存和接地；完成轨迹判定器 | 当前容器 blocked；CI 待结果 |
| P 暂停拦截 | 确认 game.paused 与 Box2D.paused 不同；P/HUD/Resume 统一请求接口 | 当前容器 blocked；CI 待结果 |
| 状态导出 | 已定位真实容器，导出角色/钻石/门/杠杆/按钮/平台观察及差异 | 当前容器 blocked；CI 待结果 |

## 3. 跳跃：源码与验证方法

以下行号统一对应第 1 节哈希的候选 JS：

| 行号 | 观察 |
| --- | --- |
| 43061–43064 | 角色更新在关卡结束或物理暂停时不推进普通动作 |
| 43124 | 松开 up 后清除 prohibitJump |
| 43125 | 起跳要求未锁存、up 按住，以及足部接触的地面条件 |
| 43128–43140 | 应用跳跃冲量/速度 |
| 43149 | 真正起跳后设定 prohibitJump |

静态代码支持“按下锁存、松开解除”的设计；**是否在选定关卡、运行时中表现为一次跳跃，需要实际轨迹**。

`jump-observer.mjs` 包装原 `world.Step`，以原 receiver、原参数执行原函数后采样，返回原结果；不改变 dt、重力、角色坐标或锁存值。记录的计数明确叫 `observedPhysicsSteps`，不冒充渲染帧或完整游戏 tick。

实验顺序为稳定站地 → 持续按住至少 2 秒 → 松开并等待游戏消费 → 再按住至少 2 秒。轨迹包含每次 Step 的 `water.y`、`fire.y`、按键、锁存、接地数量、两种暂停字段和实例是否改变。

判定要求不仅是“两秒内没有第二跳”，还必须观察到完整离地/落地以及仍按住时的连续站地尾段。缺失 Step、暂停、角色重建、短暂触地后继续下落、没有消费松开、过大采样间隙都不能 passed。阈值在分析器中固定记录，原始轨迹保留供复核。

## 4. 暂停：不能只看 Box2D.paused

| 行号 | 实际路径 |
| --- | --- |
| 44566、44830–44831 | 关卡先绑定 togglePause 的 this，再把该函数注册到 P 的 onDown；默认 context 为 null |
| 44915–44921 | togglePause 翻转 **game.paused**，联动菜单 show/hide 和 clock pause/resume |
| 10495–10503 | game.paused setter 维护引擎 `_paused`、声音、时间、输入重置和信号 |
| 10406–10429 | `_paused` 时走 pauseUpdate，跳过普通 physics.update |
| 44843–44846 | Box2D 另有 paused 和 Step 门控，两者不能混用 |
| 43995–43996、44201–44202 | Resume 与 HUD 暂停按钮动态调用 level.togglePause |

所以 **P 可间接阻止物理推进，而 physics.box2d.paused 本身仍为 false**。真实验证同时观察两个字段、Step 计数和玩法计时。

`pause-bridge.mjs` 精确移除原 P 监听，保留其他监听；替换 `level.togglePause`，同时覆盖已确认的 HUD/Resume 动态调用。按键和这些 UI 方法只产生 `pause.set` 请求。只有 `applyAuthoritativeState({roomEpoch, revision, paused})` 才使用捕获的原暂停函数应用权威结果，保留菜单和 clock 的行为。

请求使用显式目标状态、递增 sequence 和 commandId，重试沿用同一 ID；重复/旧 revision 不再翻转。换关、卸载与重装有独立处理。

**接口边界：当前生产实验服务器 `server/index.mjs` 尚未接入此 room-command 协议。** 本轮真实脚本检查“P 只发请求、本地继续推进”和“显式权威状态应用后才暂停”，请求接收器是研究脚本，不是已完成的匹配服务器。焦点、广告等直接改 game.paused 的其他路径也须在正式房间接入时统一管理。

## 5. 状态：真实实例在哪里

| 对象 | 真实实例容器 | 源码位置与状态字段 |
| --- | --- | --- |
| 两角色 | `level.pers1`、`level.pers2` | 45023–45024；body、data、cursors、bodyParts |
| 钻石 | `game.layers.underGround.children` 中真实 `Devices.Diamond` 实例 | 38336–38367；收集后 destroy 在 38394–38395 |
| 门 | `level.door1`、`level.door2` | 45027–45028；38454–38479 的 isOpen/isUp/currentFrac、动画输出帧 |
| 全部机关 | `level.objects` | 44814、45010–45014 |
| 联动机关分组 | `game.MechManager.deviceGroups[group][]` | 43245–43251、43296–43299 |
| 杠杆 | type 为 lever；`body` 与 `body.sprite` | 38693–38752；state、位置、显示杆 |
| 按钮 | type 为 pusher；**`button.body`** | 39871、39905–39927；state、按钮位置 |
| 平台 | type 为 platform；`body`、`sprite` | 39240、39278、39316–39322；state、位置与显示 |

类型映射依据 43305–43325，不根据压缩后的 constructor.name 猜测。`body.x/y`（37383–37396）返回像素；body.rotation（37375–37377）为弧度。

`state-snapshot.mjs` 用持续 WeakMap 给实际实例分配 ID，合并对象在两个容器中的别名。关卡/root/角色实例换新时更换 levelEpoch；容器 getter 不被递归执行，已核实的 body/sprite API 字段显式读取。未知机制和不可读字段保留在 unsupported。

导出角色、钻石、门与至少一种支持机关，并保存两次快照及按 ID 比较的差异。钻石从容器消失只表示本次未观察到，不凭此单独推断收集事件。快照不是完整显示状态、物理检查点或回滚存档；客户端应用快照和禁止本地规则副作用尚未完成。

## 6. 在用户本机复现

保持当前工作分支，安装锁定依赖和对应 Chromium。Windows 示例（替换为实际目录）：

```powershell
npm ci
npx playwright install chromium-headless-shell
node scripts/verify-html5-adaptation.mjs --root "E:\肥鱼不乐园\flash-archive\02-fireboy-watergirl\html5-online\games\1-forest-temple" --script js/game.js --out local/html5-results/local-forest-1
```

Linux 同样使用 `node` 命令，调整 --root；浏览器系统依赖可用 `npx playwright install --with-deps chromium-headless-shell` 安装。

宿主只监听 127.0.0.1，原文件只读；唯一 Game 实例暴露只发生在 HTTP 响应里。脚本会记录 sourceSha256、servedSha256、原件前后是否一致、运行环境、诊断、跳跃轨迹、暂停观察和两个快照。若源文件锚点不同、依赖缺失或浏览器不能启动，记录 blocked；不要手填成功。

默认验证寺庙数据中的 id=1。可用 `--level-id` 指定其他实际关卡；每个结果必须保留关卡 ID 与 filename。内置 unlock 开关为 true、无敌为 false，记录在报告；不会传送角色、改物理或改平台 SDK。

输出：`report.json`、`jump-trace.json`、`pause-observations.json`、`snapshot-a.json`、`snapshot-b.json`、`snapshot-diff.json`（只有执行到相应步骤才存在）。缺文件就是未完成，不能拿旧输出替代；report.files 只列本次生成文件及哈希。

## 7. 后续边界

本轮结束后仍需正式接入房间命令、角色输入消费和状态广播，并实现客户端显示应用与规则隔离，再做真实双客户端及异地网络验收。不会因为状态能导出就把整款原游戏标成已联机。

Windows 提取器夹具的换行哈希缺陷已修复：测试夹具改为写确切 UTF-8 字节，保持原始字节哈希约定。本轮 Linux 13/13 通过；当前容器没有 Windows 实机，不另写 Windows 已实测通过。
