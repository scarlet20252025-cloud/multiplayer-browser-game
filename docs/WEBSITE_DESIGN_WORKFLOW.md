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

`scripts/start-game-lobby.mjs` 启动大厅和网页入口。`scripts/html5-research-host.mjs` 的 `lobbyPage()` 生成首页的文档壳，注入 `__LOBBY_CONFIG__`，然后从 `/__lobby__/` 载入大厅脚本、样式和素材。`public/lobby/lobby.mjs` 根据游戏目录、房间列表和席位状态渲染页面。`public/index.html` 是早期 AS3 探针的页面，使用 `npm start` 可以运行该探针。

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
| 疯狂小人乱斗的游戏页面 | `public/glorton-online/local-hud.mjs` 包含选角、地图票、结算、键位和响应式侧栏。`local-session.mjs` 管理网页连接，`scripts/build-glorton-local.py` 负责生成 Pygbag 启动壳 |

## 2. 视觉设计和素材怎么改

大厅采用蓝天浮岛和糖果色的嘉年华风格。先保证建房和加入可见，再安排主视觉装饰。桌面端按顶部导航、独立主视觉、重叠的网络切换器、左游戏目录和右房间列表组织。生产 CSS 的内容宽度上限为 `1368px`。`--ink`、`--muted` 控制文字，`--purple` 用于主交互，`--yellow` 用于重点建房操作，游戏卡片通过 `--game-color` 区分。

移动布局沿用同一套语义结构。大厅在 `1130px`、`850px`、`730px`、`475px` 附近调整列数、导航、房间区和弹窗。对局页按视口与指针类型决定触屏控件，窄窗口的电脑仍需保留普通键位提示。检查时兼顾触屏横屏、桌面小窗口、键盘焦点、禁用按钮状态及 `prefers-reduced-motion`。装饰图层通过透明背景与 CSS 层级定位，按钮和标题保持各自的 HTML 元素。

- `design/carnival/hero/` 保存标题、男孩、女孩、柯基、白团子的分层透明 PNG。`design/carnival/reference-tokens.json` 保存 1672×941 参考版的设计变量，实际生效的变量在 `public/lobby/lobby.css`。
- `public/lobby/art/` 保存浏览器加载的轻量 WebP，`sprite.svg` 是网页图标的矢量源。换主视觉时先改对应的 PNG 原稿，以相同比例和透明边界导出 WebP，再核对 `hero()` 和移动端的位置规则。背景使用 `carnival.webp`，与标题人物分层。
- 新增图标时编辑 `sprite.svg` 的 `<symbol id="…">`，在 `lobby.mjs` 用 `icon('…')` 引用。新增素材或封面时同时更新 `html5-research-host.mjs` 的公开资源清单。新增游戏封面还要更新 `GAME_STYLE`；启动时 `availableCovers` 会告知页面哪些封面已就绪。缺少可选封面时卡片显示主题色。
- 第三方游戏截图封面和私有游戏包由部署环境提供。对于可使用的替换封面，将 WebP 放到 `public/lobby/art/covers/<封面名>.webp`，重启本地预览，再核对游戏卡、房间列表缩略图和房间横幅的裁切。封面的出处见 [封面来源](LOBBY_COVER_SOURCES.md)。

## 3. 本地预览和修改顺序

从已检出的仓库安装 `package-lock.json` 指定的 Node 依赖，Node.js 版本以 `package.json` 为准。以下 PowerShell 命令使用空的私有游戏目录，在独立端口启动实际大厅、房间和原创迷宫坦克。真实的第三方游戏会在相应私有资源与服务就绪后出现。

```powershell
npm ci
New-Item -ItemType Directory -Force local/empty-games | Out-Null
node scripts/start-game-lobby.mjs --root local/empty-games --viewer-port 8787 --lobby-port 8788
```

浏览器打开 `http://127.0.0.1:8787/`。已占用的端口可以换成一对连续端口。普通网页和样式改动保存后刷新即可查看，游戏目录、服务逻辑或新增的封面文件需要重新启动大厅。联调时使用两个独立浏览器上下文创建玩家资料，再通过房名或邀请链接进入同一房间。

1. **定位页面。** 从真实入口复现，并找到上表对应的渲染函数、CSS 或服务字段。记录现象发生在首页、房间、选角、战斗还是结算。
2. **按职责修改。** 视觉和文案改 CSS 或页面模板。人数、游戏能力和入口改 manifest。准备、密码、胜负、观战条件等规则改对应服务器并同步更新 UI 映射。
3. **走一遍完整状态。** 同时验证加载、空列表、连接失败、正在提交、已满、正在开局、对局中和返回大厅。对有重连的游戏验证刷新后仍保留本席位。对 Glorton 验证胜负弹窗、再战票和回到选角后的状态。
4. **对照两种屏幕。** 基准可取 1920×1080 桌面和 390px 宽手机，另查触屏横屏。确认房间和对局侧栏可操作，大厅搜索和密码表单保留输入。画面优化要在实际移动、跳跃和镜头跟随时验收。

## 4. 测试、提交和发布

先跑 `npm test`。安装 Playwright 的 Chromium 后，运行 `node scripts/verify-lobby-resume.mjs` 验证两标签页建房、刷新与断线恢复。`node scripts/verify-tank-trouble.mjs` 自建临时夹具，可覆盖真实大厅到原创游戏的入口。Glorton、BVN 和合作游戏的完整浏览器测试需要各自维护的私有运行包。固定研究资源的 GitHub Actions 在 `.github/workflows/`，测试记录应注明使用的候选版本。

发布时用独立候选目录与端口预览，把资源、网页与对应协议版本配对。仅替换网页或原图时，以内容哈希或版本参数刷新静态资源缓存。涉及 Node 网关、房间协议或权威服务时，先确认活跃对局，再切到验证通过的候选版本。保留上一个可启动版本和独立的房间数据，切换后从实际局域网和公网入口完成健康检测、建房、进房和对局测试。

提交时把源码、可公开的原稿、设计指引和相关测试放入 Git。开发者本机的运行包、授权素材、原始上传压缩包、构建缓存、日志、房间数据和部署凭据放在私有路径。生产发布与仓库提交分别记录版本，便于从用户看到的页面追溯到对应文件。
