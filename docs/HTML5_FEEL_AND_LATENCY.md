# 冰火人联机手感：回拉与跳跃黏手的根因和修复

2026-11-28。四部曲（森林/光明/冰雪/水晶）共用同一套 `fireboy-html5` 投影适配器，本文的修复对四部同时生效。

## 现象

- 自己看自己的角色，走路时一直被往回拉；
- 跳跃黏手，按了要过一会儿才离地，落点发飘；
- **队友看你的角色是正常的**，只有本人觉得卡。

最后一条是关键：同一份快照、同一条投影路径，唯一的差别是「本地席位」多了一段别人没有的处理。

## 根因

### 1. 只给自己角色加的预测位移（回拉的直接原因）

`adapters/fireboy-html5/spectator-projection.mjs` 在渲染前给自己角色额外加了一段位移：

```js
localPredictedX += localInputX*140*(dt/1000);   // 按输入往前推
localPredictedX *= Math.exp(-dt/90);            // 再让它衰减
localPredictedX = Math.max(-8, Math.min(8, localPredictedX));
localCharacter.sprite.x += localPredictedX;     // 每帧加到精灵上
```

这段位移最高 ±8px，衰减意味着它最后必须被收回去——收的过程就是肉眼可见的倒退。队友角色没有这段，所以只有本人觉得被拉。

**修复**：整段删除。本地角色与队友角色走完全相同的权威投影路径；`setLocalInput()` 保留为兼容接口，但不再移动精灵。

### 2. 快照只有 9.5–15 Hz（跳跃黏手的底座）

`server/html5-research-room.mjs` 原本：

```js
const TICK_MS=32;
timer=setTimeout(runTick,TICK_MS);        // 相对调度
...
timer=setTimeout(runTick,Math.max(0,TICK_MS-elapsed));
```

Windows 的定时器粒度约 15.6ms，`setTimeout(32)` 实际落在 ~47ms；再加上「相对上一次完成时间」重新计时，一次慢帧会把整个节奏往后推。实测状态间隔 p50 为 **46–54ms**，约 15 Hz——跳跃这种 300ms 的动作只有 4–5 个画面，必然黏。

**修复**：绝对截止时间累加 + `TICK_MS=25`：

```js
nextDeadline=Math.max(nextDeadline+TICK_MS,now);
timer=setTimeout(runTick,Math.max(0,nextDeadline-now));
```

实测 p50 间隔降到 **32.3ms**，约 **36 Hz**，p95 49ms。

### 3. 平滑时间常数偏大

客户端传 `smoothingMs:55`，相当于每帧只走 26% 的差值，跳跃起始段被压平。改为 **30ms**（约一个快照间隔），起跳和落地的轮廓明显更实。

### 4. 观看端把四部曲都当成森林神庙

`scripts/html5-research-host.mjs` 单游戏模式硬编码 `templeId:'forest'`、`storagePrefix:'fb-forest'`，导致光明/冰雪/水晶的观看页解锁了错误的存档键，进不了关卡，自然也谈不上验证。

**修复**：新增 `templeId` / `storagePrefix` / `gameId` 参数，默认值保持 forest 兼容旧调用。

## 实测

环境：本机 headless Chromium（SwiftShader），两个真实标签页 + 一个真实 Box2D 权威。

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 快照间隔 p50 | 46–54 ms | 32.3 ms |
| 快照频率 | 9.5–15 Hz | 35.7 Hz |
| 单帧权威耗时 p50 | 21 ms | 21 ms（未变） |
| 按住右走时的回退帧 | 有（最多 -1.5px/帧） | 0 |
| 四部曲启动 | 仅森林 | 四部全部通过 |

四部曲逐部结果（按住右走 1.6s，统计可见回退帧 >0.05px）：

| 版本 | 渲染帧率 | 回退帧 | 最大回退 | 位移 |
| --- | --- | --- | --- | --- |
| 森林神庙 | 40.2 | 0 | 0 | 404px |
| 光明神庙 | 33.8 | 0 | 0 | 319px |
| 冰雪神庙 | 33.3 | 0 | 0 | 319px |
| 水晶神庙 | 36.8 | 0 | 0 | 319px |

## 复现命令

```bash
# 单部手感探针（走 + 跳）
MSYS_NO_PATHCONV=1 node scripts/probe-fireboy-feel.mjs \
  --root "E:/…/html5-online/games" --script 1-forest-temple/js/game.js \
  --require-script lib/require.js --entry-path /1-forest-temple/index.html

# 四部曲回归
MSYS_NO_PATHCONV=1 node scripts/probe-fireboy-series.mjs --root "E:/…/html5-online/games"

# 只测流：间隔、码率、权威往返
MSYS_NO_PATHCONV=1 node scripts/measure-html5-stream.mjs --root "E:/…/html5-online/games" \
  --script 1-forest-temple/js/game.js --require-script lib/require.js \
  --entry-path /1-forest-temple/index.html
```

## 边界与后续

- 现在**不做本地预测**。自己的角色和队友的角色延迟一样：RTT + 一个快照间隔 + 30ms 平滑，本机约 60–80ms。这个延迟下走路和跳跃是连续的，不会回拉。
- 如果要进一步降低「按键到画面」的延迟，正确做法是把角色物理放到客户端预测并在收到权威快照后重演未确认输入（指南第 17 节），而不是继续在渲染层加偏移；这需要能重放 Box2D 的输入，属于下一步。
- 快照仍是全量 13.8KB/帧、约 480KB/s/观众。局域网没问题；公网多观众需要改成增量快照或开启压缩。
