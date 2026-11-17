# 上传的 HTML5 压缩包：路径兼容及静态核验

用户提供 html5-online-20261117.zip；已从实际上传附件安全读取并计算原始 SHA-256（见 evidence/html5/upload-20261117-audit.json）。共 453 个文件，解压总量 41,490,562 字节，没有路径越界、符号链接或重复路径。第一代 game.js SHA-256 为 98666cf499473dfadb9b708af10ef2e5e13b50300881a32b7c8d65d7756a5700，与固定研究候选不同。原包游戏实机、双人联机尚未验证通过。

上传包的共享加载器位于 games/lib/require.js，入口在 games/1-forest-temple/index.html，因此研究宿主新增 requireScript 和 entryPath，保留相对资源请求路径。示例：

```
node scripts/html5-research-host.mjs --root /private/html5-online/games --script 1-forest-temple/js/game.js --require-script lib/require.js --entry-path /1-forest-temple/index.html --port 8802
```

访问 http://127.0.0.1:8802/1-forest-temple/index.html。此页面是带 HTTP 响应内存注入的研究宿主，不是未修改原包基准；原游戏资源只在本地读取，未提交到公开仓库。本机 Chromium 虽能启动，但浏览器页面导航受到 ERR_BLOCKED_BY_ADMINISTRATOR 限制，不能据此声称原包运行通过。
