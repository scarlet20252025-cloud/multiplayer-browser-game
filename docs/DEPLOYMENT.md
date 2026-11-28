# 自建服务器运行

这是两人 AS3 链路研究版本。当前可运行内容是仓库自写探针，两款上传游戏仍需补齐原 SWF 与资源。下面的部署步骤是操作说明；本轮没有登录或部署到用户的服务器。

## 1. 单机启动

使用支持 Playwright 浏览器依赖的 Linux 主机、Node.js 24 与 npm。具体依赖版本锁定在 `package-lock.json`。

```bash
git clone https://github.com/scarlet20252025-cloud/multiplayer-browser-game.git
cd multiplayer-browser-game
git checkout work/flash-netplay-lab
npm ci
npx playwright install --with-deps chromium-headless-shell
npm test
npm run test:python
npm run test:e2e
npm run test:network
HOST=127.0.0.1 PORT=8780 MAX_ROOMS=4 npm start
```

浏览器打开 `http://127.0.0.1:8780`。使用两个独立浏览器配置或无痕窗口，第一位创建房间，第二位输入房间码；两边各自加载 AS3 客户端后开始。也可同时选择快速匹配。

服务端按需启动 Chromium，并为每个房间创建独立浏览器上下文。`MAX_ROOMS=4` 只是当前默认上限，没有容量保证。单浏览器进程内的上下文隔离方便实验，但不提供进程故障隔离；用于更多房间时应改为有容量限制的 worker 池并测量完整进程树的 CPU/RSS。

已有兼容 Chromium 时可以显式设置 `CHROMIUM_PATH`。环境文件是示例，服务器不会自动读取 `.env`；请由启动器导入环境变量。不要把浏览器安装失败误认为游戏兼容性失败。

## 2. 局域网验证

```bash
HOST=0.0.0.0 PORT=8780 MAX_ROOMS=4 npm start
```

两台电脑访问服务器的局域网地址。确认 HTTP 页面、`/runtime/` 下的 Ruffle WASM、探针 SWF 与 `/ws` 都能访问。记录真实网络 RTT 与操作体验；本仓库的 40 毫秒双向延迟注入只是固定延迟实验，不能代替这一步。

## 3. 公网入口

公网入口使用 HTTPS/WSS，转发到本机 8780。反向代理必须保留 Host 并支持 WebSocket Upgrade。以下是已有 HTTPS 站点中可使用的 Nginx 片段，域名与证书仍由服务器环境配置：

```nginx
location / {
    proxy_pass http://127.0.0.1:8780;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_read_timeout 60s;
}
```

实验版本的随机房间码用于邀请加入，重连令牌只交给本人连接。尚无账户系统、跨进程匹配、持久战绩、排队容量管理或服务重启恢复；需要这些能力时，在现有房间协议外加入平台层。保持单房间由一个 authority worker 推进，避免把同一房间分散给互不共享状态的 Node 进程。

## 4. 可观察性与验收

- `/health` 报告进程、协议、探针文件与房间数量；`originalGamesVerified` 仍为 `false`。
- `evidence/e2e-results.json` 记录两个真实浏览器客户端与真实 AS3 权威的验收结果。
- `evidence/network-results.json` 记录真实 WebSocket、输入边沿、断线恢复和固定延迟实验。
- 测试结果的 `scope`、`environment` 和 `status` 决定结论范围。失败记录不会被标记为通过。
- `nodeRssBytes` 只计 Node 进程，不包含 Chromium 子进程，不能用于推算单房间服务器内存。
- 快照统计只包含 JSON 载荷，不包含 HTTP 资源下载、WebSocket/TLS/TCP 开销。

先验收浏览器探针，再补齐原包进行单机运行基准，最后验收原游戏适配器。服务器启动成功或探针通过都不代表原游戏已经可联机。
