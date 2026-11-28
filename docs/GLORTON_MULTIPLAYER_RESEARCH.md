# 疯狂小人乱斗联机调研

## 原作源码追踪

- 《疯狂小人乱斗》对应《The Fight for Glorton》。Florian Segginger 的作品集确认原版用 ActionScript 2.0 编写。原版支持一台电脑上用一个键盘供 1–4 位玩家操作。在作者作品集、原发布页和本地 Flash 档案中未找到可核实的作者原始 `.fla` 或 `.as` 工程。[程序作者作品集](https://segginger.com/portfolio) · [作者发布页](https://www.newgrounds.com/portal/view/378745) · [Armor Games 操作说明](https://armorgames.com/play/1108/the-fight-for-glorton?rt=l)
- Flash 档案索引能查到已编译的 SWF 发行物。该格式保存可执行的字节码和资源。工具据此还原的 ActionScript 是反编译输出，原始工程文件仍未找到。[Flash 档案索引](https://ooooooooo.ooo/?id=96fb0532-a836-9118-2d5b-960fb0d6de2b)
- 灵动游戏提供原作汉化入口。[《疯狂小人乱斗》汉化版](https://www.mhhf.com/game/detail/6014)

## 选用的上游版本

- 肥鱼乐园采用 `james123wang5/fight-for-glorton-remake` 的 `v0.95-online` 标签作为技术基线。上游发行版用 Python/Pygame 客户端连接 40 Hz 权威服务，支持两位真人及可添加的 P3、P4 电脑对手。项目的浏览器适配在这个版本上扩展了真人席位和备战流程。[联机版本发布页](https://github.com/james123wang5/fight-for-glorton-remake/releases/tag/v0.95-online) · [标签内联机说明](https://raw.githubusercontent.com/james123wang5/fight-for-glorton-remake/v0.95-online/docs/ONLINE_MULTIPLAYER_CN.md)
- 联机标签指向提交 `61f5f27cbae71f36b423cf5ce784932148bd9777`。其中有 Python/Pygame 客户端和联机服务，未见原版 ActionScript 工程或仓库许可证。项目说明将运行素材的权利保留给各权利方。[联机标签源码](https://github.com/james123wang5/fight-for-glorton-remake/tree/61f5f27cbae71f36b423cf5ce784932148bd9777) · [项目素材说明](https://github.com/james123wang5/fight-for-glorton-remake#原版素材说明)

## 上游桌面版基线实测

- 用固定提交的原样联机服务和校验通过的发布素材，在 `127.0.0.1` 上用两个独立 WebSocket 客户端建房、进房、同步选角和开战。实测服务器为 40 Hz，双方在 Mogadishu 地图分别向对方移动。断开 P2 后对局暂停，带原席位凭证恢复后两端重新收到一致的战斗状态。上游 10 项联机测试全部通过。[运行素材发布页](https://github.com/james123wang5/fight-for-glorton-remake/releases/tag/v0.95-online)
- Windows 上游桌面客户端扫描系统字体时，遇到整数注册表项曾抛出 `TypeError`。基线复测通过 `scripts/launch-glorton-client.py` 给当前进程提供 Arial 与默认字体兜底。修复后两个桌面客户端各自渲染 1280×760 画面，能在同机回环对局中独立操作。

## 网页本地渲染联机

- 在大厅的「疯狂小人乱斗」卡片点加号，设置房间名和密码即可建房。房间最多四人。至少两人到齐，且已入座的玩家全员准备后，按当前人数开战。备战区包含角色和配色预览、四张原版地图预览、地图投票和准备状态。最高票的地图并列时，从并列地图中随机抽选。朋友可以直接用同一个房间名加入，旧房间码和邀请链接也可使用。访客连接成功后才领取正式席位。返回大厅会释放自己的席位，在保留时间内刷新会恢复角色、配色、地图票及准备状态。
- Python 游戏引擎在浏览器内由 WebAssembly 运行并绘制画面。服务器按 40 Hz 应用输入并发布确认帧。同源 `/glorton-online/browser-ws` 传输输入、房间状态、校验摘要和重连快照。浏览器按确认帧推进模拟，短距离视觉插值和预测只影响绘制。恢复连接时保留原有席位，以权威快照接续。[联机工程指南](NETPLAY_ENGINEERING_GUIDE.md)
- 修复过两类误校正来源。Node 转发重连快照时保留 Python 原有的数字字面量，避免 `0.0` 和 `0` 在往返后混为一谈。浏览器将渲染用镜头计算和插值时钟隔离于同步状态，重连快照补齐发行版原先省略的倒计时累积量和镜头目标索引。
- 对局键盘输入由网页捕获，桥接到原版 `FighterInput`。输入队列把同一键的快速按下和松开分到不同采样，保留原版跳跃和攻击组合。按住两个方向时，松开后来按下的方向会立刻恢复仍按住的方向。离开标签页或进入编辑控件会清理待发输入，并请求服务器解除移动和护盾。启用 `GLORTON_VERIFY_INPUT_BURST=1` 可通过真实浏览器检查连续 160 次按键变化以及失焦后恢复，并以权威帧确认输入。
- 私有构建可使用 Pygbag 0.9.2 和本机已安装素材的 `v0.95-online` 发行版。`python scripts/build-glorton-local.py <发行版目录> <新的私有构建目录>` 从本机发行版生成包。用 `scripts/run-glorton-service.ps1 -RuntimeRoot <已准备的运行目录> -Port <空闲测试端口> -BrowserMultiplayer` 启动四席服务。将隔离大厅的 `GLORTON_LOCAL_WEB_ROOT` 指向构建目录，`GLORTON_SERVICE_URL` 指向这次测试启动的回环端口。[Pygbag](https://github.com/pygame-web/pygbag) · [发行版素材说明](https://github.com/james123wang5/fight-for-glorton-remake/blob/61f5f27cbae71f36b423cf5ce784932148bd9777/assets/README.md)
- 公网构建使用 `python scripts/build-glorton-local.py --provider-only <新的构建目录>`。大厅提供联机适配器。`20261127-room-ready-and-input` 的启动包为 9,931 字节，包含五个项目自写 Python 文件。浏览器从发行者托管的网页取得五个资源分片，缓存后可在刷新时复用。需要补齐的引擎模块从固定提交取得，逐文件校验 SHA-256。资源分片加载失败时，页面支持从磁盘导入发行包。[发行方网页版](https://james123wang5.github.io/fight-for-glorton-remake/game/) · [联机发行页](https://github.com/james123wang5/fight-for-glorton-remake/releases/tag/v0.95-online)
- `node scripts/verify-glorton-local.mjs <大厅地址> 4` 可跑四浏览器验收。设置 `GLORTON_VERIFY_PROVIDER=1` 后还会核验发行方资源请求与大厅启动包大小。用实战确认四路输入、同帧摘要及 P4 刷新后继续操作。
- 发布前读取当前大厅任务的 `GLORTON_SERVICE_URL`，检查所指权威服务的 `/health` 是否返回 `automatic_roster:true`，再分别从公网和局域网提交 `roster:"auto"` 建房。版本 `20261127-room-ready-and-input` 切换时，实际大厅使用回环端口 `18781` 的 `GameLobby-Glorton-Rematch`。
- 浏览器按已应用的逻辑帧确认，转发层根据往返时间为各席位限制尚未确认的帧数。单席积压越界时由权威快照校正，仍在线的其他席位继续收帧。一次公网双人验收中，暂停一席确认时另一席继续推进 68 帧，恢复确认后慢席追上。测积压时应记录暂停时间、其他席位的推进幅度和恢复后的状态摘要。
- `20261127-room-ready-and-input` 的 PCSERVER 隔离三人测试和正式局域网双人测试都从最多四席的房间按实际人数开局。两轮各覆盖八次护盾和下蹲短按、160 次混合按键、失焦释放、准备后刷新和实战刷新。两轮分别核对了 26 个和 24 个共同状态检查点，均无失步请求。自动人数建房入口在公网和局域网均通过实际提交验证。
- 备战黑屏先用房间栏、名单和延迟确认连接已建立，再检查运行器的绘制层。Firefox 复现了 Pygbag 在备战时用行内样式重新显示画布的问题。修复后用 `GLORTON_VERIFY_PREP_CANVAS=1` 从正式局域网开双人局，主动触发同一属性写入，验证准备按钮、开战和重连，得到 17 个共同检查点。单台局域网设备偶发卡资源加载的原因仍待定位。备战显示与资源下载应分别留证。 [房间页面维护流程](WEBSITE_DESIGN_WORKFLOW.md#3-房间备战预览和对局画布)

