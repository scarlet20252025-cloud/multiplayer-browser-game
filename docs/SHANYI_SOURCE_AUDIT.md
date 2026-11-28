# 闪翼双星源码静态审计

审计日期：2026-11-17。输入：用户上传的 `flash-archive-源码版-20261117.zip` 解包目录。

**结论：能定位双人输入与物理循环，但当前材料不是已经恢复的可编译 HTML5 或 Flash 工程。尚未复编 SWF、修改原游戏字节码或验证原游戏联机。**

**2026-11-18 运行补充**：原包已在 Adobe Flash Player 32 projector 中运行到第一关，并确认两名角色可独立操作；Ruffle 0.7.1 与 nightly 2026-11-18 仍无法运行同一包。运行证据与限制见第 7 节。

本文件描述的是读取实际文件得到的结果。下面的接入位置是候选改造点，不是已经应用的补丁。

## 复现方式

在仓库根目录运行，输入必须是已解包目录：

```bash
python3 scripts/audit_archive.py "/path/to/flash-archive-源码版" --output local/reports/archive-audit.json --manifest local/reports/archive-file-manifest.json
```

工具仅遍历、读取、解码和哈希文件，不导入或执行被检查的代码。报告必须输出到输入目录之外。`--manifest` 可省略；完整原始源码不需要进入公共仓库。

本次输入清单摘要：

| 项目 | 实际值 |
| --- | ---: |
| 总文件数 | 4,425 |
| 解包文件总字节数 | 37,280,624 |
| ActionScript 文件 | 3,594 |
| ASASM 文件 | 376 |
| JSON 文件 | 283 |
| SWF / ABC / JavaScript / HTML 文件 | 均为 0 |
| 已识别的图片、音频、字体资源文件 | 0 |

清单摘要 SHA-256：`0ccefa7e389ffe7341a04a8ab224270a74f55fc46a335a22f40c822eec69eb1b`。算法是按相对路径排序后，对每项的路径、字节数、文件 SHA-256 组成的清单计算 SHA-256；它不是 ZIP 文件本身的哈希。

归档中 README 描述的完整包体、图片和工具不等于这次源码版附件实际包含的文件。当前材料不足以执行原游戏播放或二进制补丁测试。

## 1. 正传与续作的反编译质量

以下路径相对于 `01-shanyi-binary/`：

| 子目录 | `.as` 文件 | 含 `§§` 的文件 | `§§` 出现次数 |
| --- | ---: | ---: | ---: |
| `core-decompiled/script/scripts/` | 987 | 955 | 27,091 |
| `lightning-decompiled/script/scripts/` | 1,348 | 115 | 1,122 |

正传实际为 987 个 `.as`，与原归档 README 的 988 个描述不同。统计范围是本次附件中的实际文件。

`§§push`、`§§pop`、`§§findproperty` 等是反编译器用于表达未还原字节码的伪表示。正传 `Main.as` 有 176 行含这些标记，`Level.as` 有 193 行。它们不能直接被视作正常 AS3 源码。**没有进行编译尝试，不能把这里的静态检查表述为某个编译器已实测失败。**

## 2. 正传双人输入入口

本节文件相对于 `core-decompiled/script/scripts/`，行号按原文件的文本行计数：

| 文件与行号 | 观察到的事实 | 接入含义 |
| --- | --- | --- |
| `hero/FireManHero.as` 67、80–82 | 火角色使用 W / S / A / D | 网络席位应绑定此角色 |
| `hero/IceManHero.as` 72、84–86 | 冰角色使用方向键 | 第二席位应有独立输入状态 |
| `Level.as` 318、331 | 按实例名取得 `fireMan`、`iceMan` | 原运行资源中的实例命名参与初始化 |
| `Level.as` 343–344 | 另有 `fireManInBoat`、`iceManInBoat` 分支 | 适配不能只覆盖普通角色形态 |
| `hero/Hero.as` 1291、1333–1336 | `parseInput` 读取 `kd` 与 `kp` | 必须保留持续按住与按下边沿的区别 |
| `misc/Input.as` 90、92–93 | 注册帧末清理和真实键盘事件 | 网络模式要有唯一输入来源与清理时机 |
| `misc/Input.as` 108–122、124–155 | 维护按住、刚按下、刚松开集合 | 可以作为输入桥的语义依据 |
| `misc/Input.as` 158–205 | 每帧清除刚按下、刚松开状态 | 不能按网络收包次数清除 |

`misc/Input.as` 是较集中的输入接入候选。网络协议应表达每个席位的动作与边沿，适配层再建立对应的旧按键状态。只修改 `Hero.parseInput` 中四个读键位置，未必覆盖梯子、飞行等其他读键分支。

## 3. 物理步长与舞台帧率必须分别处理

| 文件与行号 | 观察到的事实 |
| --- | --- |
| `wck/World.as` 58 | 默认 `timeStep = 0.05` |
| `wck/World.as` 143 | 舞台 `ENTER_FRAME` 驱动 `step` |
| `wck/World.as` 405–416 | 一次 `step` 调用一次 `b2world.Step(...)` |
| `Box2DAS/Dynamics/b2World.as` 354–367 | 记录 `getTimer()`，构造并派发 `StepEvent` |
| `Box2DAS/Dynamics/b2World.as` 424 | 调用 Alchemy 库导出的 `b2World_Step` |
| `Level.as` 703、718–719 | `boom()` 把物理步长设为 0.02，并把舞台帧率设为 15 |
| `Level.as` 709–715、726 | 按帧倒计数，随后恢复步长 0.05、舞台帧率 30 |

这里的 30 FPS 是源码中明确写出的恢复值；由于没有 SWF，本次没有读取原包头的初始帧率，也没有运行确认变速效果。

将整个旧游戏直接改成 60 Hz，或只远程触发物理 `Step`，都不能被视为等价迁移。双击计数、动画、慢动作恢复和其他 `ENTER_FRAME` 回调也参与运行。跨游戏的具体约定见 [输入与时钟契约](INPUT_AND_CLOCK_CONTRACT.md)。

## 4. Alchemy 和显示列表是实质依赖

`Box2DAS/Common/b2Base.as` 39–41 使用 `CLibInit` 初始化库和 `MemUser`，49 行取 `gstate.ds`；正传有 656 个文件出现 `cmodule.Box2D`。这不是可直接导入 Node.js 的纯 JavaScript 物理库。

正传还存在：

- `hitTestObject`：17 个文件，97 次。
- `currentFrame`：23 个文件，146 次。
- `Math.random`：13 个文件，53 次。
- `getTimer`：4 个文件，8 次。

这些是词法计数，不保证每个匹配都会在运行中执行。已检查到的具体玩法依赖包括：

- `hero/Hero.as` 174–205：按实例名读取碰撞部件和各种动作 MovieClip。
- 同文件 568：梯子判断使用身体和头部的显示对象碰撞。
- 同文件 604：池子接触使用 `hitTestObject`。
- 同文件 1633、1648、1790：飞行和攀爬判断读取动画当前帧。
- `enemy/DroppingBee.as` 94：随机选择投放横坐标。
- `enemy/FatRabbitBoss.as`：存在多处随机 AI 分支。

因此，资源 SWF 可能同时提供显示对象、碰撞几何、关卡实例和时间轴。仅有 `.as` 文件，不能保证恢复这些信息。相同输入也不能直接保证多个运行实例一致。

## 5. 续作不能作为正传双人测试的替身

在 `lightning-decompiled/script/scripts/` 中：

- `game/gameObjects/Hero.as` 319–322 将 A/LEFT、D/RIGHT、W/UP、S/DOWN 合并为同一个角色的输入。
- `game/pages/levels/Level1.as` 52 只绑定 `hero1 = flash1`。
- `game/pages/levels/Level.as` 34、36 声明两个角色字段，67–78 有双角色镜头分支。

这些事实不足以证明续作当前提供两名玩家的独立操作。能运行续作、能使用两套按键，不等于正传双人联机已通过。

## 6. 后续实验的边界

当前能完成静态审计、输入语义提取和独立网络机制实验。输入模型通过测试，只能说明模型和传输满足约定，不能说明原游戏运行正确。

补齐运行包后，建议按以下次序验证：

1. 先运行未修改原包，确认加载、关卡和双人操作正常。
2. 对原包增加小范围输入桥，保留原来的角色规则和资源。
3. 确定整个 Flash 帧、定时器、随机与慢动作的驱动方式；输入序列重播后检查玩法状态是否一致。
4. 若不能稳定控制这些依赖，再评估抽取碰撞/关卡数据并迁移规则的工作量。

目前没有足够证据承诺“少量 AS3 修改即可直接成为 Node 权威游戏”。尚待补齐 SWF 和资源，并进行原游戏运行验证。

## 7. 原包运行验证（2026-11-18 补充）

本节只记录本机运行事实；原包保持只读，测试产物在 `local/reports/shanyi-runtime/`（不入库）。

### 7.1 环境

| 项 | 实际值 |
| --- | --- |
| 系统 | Windows 10.0.26100 x64 |
| Flash 运行器 | `02-fireboy-watergirl/tas-src/tools/flashplayer.exe`，Adobe Flash Player 32.0.0.453，PE32 i386 |
| 浏览器运行器 | Ruffle 0.7.1（仓库锁定）与 nightly 2026-11-18，Playwright Chromium |
| 4399 平台模块 | `http://cdn.comment.4399pk.com/control/A4399dv_base.swf` 可访问（HTTP 200，1,135 字节） |

项目器不能直接从 Bash 启动（任何参数都立即 exit 1），但用 32 位 `cmd.exe` 启动可正常显示窗口：

```bash
C:/Windows/SysWOW64/cmd.exe //c "C:\\tmp\\fp32.exe E:\\...\\shanyi-binary.swf"
```

### 7.2 结果矩阵

| 输入 | 运行器 | 结果 |
| --- | --- | --- |
| `shanyi-binary.swf` | Flash Player 32 | **通过**：4399 标志 → 标题菜单 → 剧情 → 操作教学 → 第一关「秘密实验室出口」 |
| `core-game.swf` | Flash Player 32 | 能显示标题菜单，但画面静止；点击「开始新游戏」不推进，4399 外壳的启动调用缺失 |
| `core-game.swf` | Ruffle 0.7.1 / nightly | 黑屏；AS3 已执行（800×600@30、无页面异常） |
| `shanyi-binary.swf` | Ruffle nightly | 停在 4399 标志，未进入标题菜单 |
| `extracted-C-lightning.swf` | Ruffle 0.7.1 | 标题与「2012」过场可见，45 秒后仍未进入玩法 |

### 7.3 双人操作

进入第一关后：

- 按住 `D` 1.5 秒，蓝色角色向右移动；粉色角色不动。
- 按住 `Right` 1.5 秒，粉色角色向右移动，镜头跟随；蓝色角色不受该按键驱动。

这说明原包的双人独立输入仍然有效，第 2 节的源码审计（W/S/A/D 与方向键）与运行行为一致。

### 7.4 Ruffle 失败的定位

对 `core-game.swf` 的 `fw` 类按方法体注入 `throw` 作为追踪通道：

- `checkAndPlay()`（body 24）会执行，异常文本出现在 Ruffle 控制台。
- 加载下一段的 `Event.COMPLETE` 回调（body 29）从未执行。
- 换成 nightly 2026-11-18 后结果相同。

因此黑屏不是「AS3 完全没跑」，而是 `Loader.loadBytes` 的链式分段加载没有走完；4399 外壳版本还停在平台标志。该行为属于 Ruffle 兼容性边界，补资源或调播放器参数都未改变结果。

### 7.5 对加入网页大厅的含义

当前大厅的权威端与观看端都是 Chromium + Ruffle。原包在 projector 中可玩，证明游戏本身与双人输入完整，但这不能直接用于浏览器联机：

- Ruffle 无法执行该包的加载链，加入大厅后仍是黑屏。
- Flash projector 是 Windows GUI 进程，不能被浏览器标签页承载；用它做权威端需要额外的桌面采集、输入注入与进程管理，现有服务未实现。
- 若要联机，需要另做 AS3→JS 重写或改造加载链，属于独立工程，不是补一段适配器即可完成。

结论：**本次测试支持「原包可本机运行、双人输入有效」，不支持「闪翼双星可以接入当前浏览器联机大厅」。**（该结论随后被第 8 节的有壳路线部分修正：仅限实验性输入镜像，原包仍不能独立在浏览器中运行。）

## 8. 浏览器输入镜像准入（2026-11-18）

第 7 节失败的是「直接把原包丢给 Ruffle」。在不改写原 SWF 的前提下，新增一个自写 AS3 外壳 `adapters/shanyi-flash/src/ShanyiHost.as`，编译为 `shanyi-host.swf`，由它用 `Loader.load(new URLRequest(game), new LoaderContext(false, ApplicationDomain.currentDomain))` 载入只读的 `core_4_abc.swf`。外壳只做三件事：转发键鼠事件、修正过场着色、通过 `ExternalInterface` 暴露 `shanyiPage`/`shanyiButtons`/`shanyiClickAt`/`shanyiKey` 等自动化桥。游戏逻辑、素材和存档格式都没有改动。

外壳源码进入仓库；编译产物与原始 SWF 一样只放在 `local/private-games/shanyi/`，不进入公开仓库。重新构建需要 AS3 工具链（本地忽略目录中的 Flex SDK）：

```bash
local/tools/as3-probe/apache-flex-sdk-4.16.1-bin/bin/mxmlc \
  -compiler.library-path=local/tools/as3-probe/playerglobal32_0.swc \
  -compiler.external-library-path=local/tools/as3-probe/playerglobal32_0.swc \
  -target-player=11.1 -swf-version=14 -static-link-runtime-shared-libraries=true \
  -output local/private-games/shanyi/shanyi-host.swf adapters/shanyi-flash/src/ShanyiHost.as
```

### 8.1 运行条件（缺一不可）

| 项 | 值 | 失败表现 |
| --- | --- | --- |
| Ruffle | nightly 0.8.0-nightly.2026.11.18，本地忽略目录 | 稳定版 0.7.1 黑屏 |
| 渲染器 | 默认 wgpu | canvas 渲染器无法完成关卡构建的 `BitmapData.draw` |
| `maxExecutionDuration` | 600 秒 | 默认 15 秒会把 `drawBigBMD` 当死循环终止，关卡停在 loading |
| 缩放 | `scale=showAll`，`letterbox=on` | 坐标映射错误会导致点击落空 |

### 8.2 已实测

- 生产宿主 `scripts/html5-research-host.mjs` 提供 `/shanyi/index.html`、`/__ruffle__/` 允许列表和只读 `/game/<gameId>/`；原始 SWF 只从 `local/private-games` 读取。
- 舞台按 4:3 自适应填满视口并居中；Ruffle 宿主与 canvas 都设为 100%。1100×800 视口中实测 canvas 为 1066×800（此前固定为左上角 550×400）。
- Playwright + Chromium（启用 SwiftShader）中，页面从 4399 标志进入标题菜单（`pages::MainPage`），按舞台坐标缩放点击后进入剧情页（`pages::IntroPage`）。
- 基准宿主 `maxexec=600` 下继续走到操作教学和第一关，第一关完整渲染；原生键盘与 `ExternalInterface` 注入都能分别驱动火娃（WASD）与水娃（方向键），镜头跟随。
- `server/shanyi-mirror-room.mjs` 的双席位回环中继已由单元测试和真实双 token 会话验证：转发 `input`/`click`/`presence`/`hero-state`/`ready`，拒绝错误 token 和第三席位。
- 双方就位门禁：游戏页在 Ruffle 启动并可用后发送 `ready`，服务器广播 `ready-state`；两端都 ready 前显示“等待双方就位”遮罩，按键、画面点击和转发输入都不生效。大厅层同时要求两位玩家都在房间内才允许提议/确认关卡。
- `scripts/verify-shanyi-dual.mjs` 已验证两个 Ruffle 标签页同时启动：两端都到达标题菜单（`pages::MainPage`），在座位 0 点击开始后，座位 1 也注入同一点击并进入 `pages::IntroPage`，两端无页面错误。
- 新增英雄状态纠偏：每端约 30Hz 发送自己角色的显示坐标与速度，对端通过 wrapper 的 `shanyiApplyHero` 调用 `SetTransform`/`SetLinearVelocity` 追上。`scripts/verify-shanyi-sync.mjs` 实测按住 D 时两端火男坐标完全一致；按住方向键时水女移动中最大差约 5px，松开停下后两端完全一致。
- 控制键按席位隔离：页面在捕获阶段拦截 W/A/S/D 与方向键，只把自己席位的按键注入本机游戏并中继；另一席位的按键既不注入也不传给 Ruffle。验收脚本在座位 0 按方向键、座位 1 按 D，确认两端 `keysDown` 都保持为空，因此不会出现“同一角色被两人同时控制”。
- 暂停/继续双边同步：游戏暂停由 `Main.onFocusOut` 触发，恢复依赖舞台点击 `onFocusIn`。中继点击在坐标处没有按钮时会补发舞台点击，因此对方暂停后点击空白处也能恢复。验收脚本实测点击暂停按钮后两端均为 `paused=true overlay=true`，再点击画面后两端均为 `paused=false overlay=false`。

### 8.3 联机声明边界

`config/games/shanyi.json` 只声明 `mirrorInput`，不声明 `authority`、`spectator`、投票或存档；大厅卡片标注「实验·输入镜像」。两名玩家各自运行一份本地 SWF：服务器转发输入边沿，并以约 30Hz 转发各自英雄的位置/速度供对端纠偏；不传画面，也没有服务器端权威状态或确定性锁步。返回选关已接入双方请求/确认/取消投票；跨区域坐标差超过 180px 时客户端会跳过对端英雄纠偏，避免镜头追到空白区域。`levels.json` 当前只登记第一关；更多关卡需要逐关验收后才能加入。

### 8.4 尚未验证

- 长时间运行、复杂机关和两人同时移动时的物理漂移；当前只验证了单键移动与停下后的收敛，没有逐帧状态比对。
- 低性能机器上两个 Ruffle 实例的帧率；当前误差范围来自本机 headless 测试。
- 断线重连后的输入重放边界。
- 第一关之后的关卡和存档等 HTML5 已有能力在镜像层未实现；返回选关投票已实现，但未做长局和断线重连后的完整验收。

### 8.5 房间层重构（2026-11-28）

闪翼原来的房间逻辑是手写的席位数组 + 准备数组 + 返回投票，和冰火人、合作关卡用的 `Html5RoomCore` 是两套实现。本轮把它并到同一条线上：

- 席位、准备、返回投票改由 `server/html5-room-core.mjs` 管理；`server/shanyi-mirror-room.mjs` 只保留镜像转发（输入边沿、点击、在线页、英雄位置/速度）。
- 断线席位交给 `server/seat-presence.mjs`：意外断开保留 20 秒，带 `?resume=<token>` 回来坐回原位；主动 `{type:'leave'}` 立即释放。
- 对外消息形状保持兼容：`welcome` / `peer-connection` / `ready-state` / `return-request` / `return-state` / `return-approved` / `return-cancelled` / `mirror-error` 不变，只新增 `welcome.resumeToken`、`welcome.resumed`、`welcome.resumeGraceMs`、`ready-state.seats[].reserved`、`peer-connection.reserved` 和 `/health` 的 `room.reserved`。
- 客户端 `scripts/shanyi-mirror-client.mjs` 把票存进 `sessionStorage`，断线后按 0.6→3 秒退避重连，20 秒内回到原席位，超时才提示返回大厅。

已由 `tests/shanyi-mirror-room.test.mjs` 覆盖：双席位转发、错误 token/第三席位、断线续租、过期票失效、主动离开立即释放；`tests/seat-presence.test.mjs` 覆盖租约本身。真实双标签页的断线重连仍需在装有 Ruffle 与私有 SWF 的环境跑一次 `scripts/verify-shanyi-sync.mjs`。

### 8.6 输入帧对齐与分叉门禁（2026-11-28）

镜像层最容易被忽略的问题是「同一帧的两个按键在两端落在不同帧」：原来每次 keydown/keyup 立即注入并立刻转发，网络抖动会让同一批按键在两端相差一到两帧，跳跃和机关判定就会分叉。本轮把输入改成帧对齐：

- 客户端把本地边沿先入队，每 16ms 一帧统一应用，并按「P1 先、P2 后」的固定顺序合并两端边沿；只把本帧新增的边沿作为 `input-batch` 发出。
- 服务端校验批次（1–16 个边沿、code 0–255）后转发为 `peer-input-batch`；旧的单条 `input` 仍然兼容。
- 收到对端 `presence` 页名后记录到席位；两端页名都已知且不同时（一边在菜单、一边在关卡），移动键不再转发，并回 `PAGE_MISMATCH` 附带两端页名。旧客户端只发 `input` 时同样受这个门禁保护。
- 席位置空或断开时清掉页名，避免旧页面状态卡住下一局。

这些改动只解决「输入顺序与页面一致性」，不改变闪翼没有权威状态这一事实：机关、随机数和计时累积仍可能让两端缓慢分叉，长时间对局与复杂关卡仍需实测。测试覆盖批次顺序、页名不一致时的错误码与两端页名回传。

## 编码记录

本次源文件扫描没有 UTF-8 解码失败。另一个游戏的 `02-fireboy-watergirl/decompiled/3-export/script/scripts/system/Strings.as` 第 344 行包含一个字面量 U+FFFD。它可能是字符处理逻辑中的常量；工具仅报告它的存在，不将其自动判定为损坏，也不改写原文。`§§` 是有效 UTF-8 的反编译标记，不能与编码乱码混为一谈。
