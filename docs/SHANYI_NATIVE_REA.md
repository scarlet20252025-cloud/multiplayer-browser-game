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

TL 时间轴上的平移量接近 0（0.0–0.6），说明**对象都在原点、真实几何画在形状内部**；不是 Box2D 米制。

补上 `DefineShape` 的 RECT 之后，包围盒给出真实尺寸（单位 twips，20 twips = 1 px）：

- 490 个形状定义；607 个摆放对象里 275 个能解析出包围盒；
- 整体范围 **x −800…2828 px、y −576…1791 px**，说明关卡几何确实在这个 sprite 里；
- 但大块的都是**容器**（背景层、地形容器、相机），直接把容器 AABB 画出来只能得到几张互相重叠的大灰块（`local/rea/level1.svg` 可复现）。

只导叶子形状（`--leaves`，丢掉 `BG2` 背景层）仍有 251 个矩形，画出来还是互相重叠的大块。原因已经确认：**这个游戏的地形是整块绘制的大形状，不是瓦片**，而且碰撞不来自形状本身——

- 工程里有 `wck/BodyShape.as`，说明用的是 WCK（World Construction Kit）思路：由显示对象的**轮廓**生成 Box2D body；
- 因此 AABB 对碰撞没有用，必须解 `DefineShape` 的 **Edge 记录**（直线/曲线）拿到多边形轮廓，或者直接找到关卡类里 WCK 的 body 配置。

下一阶段因此改为：解析 shape 的 edge 记录 → 多边形 → 再用多边形做碰撞；AABB 只用于剔除和粗筛。

关卡不是时间轴动画：`Level1` 只有 1 帧，地形和机关由 `Level1.as` 的构造逻辑加子对象，所以「SWF 显示列表 + 场景构建脚本」两边都要读，缺一不可。

## 已有的可复用资产

- `adapters/shanyi-flash/src/ShanyiHost.as`：自写 AS3 宿主，已经能在 Ruffle 里暴露 `shanyiPage`、`shanyiKey`、`shanyiApplyHero` 等接口。**它只作为逆向期的测量工具**，不是运行时依赖。
- `adapters/shanyi-flash/` + `server/shanyi-mirror-room.mjs`：现有输入镜像方案，作为过渡保留。
- `scripts/rea_shanyi.py`：本轮的显示列表导出器。

## 下一阶段（按顺序，每步都可验收）

1. **坐标与几何（进行中）**：RECT 包围盒与叶子筛选已完成，但地形是整块绘制、碰撞由 WCK `BodyShape` 从轮廓派生，AABB 不够。下一步解析 `DefineShape` 的 edge 记录得到多边形，输出碰撞地形。验收：多边形叠加游戏截图能对上平台、坑和门。
2. **规则还原**：从 `hero/Hero.as` 抽跑/跳/二段跳/受击/风场参数，从 `Level.as` 抽机关（Lever/Pusher/Platform/Door）的状态机。验收：每个参数在代码里有行号出处，写进 `data/shanyi/hero.json`。
3. **原生模拟**：`adapters/shanyi-native/sim.mjs`，固定 60Hz，输入为四个方向键 + 跳跃；先用 AABB 或 planck.js 跑通第一关的两个角色、地形、一个箱子、一扇门。
4. **对照验收**：用现在的 Ruffle 环境录一段「同一串输入」的原版轨迹（只录一次，作为黄金数据），原生模拟在同一串输入下逐帧对比位置，误差阈值写进测试。
5. **替换运行时**：新增 `shanyi-native` runtime，浏览器只加载项目自己的 JS + 从归档导出的素材，不再需要 SWF；原镜像方案降级为「对照工具」。

## 边界

- 第 4 步之前，不能声称「已经脱离 SWF」；目前只是把逆向工具和数据入口搭好。
- 原版素材（SVG/PNG/音频）属于第三方资源，仍只放私有目录；仓库只存导出脚本、结构描述和自写模拟代码。
- `core-decompiled` 与 `extracted-C-lightning` 不是同一构建：类名、属性设置函数有差异，抽参数时要固定用哪一个包，并记录哈希。
