# 游戏大厅封面来源

本表记录当前大厅可用的封面。第三方游戏封面取自本项目实际运行的画面，以 WebP 提供。大厅界面负责显示游戏名称。

| 游戏 | 文件名 | 取图版本与场景 | 版本资料 |
| --- | --- | --- | --- |
| 森林神庙 | `forest.webp` | 本地 HTML5 包 `1-forest-temple` 第 2 关，森林地形和彩色液池 | [Coolmath Games](https://www.coolmathgames.com/0-fireboy-and-water-girl-in-the-forest-temple) |
| 光明神庙 | `light.webp` | 本地 HTML5 包 `2-light-temple` 第 2 关，光线和转向装置 | [Coolmath Games](https://www.coolmathgames.com/0-fireboy-watergirl-2-light-temple) |
| 冰雪神庙 | `ice.webp` | 本地 HTML5 包 `3-ice-temple` 第 4 关，冰面和变温光束 | [Coolmath Games](https://www.coolmathgames.com/0-fireboy-watergirl-3-ice-temple) |
| 水晶神庙 | `crystal.webp` | 本地 HTML5 包 `4-crystal-temple` 第 3 关，水晶传送门 | [Coolmath Games](https://www.coolmathgames.com/0-fireboy-watergirl-4-crystal-temple) |
| 闪翼双星 | `shanyi.webp` | 正传 `core_4_abc.swf` 的双人联机验收画面，两位角色同处「秘密实验室出口」 | [4399 正传发行页](https://www.4399.com/flash/52592.htm) |
| 死神 vs 火影 | `bvn33.webp` | BVN Online 3.3 固定联机构建，双人实战中黑崎一护对漩涡鸣人 | [5DPLAY 项目](https://github.com/5DPLAY-Game-Studio/BleachVsNaruto) · [固定联机提交](https://github.com/keyzf/bvn-online/tree/c7da486f78b1b9217d2e158e4c0505f2084e9ffd) |
| Q版泡泡堂7 | `bomb-it-7.webp` | 原版 SWF 的四席大乱斗实机画面，裁成 640×360 | [联机与运行记录](BOMB_IT_NETPLAY.md) |
| 疯狂小人乱斗 | `glorton.webp` | 浏览器本地渲染的摩加迪沙实机画面，保留 P1 与 P2，裁成 640×360 | [联机调研与运行记录](GLORTON_MULTIPLAYER_RESEARCH.md) |
| 迷宫坦克 | `tank-trouble.webp` | 用户提供的原创嘉年华坦克封面，压缩成 960×540 | 用户提供的场景设计参考 |

封面放在部署目录的 `public/lobby/art/covers/`，由 `/__lobby__/art/covers/<文件名>` 同源提供。`scripts/html5-research-host.mjs` 在启动时检查 `LOBBY_COVERS` 中的文件，并通过 `availableCovers` 向页面提供可用清单。`public/lobby/lobby.mjs` 的 `GAME_STYLE` 维护游戏与封面的对应关系。缺少可选封面时，页面使用主题色及该入口提供的图标。

第三方游戏截图封面由私有部署环境提供。原创迷宫坦克封面随仓库提供。替换同名文件后重新请求图片并核对缓存。添加封面后重启大厅，检查游戏卡、房间缩略图和通用房间横幅的裁切。Glorton 的游戏卡和房间缩略图已分别在局域网和公网 Chromium 解码为同一份 640×360 封面。具体流程见 [网站设计与维护流程](WEBSITE_DESIGN_WORKFLOW.md)。

取图留档中，四部神庙截自本地正式关卡。闪翼双星截自同步验收截图 `sync_seq0.png`。死神 vs 火影的用图构建为 `bvn33-net.swf`，SHA-256 为 `f60f8ea05c71fd31e896334c9b34f45d2863cb1e0d2e875d0cf977c1e625815c`。
