# 肥鱼乐园网站设计与维护流程

本仓库保存可编辑的网页、主题样式、图标、分层主视觉原稿，以及运行这些页面所需的项目代码。本文以当前嘉年华大厅为准，记录从改页面到验证和发布的步骤。联机架构与协议见 [联机工程总结](NETPLAY_ENGINEERING_GUIDE.md)。

## 1. 页面是如何生成的

```mermaid
flowchart LR
    A[打开大厅] --> B[选择局域网或公网]
    B --> C[选择游戏或搜索房间]
    C --> D[创建或加入房间]
    D --> E[选关、选角或确认开打]
    E --> F[进入对应游戏页面]
    F --> G[结算、继续或返回大厅]
```

`scripts/start-game-lobby.mjs` 启动大厅和网页入口。`scripts/html5-research-host.mjs` 的 `lobbyPage()` 生成首页的文档壳，注入 `__LOBBY_CONFIG__`，然后从 `/__lobby__/` 载入大厅脚本、样式和素材。`public/lobby/lobby.mjs` 根据游戏目录、房间列表和席位状态渲染页面。

| 想改什么 | 从哪里开始 |
| --- | --- |
| 站名、顶部导航、标题人物、主视觉结构 | `public/lobby/lobby.mjs` 的 `topbar()`、`hero()`，配合 `public/lobby/lobby.css` 的顶栏和主视觉样式 |
| 颜色、圆角、阴影、尺寸、断点 | `public/lobby/lobby.css` 的 `:root`、布局规则和文件尾部的媒体查询 |
| 「局域网大厅」「公网大厅」 | `lobby.mjs` 的 `renderNetworkChoice()`、`verifyLan()`、`switchLobby()`。两种入口地址由启动参数提供，首页按实测连通性启用局域网 |
| 游戏卡片、封面、排序与人数 | `lobby.mjs` 的 `GAME_STYLE`、`catalogHtml()`，以及 `config/games/*.json` 的 `title`、`order`、`seats`、`minSeats` 等。Glorton 的大厅卡片和弹窗在 `lobby.mjs` 里单独接入 |
| 房间搜索、列表、加入和观战按钮 | `lobby.mjs` 的 `filteredRooms()`、`roomCard()`、`glortonRoomCard()`、`joinModal()`。接口状态和权限来自 `server/room-lobby.mjs` 与对应游戏的房间适配器 |
| 房间内的成员、选关、准备、退出与重连 | `lobby.mjs` 的 `renderRoom()`、`connect()`、`submitJoin()`。通用房间持久化在 `server/room-registry.mjs`，游戏内的准备与结算以各自权威状态为准 |
| 共用房间聊天 | `public/lobby/game-chat.mjs` 和各游戏宿主旁栏的 `game-chat-*` 容器 |
| 冰火人、闪翼双星的对局外壳与侧栏 | `scripts/html5-research-host.mjs` 生成页面和内联样式。冰火人控制与投影入口在 `scripts/html5-local-player.mjs`，闪翼输入桥在 `scripts/shanyi-mirror-client.mjs` |
| 迷宫坦克的对局布局、场景和音效 | `public/tank-arena/index.html`、`arena.css`、`arena-view.mjs`、`arena-audio.mjs`。触屏为 `touch.css` 和 `touch.mjs`。对局规则在 `server/tank-arena-sim.mjs` 与 `tank-arena-match.mjs` |
| 死神 vs 火影的皮肤、键位、表情、缓存与观战 | `scripts/bvn33-carnival.css`、`bvn33-player-bootstrap.js`、`bvn33-download-cache.js`、`bvn33-watch.html` 和 `bvn33-watch-client.mjs`。改动后由 `scripts/prepare-bvn33-sidecar.mjs` 接入私有构建 |
| 泡泡堂 7 的备战与对局外壳 | `lobby.mjs` 的 `bombItReadyPanel()`、`bombItWardrobe()`、`bombItRules()`，配合 `lobby.css`。备战状态由 `server/room-lobby.mjs` 管理，对局外壳由 `html5-research-host.mjs` 生成 |
| 疯狂小人乱斗的建房、备战与游戏页面 | `lobby.mjs` 的 `glortonPanel()`、`submitGlorton()`，以及 `public/glorton-online/local-hud.mjs` 的备战、结算、键位和响应式侧栏。`local-session.mjs` 管理网页连接，`scripts/build-glorton-local.py` 生成 Pygbag 启动壳 |

## 2. 视觉设计和素材怎么改

大厅采用蓝天浮岛和糖果色的嘉年华风格。先保证建房和加入可见，再安排主视觉装饰。桌面端按顶部导航、独立主视觉、重叠的网络切换器、左游戏目录和右房间列表组织。生产 CSS 的内容宽度上限为 `1368px`。`--ink`、`--muted` 控制文字，`--purple` 用于主交互，`--yellow` 用于重点建房操作，游戏卡片通过 `--game-color` 区分。

移动布局沿用同一套语义结构。大厅在 `1130px`、`850px`、`730px`、`475px` 附近调整列数、导航、房间区和弹窗。房间的角色卡在 `1220px` 及以下调整列数。已接入触控的对局页按视口与指针类型决定控件布局，窄窗口的电脑使用普通键位提示。检查时兼顾触屏横屏、桌面小窗口、键盘焦点、禁用按钮状态及 `prefers-reduced-motion`。装饰图层通过透明背景与 CSS 层级定位，按钮和标题使用各自的 HTML 元素。

- `design/carnival/hero/` 保存标题、男孩、女孩、柯基、白团子的分层透明 PNG。`design/carnival/reference-tokens.json` 保存 1672×941 参考版的设计变量，实际生效的变量在 `public/lobby/lobby.css`。
- `public/lobby/art/` 是大厅图片的供给目录，包含 WebP 主视觉、WebP 封面和各游戏的预览图。`sprite.svg` 是网页图标的矢量源。换主视觉时先改对应的 PNG 原稿，以相同比例和透明边界导出 WebP，再核对 `hero()` 和移动端的位置规则。背景使用 `carnival.webp`，与标题人物分层。
- 新增图标时编辑 `sprite.svg` 的 `<symbol id="…">`，在 `lobby.mjs` 用 `icon('…')` 引用。新增素材或封面时同时更新 `html5-research-host.mjs` 的公开资源清单。新增游戏封面还要更新 `GAME_STYLE`；启动时 `availableCovers` 会告知页面哪些封面已就绪。缺少可选封面时卡片显示主题色。
- 第三方游戏截图封面和私有游戏包由部署环境提供。对于可使用的替换封面，将 WebP 放到 `public/lobby/art/covers/<封面名>.webp`，重启本地预览，再核对游戏卡、房间列表缩略图和房间横幅的裁切。封面的出处见 [封面来源](LOBBY_COVER_SOURCES.md)。

## 3. 房间备战、预览和对局画布

泡泡堂 7 与疯狂小人乱斗采用同一种备战结构。开局条件和准备按钮放在主栏顶部，选角和规则预览各占一块，侧栏显示房间状态、分席位的玩家和对应键位。备战内容按正常页面流排版，地图预览和准备按钮可以用键盘操作。在移动端主栏先于侧栏，预览阵列随宽度调整。

### 人数、准备与重连

- **分别显示容量、在线和准备人数。** 两款游戏的新房间最多四人，至少两人到齐并全员准备后开始。三个玩家中两人准备时显示 `2/3 已准备`，第四个空席仍可加入。暂离保留席位则显示离线或等待重连，留出恢复原席的时间。玩家返回或席位超时释放后，服务器用此时的成员重新判断开局。对局中的玩家人数以开局名单为准。
- **选项和准备状态跟随席位。** 同一标签页刷新用已保存的席位令牌恢复服务器状态。昵称用于展示，服务端按令牌定位玩家。调整角色或个人装扮只取消本人准备。测试时先让 P1 准备，再让 P2 改选角色并保持未准备。刷新 P1 后核对两端看到的角色、地图和 P1 的准备状态，再让其余玩家准备开局。加入、刷新、主动退出和席位超时应分别验证。
- **泡泡堂 7 由房主选择规则。** 角色、服装、帽子和表情可分别预览。角色选择由服务端检查，房主切换地图或模式时增加规则版本并清除全员准备。备战页短暂断开会保留席位 20 秒。刷新恰逢开局时，服务器向恢复的原席位补发同场对局地址。详见 [泡泡堂 7 联机说明](BOMB_IT_NETPLAY.md)。
- **疯狂小人乱斗按玩家投票选图。** 新房间由大厅提交 `roster: 'auto'`，最多接纳四位玩家。旧固定人数房间继续使用原设定。每人一张地图票，最高票入选，同票由权威服务从并列地图中抽选，无票时沿用房间默认地图。改自己的投票只取消自己的准备。开局冻结参战名单，网页继续显示玩家原来的 P1–P4 标签。对局引擎使用连续的参战索引，通过 `match_slots` 对应回房间席位。详见 [疯狂小人乱斗联机调研](GLORTON_MULTIPLAYER_RESEARCH.md)。

### 预览与封面

泡泡堂 7 的八张角色图集位于 `public/lobby/art/bomb-it-7/wardrobe/`。每张图集包含该角色在原版换装界面的 64 种服装、帽子与表情组合。`bombItPortrait()` 通过服装、帽子和表情编号定位对应单元格。地图和模式预览分别位于同级 `maps/` 与 `modes/`，备战区根据服务端公布的可选项展示九张地图和四种对战模式。

疯狂小人乱斗的六个角色及四种配色预览取自已安装发行包，由 `provider_bootstrap.py` 和 `provider-loader.mjs` 提供给页面。原版菜单的四张选图缩略图位于 `public/lobby/art/glorton/maps/`。大厅封面 `covers/glorton.webp` 使用摩加迪沙实机画面的 640×360 WebP，游戏卡和房间条目共用它。

预览图和可用封面通过 `/__lobby__/art/` 提供。更新图片时同时核对 `html5-research-host.mjs` 的 `LOBBY_ART` 和 `LOBBY_COVERS`，以及页面中的文件名、编号和大小写。验收要在实际入口查看图片的解码尺寸与裁切，再切换角色、配色或地图检查预览是否更新。私有原始包和第三方图像按发布权限单独配置，仓库保留相应代码、相对路径和来源说明。

### 画布和统计的摆放

疯狂小人乱斗在同一网页切换加载、备战、对局和结算。Pygbag 初始化时可能较晚把 `canvas.style.visibility` 设为 `visible`，绝对定位的黑色画布会遮住备战卡片。`local-hud.mjs` 在 `data-mode=select` 时通过 CSS 优先级隐藏画布并关闭指针交互，保留画布尺寸供运行时使用。备战内容有明确的定位和层级，进入对局时画布恢复显示，返回备战时再隐藏。回归要主动在备战期间写入这个内联样式，同时检查实际可见像素和准备按钮能否命中。Firefox 的故障复现中，卡片可被点击时仍可能被绘制层遮挡。

泡泡堂 7 直接使用 SWF 自带的对局计分。迷宫坦克的 `#match-stats` 则放在 `.battle-field` 内紧贴战场下方。`arena.mjs` 的 `prepareRoster()` 按席位创建一排统计卡，显示当前比分、累计得分、击毁、被击毁和胜局。侧栏展开时，统计卡仍按战场高度定位。窄屏先保留战场和操作区，统计卡在自己的区域内横向滚动。验收时检查侧栏展开、六张统计卡横向排列和焦点滚动。

## 4. 本地预览和修改顺序

从已检出的仓库安装 `package-lock.json` 指定的 Node 依赖，Node.js 版本以 `package.json` 为准。以下 PowerShell 命令使用空的私有游戏目录和独立房间数据，在回环地址启动实际大厅、房间和原创迷宫坦克。第三方游戏的可用状态由各自的运行包和联机服务决定。

```powershell
npm ci
New-Item -ItemType Directory -Force local/empty-games | Out-Null
node scripts/start-game-lobby.mjs --root local/empty-games --rooms-file local/design-preview-rooms.json --viewer-port 8787 --lobby-port 8788
```

浏览器打开 `http://127.0.0.1:8787/`。已有服务占用时，从空闲端口中分别选择网页端口和匹配端口。普通网页和样式改动保存后刷新即可查看。调整游戏目录、路由或服务器逻辑，以及添加新封面后，重启大厅以刷新启动时读取的配置和 `availableCovers`。替换同名图片时重新请求静态资源，并检查浏览器是否仍在复用旧图。联调时使用两个独立浏览器上下文创建玩家资料，再通过房名或邀请链接进入同一房间。

1. **定位页面。** 从真实入口复现，并找到上表对应的渲染函数、CSS 或服务字段。记录现象发生在首页、房间、选角、战斗还是结算。
2. **按职责修改。** 视觉和文案改 CSS 或页面模板。目录内的游戏能力和默认席位改 manifest。Glorton 自动人数、准备、密码、胜负和观战等规则由对应服务器决定，改动后同步更新页面显示。
3. **走一遍完整状态。** 同时验证加载、空列表、连接失败、正在提交、已满、正在开局、对局中和返回大厅。对有重连的游戏验证刷新后仍保留本席位。对 Glorton 验证胜负弹窗、再战票和回到选角后的状态。
4. **对照两种屏幕。** 基准可取 1920×1080 桌面和 390px 宽手机，另查触屏横屏。确认房间和对局侧栏可操作，大厅搜索和密码表单保留输入。画面优化要在实际移动、跳跃和镜头跟随时验收。

## 5. 测试、提交和发布

先跑 `npm test`。安装 Playwright 的 Chromium 后，运行 `node scripts/verify-lobby-resume.mjs` 验证两标签页建房、刷新与断线恢复。`node scripts/verify-tank-trouble.mjs` 自建临时夹具，可覆盖真实大厅到原创游戏的入口。Glorton、BVN 和合作游戏的完整浏览器测试需要各自维护的私有运行包。固定研究资源的 GitHub Actions 在 `.github/workflows/`，测试记录应注明使用的候选版本。

调整备战界面后，可用以下命令分别跑泡泡堂 7 四端和疯狂小人乱斗三端。运行前按游戏文档准备对应的私有运行包，将 Glorton 命令中的地址替换成实际候选大厅入口。Glorton 命令末尾的数字是参与验收的浏览器数，房间上限仍为四。

```powershell
node scripts/verify-bomb-it-room.mjs --players 4 --width 1460 --dpr 1.2 --gpu --test-setup --test-reconnect --map Cake --mode collect

$env:GLORTON_VERIFY_READY_RELOAD='1'
$env:GLORTON_VERIFY_PREP_CANVAS='1'
node scripts/verify-glorton-local.mjs http://127.0.0.1:19361 3
```

- 泡泡堂 7 四端已用蛋糕地图和收集模式验证。验收覆盖角色、装扮和准备状态在刷新后恢复，以及断线恢复后的帧一致性。
- 疯狂小人乱斗的独立三端验收确认了第四席为空时仍可开局，权威对局恰好收到三位参战玩家。局域网双端验证了房间刷新和强制写入画布可见样式，实战取得 17 个一致检查点，刷新重连后仍可继续。黑块的绘制层回归另用 Firefox 和 Chromium 做了备战、开战、再战切换验证。
- 迷宫坦克已检查 1440×810 桌面、390 和 320 像素宽的竖屏，以及 932 和 568 像素宽的横屏。侧栏展开时，统计区和战场仍保持 14 像素间距。
- 疯狂小人乱斗的 640×360 封面已从局域网和公网的 Chromium 游戏卡及真实房间缩略图核对解码。

发布时用独立候选目录和端口预览。大厅发布需配齐 `public/lobby/`、网页宿主和本轮修改的游戏入口。把部署可用的封面、预览和私有资源放到对应目录，核对 `/__lobby__/art/` 的实际响应。泡泡堂 7 用 `scripts/prepare-bomb-it-netplay.mjs` 准备状态桥和运行器。Glorton 公网候选用 `scripts/build-glorton-local.py --provider-only` 生成启动壳，和相同版本的 `local-session.mjs`、`local-hud.mjs`、Node 转接与 Python 权威服务配套。Glorton 候选应实际提交 `roster: 'auto'` 建房，确认下游支持该能力。[泡泡堂 7 构建](BOMB_IT_NETPLAY.md) · [Glorton 构建与服务](GLORTON_MULTIPLAYER_RESEARCH.md)

切换前确认活跃对局，并保留上一个可启动版本和独立的房间数据。有资源缓存时核对实际返回的版本和内容。切换后从真实局域网和公网入口完成健康检测、建房、进房和对局测试，核对游戏卡、房间缩略图和备战区。详细回退与故障排查见 [联机工程总结的部署章节](NETPLAY_ENGINEERING_GUIDE.md#5-部署回退与故障排查)。

提交时把源码、可公开的原稿、设计指引和相关测试放入 Git。开发者本机的运行包、授权素材、原始上传压缩包、构建缓存、日志、房间数据和部署凭据放在私有路径。生产发布与仓库提交分别记录版本，便于从用户看到的页面追溯到对应文件。
