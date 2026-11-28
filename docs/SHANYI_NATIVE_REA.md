# 闪翼双星：脱离 SWF 的原生逆向路线（阶段 0）

目标：不再依赖私有 SWF 运行，把游戏还原成本仓库自己的固定步长模拟 + 渲染。本文记录已经拿到的逆向事实、工具和下一步，避免下一个人从零猜。

## 手上有什么

`E:\肥鱼不乐园\flash-archive\01-shanyi-binary\`（私有目录，不进仓库）：

| 材料 | 内容 |
| --- | --- |
| `core-decompiled/script/` | 988 个 AS3 类、9.6 MB，含 `hero/Hero.as`、`Level.as`、`Level1..14.as`、Box2D 的 AS3 移植（`cmodule/Box2D`） |
| `core-decompiled/shape/` | 30 MB SVG，按角色 ID 导出 |
| `core-decompiled/image/` | 6.2 MB PNG |
| `core-decompiled/sound/` | 460 KB 音频 |
| `extracted-C-lightning.swf` | 带完整 SymbolClass 名的包，125 个类名，`game.pages.levels.Level1` 等都在 |
| `_tools/ffdec/ffdec-cli.jar` | FFDec，配合本机 Java 25 可继续导出 |

## 已经确认的结构

`scripts/rea_shanyi.py` 只读解析 SWF 标签，不做反编译、不执行代码：

- 解压（FWS/CWS）→ 遍历顶层标签 → 收集 `SymbolClass`（字符 ID → 类名）与 `DefineSprite`（含嵌套标签流）。
- 递归下钻 `PlaceObject2/3`，输出每个摆放对象的深度、字符 ID、类名、矩阵和层级路径。
- 在 `extracted-C-lightning.swf` 上：125 个符号、196 个 sprite；`game.pages.levels.Level1` 是 sprite 317，1 帧，顶层 17 个对象，三层展开共 **640 个摆放对象**。
- 顶层对象已经能读出用途：`BG2` 背景、6 个 `Ground`（地形块）、`箱子`、`传送门_光`、`CPS`、`game.gameObjects.GameCamera`、`Flash`。名字是中文，说明这个包保留了原始命名。

坐标的读数是 0.0–0.6 这个量级，符合 **Box2D 世界单位（米）**，不是像素；渲染时需要乘 PTM（游戏里的 `PTM`/`SetPosition` 用量级换算）。这一点要在下一阶段用 `Level.as` 的 `b2Body.SetPosition` 交叉验证后再写死。

关卡不是时间轴动画：`Level1` 只有 1 帧，地形和机关由 `Level1.as` 的构造逻辑加子对象，所以「SWF 显示列表 + 场景构建脚本」两边都要读，缺一不可。

## 已有的可复用资产

- `adapters/shanyi-flash/src/ShanyiHost.as`：自写 AS3 宿主，已经能在 Ruffle 里暴露 `shanyiPage`、`shanyiKey`、`shanyiApplyHero` 等接口。**它只作为逆向期的测量工具**，不是运行时依赖。
- `adapters/shanyi-flash/` + `server/shanyi-mirror-room.mjs`：现有输入镜像方案，作为过渡保留。
- `scripts/rea_shanyi.py`：本轮的显示列表导出器。

## 下一阶段（按顺序，每步都可验收）

1. **坐标与几何**：确认世界单位 → 像素的换算；给 `rea_shanyi.py` 加 `DefineShape` 的包围盒（RECT）解析，输出每个地形块的 AABB。验收：把 Level1 的 640 个对象画成一张 SVG，与游戏截图叠加对得上。
2. **规则还原**：从 `hero/Hero.as` 抽跑/跳/二段跳/受击/风场参数，从 `Level.as` 抽机关（Lever/Pusher/Platform/Door）的状态机。验收：每个参数在代码里有行号出处，写进 `data/shanyi/hero.json`。
3. **原生模拟**：`adapters/shanyi-native/sim.mjs`，固定 60Hz，输入为四个方向键 + 跳跃；先用 AABB 或 planck.js 跑通第一关的两个角色、地形、一个箱子、一扇门。
4. **对照验收**：用现在的 Ruffle 环境录一段「同一串输入」的原版轨迹（只录一次，作为黄金数据），原生模拟在同一串输入下逐帧对比位置，误差阈值写进测试。
5. **替换运行时**：新增 `shanyi-native` runtime，浏览器只加载项目自己的 JS + 从归档导出的素材，不再需要 SWF；原镜像方案降级为「对照工具」。

## 边界

- 第 4 步之前，不能声称「已经脱离 SWF」；目前只是把逆向工具和数据入口搭好。
- 原版素材（SVG/PNG/音频）属于第三方资源，仍只放私有目录；仓库只存导出脚本、结构描述和自写模拟代码。
- `core-decompiled` 与 `extracted-C-lightning` 不是同一构建：类名、属性设置函数有差异，抽参数时要固定用哪一个包，并记录哈希。
