# 阻塞与尝试记录

## 已解决

1. **形状边记录对不齐**（shape 79 差 1 bit）：改为对记录区起点试 0–7 bit，按「终止位置优先、面积接近 RECT 次之」选优；最终换用 FFDec SVG 作为几何来源，彻底绕开。
2. **116 个形状缺 SVG**：`ffdec -export shape` 全量导出 490 个，missing 0。
3. **地形全叠在原点**：矩阵带旋转（Ground: a=0,b=12,c=-0.6,d=0），补全 a/b/c/d 变换后成形。
4. **关卡尺寸误判**：基准图含舞台外装饰；以 BG2 的 2828×600 为准。

## 未解决

- 门（传送门_光）：sprite 258 无矢量子对象，只能拿到 181×40 的位图 bbox；世界矩阵平移为 0，说明位置由 AS3 在运行时设置。已知结论：**不能用 SWF 时间轴定位门**，要从 Level.as/Behavior 里找门的创建逻辑，或改用行为录制定位。
- 尚未做黄金轨迹：原版一次输入录像（Ruffle + 现有 host）还没接。

## 大厅入口接线（未完成，位置已定位）

- `server/room-lobby.mjs:365` 的运行时分支需要新增 `game.runtime==='shanyi-native'` → `startShanyiNativeRoom({levelPath: <repo>/public/shanyi-native/level-1.json, port: mirrorPort, bindHost})`。
- `server/room-lobby.mjs:398` 的 ws 地址拼接按 authority 处理；native 房需要改成 `room.localUrl` + `/ws`。
- 席位入口需要 `/shanyi-native/index.html?ws=<room.localUrl>&seat=<n>`，当前大厅只对 flash 房拼 seat 参数，native 房要加同样分支。
- `config/games/shanyi-native.json` 的 `listed` 仍为 false，接线完成前不应出现在大厅。

### 大厅入口：已接线，缺端到端验证

- 房分支与 health 形状已接好，`tests/room-lobby.test.mjs` 10 项通过；但**还没有**一次「大厅建房 → 两席进 /shanyi-native/index.html」的真实 E2E。
- 已验证：大厅前端 `navigateToGame()` 会把 `ws`、`seat`、`room`、`game`、`level` 一并拼进 entryPath（lobby.mjs:1085-1103），所以席位参数不是问题。
- **新确认的阻塞**：`room-lobby` 只提供 API（`/health`、`/api/games`、`/api/rooms`），实测 `/shanyi-native/index.html` 返回 404；游戏页面由 `start-html5-research-host` 按 catalog 的 `ensureGame()` 逐个提供，其 `servedGames` 只登记 html5 脚本类游戏。原生页要可用，必须在 viewers host 里加一条静态路由（`/shanyi-native/*` → `public/shanyi-native/*`），或让 ensureGame 支持没有脚本的静态包。
