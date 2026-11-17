# 森林冰火人 HTML5 第一代：本机双浏览器研究室

这是一个**能让普通浏览器标签页直接加入的、本机回环地址研究入口**，不需要开发者打开 Playwright 控制台手动注入脚本。游戏文件必须放在操作者自己的私有目录；公共 GitHub 仓库只包含原创联机适配器、服务器、测试与文档。

## 运行条件

- Node.js 24、npm、Playwright Chromium headless shell。
- 本地已经从 `html5-online-20261117.zip` 安全解包并保留 `games/` 的完整层级。第一代目录应为 `games/1-forest-temple/`；共享加载器应为 `games/lib/require.js`。
- **仅限运行电脑本机**：两个监听地址分别为 `127.0.0.1:8787`（原生网页）和 `127.0.0.1:8788`（权威 WebSocket）；不对公网或局域网提供游戏文件。

## 安装和启动

在仓库的 `work/flash-netplay-lab` 分支下执行：

```powershell
npm ci
npx playwright install chromium-headless-shell

node scripts/start-html5-local-room.mjs --root "E:\肥鱼不乐园\flash-archive\02-fireboy-watergirl\html5-online\games" --script 1-forest-temple/js/game.js --require-script lib/require.js --entry-path /1-forest-temple/index.html --expected-sha256 98666cf499473dfadb9b708af10ef2e5e13b50300881a32b7c8d65d7756a5700
```

如果文件存在其他磁盘位置，只修改 `--root` 的私人目录绝对路径。不要把 ZIP 或解压后的游戏文件提交到公开仓库。

成功启动后，在**同一台电脑**的两个普通浏览器标签页分别打开：

<http://127.0.0.1:8787/1-forest-temple/index.html>

第一个加入的连接获得席位 0（火娃），第二个获得席位 1（水娃）；界面右上角会显示实际席位及房间状态。第三个连接应当被服务器以 `ROOM_FULL` 拒绝，而不是借用另一位玩家的角色。

操作：

- **← / → 或 A / D**：移动当前席位角色；
- **↑、W 或 Space**：跳跃；
- **P**：向权威服务器提交暂停切换命令；
- **R**（或右上角“同意重开”）：关卡结束/角色死亡后投票重开，必须两个人都确认；服务器运行原生 `retry()` 后双方画面重建、输入序号归零，双方再次准备就绪才继续。

在终端按 Ctrl+C 可终止服务器。这不会改写原始 `game.js` 文件，但研究宿主会在**仅内存里的 HTTP 响应**中暴露原游戏 `window.__game` 实例，因此这不是未经修改的原包基准。

## 通过、未通过与安全边界

CI 已独立验证一个权威 Chromium + 两份原生画面客户端的输入、跳跃边沿、暂停恢复、钻石收集、按钮和平台、推箱子、死亡与投票重开。**本地网页一键加入**的额外 CI 通过与否要看 `.github/workflows/verify-html5-local-player.yml` 的实际运行结果，不能只因为脚本存在便写成功。

固定 CI 研究候选的 `game.js` SHA-256 是 `337125629748bace45e23b040e54b0d206e4cd78c9c8709d7785faa637e00677`；用户上传的私人 HTML5 第一代 `game.js` SHA-256 是 `98666cf499473dfadb9b708af10ef2e5e13b50300881a32b7c8d65d7756a5700`。版本不相同，前者通过不能替代后者的独立浏览器验收。

目前只提供**本机双标签页**而不是公网联机服务器；尚未完成自然胜利通关、换关、全 32 关同步、真实异地延迟和公开发行授权。第三方游戏资源没有打包进此公开仓库，公开发布完整原游戏需要取得相关授权。
