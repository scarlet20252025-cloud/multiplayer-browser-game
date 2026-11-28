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

**Edge 解析进展**：`scripts/rea_shanyi_shapes.py` 已能读填充/描边样式表（跳过渐变与位图）、
直线/水平垂直/二次贝塞尔边记录，并把边串成闭合轮廓（曲线按 6 段折线化）。目前 490 个形状里
**340 个能完整解析、169 个产出有效多边形**；但地形瓦片 `shape 79`（1000×1000 twips 的方块）
仍在样式表之后对不齐而抛 IndexError——说明 LineStyle 数组或 NumFillBits 的起始位置还差一两个字节，
这是下一步要先修的点。修好后 Level1 的 Ground（sprite 80 → 79）就能拿到可用轮廓。

`shape 79` 的 30 字节已经逐位走过一遍，定位到了具体位置：

```
4f 00 54 18 fa 41 8f a0 01 00 ff ff 00 00 10 15 50 64 19 e4 7d 1c af a3 92 0c 72 c1 80 00
id=79  RECT(-500..500)  fills=1(solid FFFF00)  lines=0  nf=1 nl=0
```

- 第 0 条记录：`MoveTo(-500,-500)` + `FillStyle1=1`，32 bit，正确；
- 第 1 条：水平线 dx=-250（9 bit），正确；
- 第 2 条：flags=0x0E（Fill0+Fill1+LineStyle），读完 fill0/fill1 共 8 bit；
- 第 3 条从第 65 bit 开始，读出来是 `flags=0x17 + nbits=26` 的非法值——**说明第 2 条多读或少读了 1 个 bit**。

两个待验证的假设：`NumLineBits=0` 时 LineStyle 字段是否仍然占位；以及 flags 五个位的读入顺序。
验证方法：对第 3 条尝试 8 种 bit 偏移，只有能让流在 30 字节内走到 `flags==0`（EndShapeRecord）的那一种是对的。

**已按这个思路改完**：`parse_shape` 现在对记录区起点试 0–7 bit，选「能正常收尾且轮廓面积最大」的那个。
全量结果从 340/490 通过提升到 **489/490**，多边形从 169 增到 392。

但 `shape 79` 解出来的多边形只有 `-556..0 × -524..0`，而 RECT 声明是 `-500..500`——说明这个「按面积选偏移」
的启发式在方块类形状上仍会选错（选到了局部轮廓）。下一步要把判定改成「必须闭合且轮廓面积接近 RECT 面积」，
而不是单纯比大小。

**矩阵已经定位到具体原因**：`Ground` 的矩阵是 `hasScale=1 nbits=1, hasRotate=1 nbits=21`——
它带**旋转**，而合成器只累加了平移和缩放，所以 6 块地形全部叠在原点。
`箱子`、`深度 90` 的对象则是 `hasRotate=0 nbits=16`。下一步必须按矩阵的 a/b/c/d 做完整变换
（含旋转），否则任何布局都是错的。

**形状几何已换成可靠来源**：新增 `scripts/rea_shanyi_svg_shapes.py`，直接读 FFDec 导出的
`core-decompiled/shape/<id>.svg`（M/L/H/V/Q/C/Z + 外层 matrix），不再手写边记录。
实测：79 号地形 16.3×33.6px / 18 条子路径，291 号箱子 69.5×69.2px，262 号 887×138.6px，
258 号传送门 173×33.9px / 46 条子路径——尺寸都对得上。

另一个更关键的未解问题：`Ground` 的 6 个摆放对象矩阵平移都在 0 附近，而 `Level1.as` 里没有任何
`.x =` / `addChild` 赋值，说明布局应该在 SWF 时间轴里。也就是说**矩阵解码本身可能不对**
（0.48 这种量级既不是像素也不是 twips）。需要用 `BG2`（确定在 0,0）和一个已知位置的相机对象做对照，
确认 FIXED 的读法后再谈布局。

关卡不是时间轴动画：`Level1` 只有 1 帧，地形和机关由 `Level1.as` 的构造逻辑加子对象，所以「SWF 显示列表 + 场景构建脚本」两边都要读，缺一不可。

## 已有的可复用资产

- `adapters/shanyi-flash/src/ShanyiHost.as`：自写 AS3 宿主，已经能在 Ruffle 里暴露 `shanyiPage`、`shanyiKey`、`shanyiApplyHero` 等接口。**它只作为逆向期的测量工具**，不是运行时依赖。
- `adapters/shanyi-flash/` + `server/shanyi-mirror-room.mjs`：现有输入镜像方案，作为过渡保留。
- `scripts/rea_shanyi.py`：本轮的显示列表导出器。

## 已经能跑的原生切片（2026-11-28）

- `adapters/shanyi-native/sim.mjs`：固定 60 Hz 的两角色平台物理（跑/摩擦/跳跃/二段跳/AABB 地形），只吃每 tick 输入，不读 wall clock。
- `public/shanyi-native/level-1.json`：从 Level1 的 Ground 多边形导出的 52 个碰撞矩形，范围 -156…498 px。
- `tests/shanyi-native-sim.test.mjs`：落地、加速上限、摩擦、跳跃、二段跳、侧面阻挡、高速不隧穿，7 项全过。

这证明「不依赖 SWF 的模拟 + 碰撞」这条路能走通；但参数还没和原版逐帧对照，关卡也只覆盖 Ground 一层。

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

## 关卡基准图与分层校准（2026-11-28 追加）

FFDec 导出 `DefineSprite_317_game.pages.levels.Level1` 得到的基准图：

- 画布 3127×2463，有效像素区 **2903×1927**（存 `local/rea/level1-reference.png`，私有素材不入库）；
- 当前只合成 Ground 一层：**654×186，宽高比 3.5:1**；
- 基准图宽高比 1.5:1。

结论：差距的主因不是缩放，而是**层没集齐**（背景、地形、机关、门、装饰各自独立）。下一步按层导出、逐层叠到基准图上校准，每层给出「覆盖率 / 偏移」两个数字，全部对上之后再谈碰撞与模拟参数。
