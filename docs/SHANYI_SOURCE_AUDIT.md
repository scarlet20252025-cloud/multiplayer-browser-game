# 闪翼双星源码静态审计

审计日期：2026-11-17。输入：用户上传的 `flash-archive-源码版-20261117.zip` 解包目录。

**结论：能定位双人输入与物理循环，但当前材料不是已经恢复的可编译 HTML5 或 Flash 工程。尚未运行原游戏、复编 SWF、修改原游戏字节码或验证原游戏联机。**

本文件描述的是读取实际文件得到的结果。下面的接入位置是候选改造点，不是已经应用的补丁。

## 复现方式

在仓库根目录运行，输入必须是已解包目录：

```bash
python3 scripts/audit_archive.py "/path/to/flash-archive-源码版" --output local/reports/archive-audit.json --manifest local/reports/archive-file-manifest.json
```

工具仅遍历、读取、解码和哈希文件，不导入或执行被检查的代码。报告必须输出到输入目录之外。`--manifest` 可省略；完整原始源码不需要进入公共仓库。

本次输入清单摘要：

| 项目 | 实际值 |
| --- | ---: |
| 总文件数 | 4,425 |
| 解包文件总字节数 | 37,280,624 |
| ActionScript 文件 | 3,594 |
| ASASM 文件 | 376 |
| JSON 文件 | 283 |
| SWF / ABC / JavaScript / HTML 文件 | 均为 0 |
| 已识别的图片、音频、字体资源文件 | 0 |

清单摘要 SHA-256：`0ccefa7e389ffe7341a04a8ab224270a74f55fc46a335a22f40c822eec69eb1b`。算法是按相对路径排序后，对每项的路径、字节数、文件 SHA-256 组成的清单计算 SHA-256；它不是 ZIP 文件本身的哈希。

归档中 README 描述的完整包体、图片和工具不等于这次源码版附件实际包含的文件。当前材料不足以执行原游戏播放或二进制补丁测试。

## 1. 正传与续作的反编译质量

以下路径相对于 `01-shanyi-binary/`：

| 子目录 | `.as` 文件 | 含 `§§` 的文件 | `§§` 出现次数 |
| --- | ---: | ---: | ---: |
| `core-decompiled/script/scripts/` | 987 | 955 | 27,091 |
| `lightning-decompiled/script/scripts/` | 1,348 | 115 | 1,122 |

正传实际为 987 个 `.as`，与原归档 README 的 988 个描述不同。统计范围是本次附件中的实际文件。

`§§push`、`§§pop`、`§§findproperty` 等是反编译器用于表达未还原字节码的伪表示。正传 `Main.as` 有 176 行含这些标记，`Level.as` 有 193 行。它们不能直接被视作正常 AS3 源码。**没有进行编译尝试，不能把这里的静态检查表述为某个编译器已实测失败。**

## 2. 正传双人输入入口

本节文件相对于 `core-decompiled/script/scripts/`，行号按原文件的文本行计数：

| 文件与行号 | 观察到的事实 | 接入含义 |
| --- | --- | --- |
| `hero/FireManHero.as` 67、80–82 | 火角色使用 W / S / A / D | 网络席位应绑定此角色 |
| `hero/IceManHero.as` 72、84–86 | 冰角色使用方向键 | 第二席位应有独立输入状态 |
| `Level.as` 318、331 | 按实例名取得 `fireMan`、`iceMan` | 原运行资源中的实例命名参与初始化 |
| `Level.as` 343–344 | 另有 `fireManInBoat`、`iceManInBoat` 分支 | 适配不能只覆盖普通角色形态 |
| `hero/Hero.as` 1291、1333–1336 | `parseInput` 读取 `kd` 与 `kp` | 必须保留持续按住与按下边沿的区别 |
| `misc/Input.as` 90、92–93 | 注册帧末清理和真实键盘事件 | 网络模式要有唯一输入来源与清理时机 |
| `misc/Input.as` 108–122、124–155 | 维护按住、刚按下、刚松开集合 | 可以作为输入桥的语义依据 |
| `misc/Input.as` 158–205 | 每帧清除刚按下、刚松开状态 | 不能按网络收包次数清除 |

`misc/Input.as` 是较集中的输入接入候选。网络协议应表达每个席位的动作与边沿，适配层再建立对应的旧按键状态。只修改 `Hero.parseInput` 中四个读键位置，未必覆盖梯子、飞行等其他读键分支。

## 3. 物理步长与舞台帧率必须分别处理

| 文件与行号 | 观察到的事实 |
| --- | --- |
| `wck/World.as` 58 | 默认 `timeStep = 0.05` |
| `wck/World.as` 143 | 舞台 `ENTER_FRAME` 驱动 `step` |
| `wck/World.as` 405–416 | 一次 `step` 调用一次 `b2world.Step(...)` |
| `Box2DAS/Dynamics/b2World.as` 354–367 | 记录 `getTimer()`，构造并派发 `StepEvent` |
| `Box2DAS/Dynamics/b2World.as` 424 | 调用 Alchemy 库导出的 `b2World_Step` |
| `Level.as` 703、718–719 | `boom()` 把物理步长设为 0.02，并把舞台帧率设为 15 |
| `Level.as` 709–715、726 | 按帧倒计数，随后恢复步长 0.05、舞台帧率 30 |

这里的 30 FPS 是源码中明确写出的恢复值；由于没有 SWF，本次没有读取原包头的初始帧率，也没有运行确认变速效果。

将整个旧游戏直接改成 60 Hz，或只远程触发物理 `Step`，都不能被视为等价迁移。双击计数、动画、慢动作恢复和其他 `ENTER_FRAME` 回调也参与运行。跨游戏的具体约定见 [输入与时钟契约](INPUT_AND_CLOCK_CONTRACT.md)。

## 4. Alchemy 和显示列表是实质依赖

`Box2DAS/Common/b2Base.as` 39–41 使用 `CLibInit` 初始化库和 `MemUser`，49 行取 `gstate.ds`；正传有 656 个文件出现 `cmodule.Box2D`。这不是可直接导入 Node.js 的纯 JavaScript 物理库。

正传还存在：

- `hitTestObject`：17 个文件，97 次。
- `currentFrame`：23 个文件，146 次。
- `Math.random`：13 个文件，53 次。
- `getTimer`：4 个文件，8 次。

这些是词法计数，不保证每个匹配都会在运行中执行。已检查到的具体玩法依赖包括：

- `hero/Hero.as` 174–205：按实例名读取碰撞部件和各种动作 MovieClip。
- 同文件 568：梯子判断使用身体和头部的显示对象碰撞。
- 同文件 604：池子接触使用 `hitTestObject`。
- 同文件 1633、1648、1790：飞行和攀爬判断读取动画当前帧。
- `enemy/DroppingBee.as` 94：随机选择投放横坐标。
- `enemy/FatRabbitBoss.as`：存在多处随机 AI 分支。

因此，资源 SWF 可能同时提供显示对象、碰撞几何、关卡实例和时间轴。仅有 `.as` 文件，不能保证恢复这些信息。相同输入也不能直接保证多个运行实例一致。

## 5. 续作不能作为正传双人测试的替身

在 `lightning-decompiled/script/scripts/` 中：

- `game/gameObjects/Hero.as` 319–322 将 A/LEFT、D/RIGHT、W/UP、S/DOWN 合并为同一个角色的输入。
- `game/pages/levels/Level1.as` 52 只绑定 `hero1 = flash1`。
- `game/pages/levels/Level.as` 34、36 声明两个角色字段，67–78 有双角色镜头分支。

这些事实不足以证明续作当前提供两名玩家的独立操作。能运行续作、能使用两套按键，不等于正传双人联机已通过。

## 6. 后续实验的边界

当前能完成静态审计、输入语义提取和独立网络机制实验。输入模型通过测试，只能说明模型和传输满足约定，不能说明原游戏运行正确。

补齐运行包后，建议按以下次序验证：

1. 先运行未修改原包，确认加载、关卡和双人操作正常。
2. 对原包增加小范围输入桥，保留原来的角色规则和资源。
3. 确定整个 Flash 帧、定时器、随机与慢动作的驱动方式；输入序列重播后检查玩法状态是否一致。
4. 若不能稳定控制这些依赖，再评估抽取碰撞/关卡数据并迁移规则的工作量。

目前没有足够证据承诺“少量 AS3 修改即可直接成为 Node 权威游戏”。尚待补齐 SWF 和资源，并进行原游戏运行验证。

## 编码记录

本次源文件扫描没有 UTF-8 解码失败。另一个游戏的 `02-fireboy-watergirl/decompiled/3-export/script/scripts/system/Strings.as` 第 344 行包含一个字面量 U+FFFD。它可能是字符处理逻辑中的常量；工具仅报告它的存在，不将其自动判定为损坏，也不改写原文。`§§` 是有效 UTF-8 的反编译标记，不能与编码乱码混为一谈。
