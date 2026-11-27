# 疯狂小人乱斗联机调研

## 原作源码追踪

- 《疯狂小人乱斗》对应《The Fight for Glorton》。Florian Segginger 的作品集确认原版用 ActionScript 2.0 编写。原版支持一台电脑上用一个键盘供 1–4 位玩家操作。在作者作品集、原发布页和本地 Flash 档案中未找到可核实的作者原始 `.fla` 或 `.as` 工程。[程序作者作品集](https://segginger.com/portfolio) · [作者发布页](https://www.newgrounds.com/portal/view/378745) · [Armor Games 操作说明](https://armorgames.com/play/1108/the-fight-for-glorton?rt=l)
- Flash 档案索引能查到已编译的 SWF 发行物。该格式保存可执行的字节码和资源。工具据此还原的 ActionScript 是反编译输出，原始工程文件仍未找到。[Flash 档案索引](https://ooooooooo.ooo/?id=96fb0532-a836-9118-2d5b-960fb0d6de2b)
- 灵动游戏提供原作汉化入口。[《疯狂小人乱斗》汉化版](https://www.mhhf.com/game/detail/6014)

## 已发布的联机版本

- `james123wang5/fight-for-glorton-remake` 的主分支 README 仍写着联网对战尚未接入。单独发布的 `v0.95-online` 标签包含电脑版房间码联机源码，版本说明列出两位真人同步选角、40 Hz 权威战斗服务器、延迟和抖动显示，以及最长 25 秒重连。P3 和 P4 为可添加的电脑对手。[联机版本发布页](https://github.com/james123wang5/fight-for-glorton-remake/releases/tag/v0.95-online)
- 联机说明使用 Python/Pygame 客户端和自建 WebSocket 服务，包含本机双开、Windows 安装和公网服务地址配置。文档标注该入口为电脑版，手机 PWA 走独立入口。[标签内联机说明](https://raw.githubusercontent.com/james123wang5/fight-for-glorton-remake/v0.95-online/docs/ONLINE_MULTIPLAYER_CN.md)
- 联机标签指向提交 `61f5f27cbae71f36b423cf5ce784932148bd9777`。其中有 Python/Pygame 客户端和联机服务，未见原版 ActionScript 工程或仓库许可证。项目说明将运行素材的权利保留给各权利方。[联机标签源码](https://github.com/james123wang5/fight-for-glorton-remake/tree/61f5f27cbae71f36b423cf5ce784932148bd9777) · [项目素材说明](https://github.com/james123wang5/fight-for-glorton-remake#原版素材说明)
- 233 乐园的同名作品提供 2–6 人远程联机。公开游戏页和创作平台文档中没有找到该作品的自托管源码或可接入现有大厅的联机接口。[233 乐园作品页](https://www.233leyuan.com/game-detail-h5/2727165) · [多端联机平台文档](https://maker.ark.online/discover/multiplayer-games)
- Flashpoint 可归档本地玩法。其维护者说明 Flashpoint 本身不提供远程多人能力。[Flashpoint FAQ](https://flashpointarchive.org/faq)

## 本机双人实测

- 用固定提交的原样联机服务和校验通过的发布素材，在 `127.0.0.1` 上用两个独立 WebSocket 客户端建房、进房、同步选角和开战。实测服务器为 40 Hz，双方在 Mogadishu 地图分别向对方移动。断开 P2 后对局暂停，带原席位凭证恢复后两端重新收到一致的战斗状态。上游 10 项联机测试全部通过。[运行素材发布页](https://github.com/james123wang5/fight-for-glorton-remake/releases/tag/v0.95-online)
- 实测 Windows 的 Pygame 在扫描系统字体时会因一个整数注册表项抛出 `TypeError`。`scripts/launch-glorton-client.py` 给当前客户端进程提供 Arial 和 Pygame 默认字体兜底。使用该修复后，两个发行版桌面客户端通过实际键盘事件建房、加入和选角，各自渲染 1280×760 对战画面，并在 Mogadishu 实战中独立移动。实测网络为本机回环；跨公网的两台电脑尚未实测。

Windows 客户端安装依赖后，在激活了发行版虚拟环境的终端执行以下命令。`D:\Glorton` 是发行版的实际目录，`ws://127.0.0.1:8765/ws` 是本机双开时的服务地址。和朋友通过已连通的私有网络测试时，改为朋友可达的私有 WebSocket 地址。开服和房间按键见发行方文档。[发行方联机说明](https://raw.githubusercontent.com/james123wang5/fight-for-glorton-remake/v0.95-online/docs/ONLINE_MULTIPLAYER_CN.md)

```powershell
python .\scripts\launch-glorton-client.py D:\Glorton --server ws://127.0.0.1:8765/ws --name Player1
```

## 网页本地渲染联机

- 在大厅的「疯狂小人乱斗」卡片点加号，设置房间名和密码即可建房。房间最多四人。至少两人到齐，且已入座的玩家全员准备后，按当前人数开战。备战区包含角色和配色预览、四张原版地图预览、地图投票和准备状态。最高票的地图并列时，从并列地图中随机抽选。朋友可以直接用同一个房间名加入，旧房间码和邀请链接也可使用。访客连接成功后才领取正式席位。返回大厅会释放自己的席位，在保留时间内刷新会恢复角色、配色、地图票及准备状态。
- 新联机参照项目里死神 vs 火影的席位复用、开战条件和同帧校验。Python 游戏引擎在浏览器内由 WebAssembly 运行并绘制画面。服务端按 40 Hz 处理确认后的输入。同源 `/glorton-online/browser-ws` 传输输入、房间状态、校验摘要和重连快照，浏览器按逻辑帧推进游戏。在传输恢复时保留真实玩家的原席位。客户端保留发布版已有的短距离视觉预测。完整回滚可在模拟与绘制隔离并验证确定性后评估。[项目死神 vs 火影校验脚本](../scripts/verify-bvn33.mjs) · [GGPO 开发者指南](https://github.com/pond3r/ggpo/blob/master/doc/DeveloperGuide.md) · [State Synchronization](https://www.gafferongames.com/post/state_synchronization/)
- 修复过两类误校正来源。Node 转发重连快照时保留 Python 原有的数字字面量，避免 `0.0` 和 `0` 在往返后混为一谈。浏览器将渲染用镜头计算和插值时钟隔离于同步状态，重连快照补齐发行版原先省略的倒计时累积量和镜头目标索引。
- 对局键盘输入由网页捕获，桥接到原版 `FighterInput`。输入队列把同一键的快速按下和松开分到不同采样，保留原版跳跃和攻击组合。按住两个方向时，松开后来按下的方向会立刻恢复仍按住的方向。离开标签页或进入编辑控件会清理待发输入，并请求服务器解除移动和护盾。启用 `GLORTON_VERIFY_INPUT_BURST=1` 可通过真实浏览器检查连续 160 次按键变化以及失焦后恢复，并以权威帧确认输入。
- 私有构建可使用 Pygbag 0.9.2 和本机已安装素材的 `v0.95-online` 发行版。`python scripts/build-glorton-local.py <发行版目录> <新的私有构建目录>` 从本机发行版生成包。用 `scripts/run-glorton-service.ps1 -RuntimeRoot <已准备的运行目录> -Port 18762 -BrowserMultiplayer` 启动四席服务。启动隔离大厅时将 `GLORTON_LOCAL_WEB_ROOT` 指向构建目录，并通过 `GLORTON_SERVICE_URL=http://127.0.0.1:18762` 接入权威服务。[Pygbag](https://github.com/pygame-web/pygbag) · [发行版素材说明](https://github.com/james123wang5/fight-for-glorton-remake/blob/61f5f27cbae71f36b423cf5ce784932148bd9777/assets/README.md)
- 公网构建使用 `python scripts/build-glorton-local.py --provider-only <新的构建目录>`。大厅提供联机适配器。`20261127-room-ready-and-input` 的启动包为 9,931 字节，包含五个项目自写 Python 文件。浏览器从发行者托管的网页取得五个资源分片，缓存后可在刷新时复用。需要补齐的引擎模块从固定提交取得，逐文件校验 SHA-256。资源分片加载失败时，页面支持从磁盘导入发行包。[发行方网页版](https://james123wang5.github.io/fight-for-glorton-remake/game/) · [联机发行页](https://github.com/james123wang5/fight-for-glorton-remake/releases/tag/v0.95-online)
- `node scripts/verify-glorton-local.mjs <大厅地址> 4` 可跑四浏览器验收。设置 `GLORTON_VERIFY_PROVIDER=1` 后还会核验发行方资源请求与大厅启动包大小。实测房间搜索、全员选角和准备、四路输入、同帧摘要及 P4 刷新恢复。恢复时四端收到同一份快照，随后至少又推进 100 个逻辑帧，全程没有状态失步请求或二进制画面包。
- PCSERVER 大厅通过 `GLORTON_SERVICE_URL` 使用本机 `18781` 的 `GameLobby-Glorton-Rematch`。公网 WebSocket 走现有 FRP 入口。自动人数上线应检查该服务的 `/health` 返回 `automatic_roster:true`，并分别从公网和局域网真实提交 `roster:"auto"` 建房。公网支持数字房名、全角和旧码加入，加载失败不占位，退出可以立即补位。
- 浏览器按已应用的逻辑帧确认，服务端按网络往返时间限制尚未确认的帧数。单席积压越界时从权威快照恢复，其他席位继续收帧。浏览器也移除了固定两帧的额外输入等待和同步限帧阻塞。公网验收中一个席位暂停确认后，另一席继续推进 68 帧，恢复确认后慢席追上，5 次往返测得 30–47 毫秒。服务器候选大厅通过双人与四人浏览器验收，包括 1.6 秒渲染停顿、刷新恢复以及六个角色的配色预览。
- `20261127-room-ready-and-input` 的 PCSERVER 隔离三人测试和正式局域网双人测试都从最多四席的房间按实际人数开局。两轮各覆盖八次护盾和下蹲短按、160 次混合按键、失焦释放、准备后刷新和实战刷新。两轮分别核对了 26 个和 24 个共同状态检查点，均无失步请求。自动人数建房入口在公网和局域网均通过实际提交验证。
- 备战黑屏先用房间栏、名单和延迟确认连接已建立，再检查运行器的绘制层。Firefox 复现了 Pygbag 在备战时用行内样式重新显示画布的问题。修复后用 `GLORTON_VERIFY_PREP_CANVAS=1` 从正式局域网开双人局，主动触发同一属性写入，验证准备按钮、开战和重连，得到 17 个共同检查点。单台局域网设备偶发卡资源加载的原因仍待定位。备战显示与资源下载应分别留证。 [房间页面维护流程](WEBSITE_DESIGN_WORKFLOW.md#3-房间备战预览和对局画布)

## 云台乱斗

云台乱斗已从大厅目录和新建房间下架。这个原创项目的已有房间仍可通过邀请链接访问。2–6 人建房确认后开打，移动、二段跳、轻击与重击由服务端统一模拟。受击越多，后续击退越远。把对手打出场外得一分，无对手击退时自行掉落只触发复活。先到五分获胜，结算后在同房续局。

游戏用同源 WebSocket 下发约 25 帧每秒的权威状态，客户端插值渲染。断线保留原席位 45 秒，慢连接积压时跳过过期快照。键盘和手机触控使用同一输入协议。

运行 `node scripts/verify-platform-brawl.mjs` 可启动隔离大厅，用两个浏览器打到结算并验证刷新恢复。自动测试还覆盖了六个座位的模拟、慢连接恢复、掉落计分和快速输入。
