# 《Q版泡泡堂》Flash 原版收集与联机技术验证

更新于 2026-11-27。原版文件保存在工作区的 `local/original-games/bomb-it/`，使用工作区的回环基准宿主运行。

## 来源和文件

| 代 | 主 SWF | 字节 | 舞台 | 声明帧率 | 文档来源 |
| --- | --- | ---: | --- | ---: | --- |
| 1 | `bomb-it-1.swf` | 2,117,835 | 550×400 | 35 | [作者 Newgrounds 提交](https://www.newgrounds.com/portal/view/349488) |
| 2 | `bomb-it-2.swf` | 5,097,092 | 600×450 | 120 | [Flashpoint 档案条目](https://flashpointarchive.org/search/#08972682-c4ae-ce84-0904-548277047656) |
| 3 | `bomb-it-3.swf` | 5,815,782 | 600×450 | 30 | [Agame 发行 CDN](https://www8.agame.com/games/flash/b/bomb_it_3/bomb_it_3.swf) |
| 4 | `bomb-it-4.swf` | 5,084,623 | 700×510 | 30 | [GamesXL 发行 SWF](https://games.gamesxl.com/10463.swf) |
| 5 | `bomb-it-5.swf` | 7,432,416 | 700×510 | 30 | [Agame 发行 CDN](https://www8.agame.com/games/flash/b/bomb_it_5/bomb_it_5.swf) |
| 6 | `bomb-it-6.swf` | 8,092,360 | 700×510 | 30 | [Agame 发行 CDN](https://www8.agame.com/games/flash/b/bomb_it_6/bomb_it_6.swf) |
| 7 | `bomb-it-7.swf` | 8,740,427 | 700×510 | 40 | [Agame 发行 CDN](https://www8.agame.com/games/flash/b/bomb_it_7/bomb_it_7.swf) · [作者 Newgrounds 提交](https://www.newgrounds.com/portal/view/636425) |

第 2 代从 SHA-256 为 `69721a91e33b617dbb5170d0e338eb8342c7bc6b7a3c656448acda81bbdc9b96` 的归档中只读提取。发行 CDN 第 7 代是 AVM2 / CWS v14，主文件 SHA-256 为 `21ff6d4a2e442e97300ddb3f7abc73a4863a16f83b0b0769720b2fff0ab6d482`，与 A10 在 Kongregate 发布的 SWF 完全相同。 [A10 的 Kongregate 页面](https://www.kongregate.com/en/games/a10_com/bomb-it-7)

全部主文件的指纹、容器长度和声明帧率可用以下命令复查。

```powershell
py -3.11 scripts/inspect_swf.py local/original-games/bomb-it --output local/original-games/bomb-it/inspection.json
```

原作第 7 代的正常版支持同机双人。P1 使用 WASD 与空格，P2 使用方向键与 Enter。中文站点记载可在原菜单左上角选中国国旗切换简体中文。 [4399 正常版](https://www.4399.com/flash/133630.htm) · [360 切换说明](https://xiaoyouxi.360.cn/detail?id=bMUaMIIySFWpRE)

## 本机验证

```powershell
node scripts/original-game-host.mjs --root local/original-games/bomb-it --entry bomb-it-7.swf --port 8790
```

用浏览器打开 `http://127.0.0.1:8790/`。改动后的本地宿主以 SWF 所在目录解析相对资源，限制第三方连接，并用 HTTP ETag 在稳定端口的重复访问中重验证本地 SWF 和 Ruffle。舞台保留原宽高比，并可在小屏缩小。运行时画面报告保存到同级 `baseline-*.json`，截图放在 `shots-*/`。

Chromium 使用仓库固定的 Ruffle 0.7.1。第 7 代冷启动先绘制 700×510 的加载动画，到 44 秒检查点已进入主菜单。实测在 START → NEXT → PLAYERS 2 → OK → START GAME 后进入同机双人地图，首次入场需要点 RESUME 关闭任务窗口。若弹出 Ruffle 硬件加速提示，可先关闭提示。第 6 代在 40 秒检查时进入英文菜单，已实测两人分别移动和放泡。第 1 代已确认可以进入游戏菜单。

第 7 代运行时请求的相对资源 `Art_Res.swf` 返回 404。当前主菜单按钮可操作，语言下拉缺少可辨认选项，任务三行文案显示为重复的 W。简体中文未通过本地验证，目前也没有证据能确认缺失资源和这些文字问题之间的因果关系。 [Flashpoint 多语言条目](https://flashpointarchive.org/search/#608d4bee-c9e6-4523-8d92-de005c5f2ff8)

## 联机路线与已落地的改进

- 附带技术指南 v2.0 的双实例输入锁步要求原运行时提供独立玩家输入、可重复步进、确定的初始随机种子和足够完整的状态摘要。SWF 声明帧率只用于识别版本。继续测试时先测实际逻辑频率，再用相同输入对照两局的地图、道具、连锁爆炸与比分。 [Ruffle 播放配置](https://ruffle.rs/js-docs/master/interfaces/Config.URLLoadOptions.html)
- 复用项目的房间与席位逻辑时，同一 tick 内快速按下后松开的放泡动作需要单独保存，服务端应在模拟消费时去重。为回合加编号以隔离迟到输入，席位替换时清除待处理输入。
- 原作跨设备对局仍需原运行时接口和确定性测试。验证需要覆盖双端同时移动和放泡、同 tick 连锁、断线重连与新回合。原版档案和截图仅保存在本机。
