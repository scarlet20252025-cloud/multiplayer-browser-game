# 原游戏材料：放置方式、入口、依赖与重建条件

本文说明两款原包**在实际机器上长什么样**、怎么放、运行时和重建时分别缺什么。
所有相对路径都相对于用户本地的归档根目录（`flash-archive/`），
不记录本机绝对路径、账号或带签名的下载地址。

原包**不进公开仓库**：按文档要求放在 `private-games/` 或 `local/`，
本仓库只保存清单、哈希、工具和证据。

---

## 1. 森林冰火人第一代

### 1.1 放置

```
private-games/fireboy-1/original/
  1-forest-temple_addictinggames.swf     ← 基准只用这一份
  1-forest-temple_kizi.swf               ← 其他发行打包，仅供参考
  1-forest-temple_sikids.swf
```

归档里对应 `02-fireboy-watergirl/flash-original/`。

### 1.2 入口与参数

| 项目 | 值 |
| --- | --- |
| 入口 | `1-forest-temple_addictinggames.swf`（单文件直接加载） |
| 启动参数 | **无**。不需要 flashvars，不需要额外 HTML 包装 |
| 舞台 | 640×520，25 FPS，背景 `#000000` |
| 运行时类型 | AVM2（有 `DoABC` 标签，`FileAttributes` 声明 AS3） |
| 压缩 | CWS（zlib），解压长度与声明长度完全一致 |

### 1.3 依赖关系

**素材层：已内嵌。** 顶层标签里有 494 个图形定义、27 段音频、14 个字体，
没有外部 `DefineBinaryData` 引用。这一点和交接文档的预期一致 ——
不需要另找图片或音频。

**初始化层：有硬外部依赖，这是本次的阻塞点。**

`Game.as:113–115` 创建 `AGtoolkit` 并调用 `AGinitToolkit(CreatePreloader)`；
`AGdom.initDomain()` 只在 SWF 的 loaderURL 含 `addictinggames.com` 或
`shockwave.com` 时才调用 `getServer()`，否则直接返回，
`CreatePreloader` 回调永不触发，影片停在预加载帧。

因此：
- 运行需要**发行方放行的 loaderURL**，或者一份移除了该绑定的授权版本；
- 这与"缺图片素材"是两件不同的事，不能靠补文件解决。

### 1.4 重新构建需要什么

从当前反编译源码重建**不等于**可编译工程：

| 需要 | 状态 |
| --- | --- |
| `_assets/assets.swf`（`level.as:22` 的 `[Embed]` 目标） | **缺失**，不在任何本地归档中 |
| 库符号 / SWC | 缺失 |
| 原始 FLA | 不存在于已知来源 |
| 构建脚本 | 无 |

反编译文本只能用于阅读逻辑和提取数据，不能直接编译成 SWF。
Box2D 部分是 MIT 许可，可以单独复用，但它不构成完整游戏。

### 1.5 已在远程可取的部分

源码（`02-fireboy-watergirl/decompiled/1-export/script/scripts/`）已经在
`flash-archive-源码版` 里交付过，`Game.as` 与 `level.as` 的 SHA-256 与仓库审计一致。
**运行必需的 SWF 尚未以任何形式提供**。

---

## 2. 闪翼双星正传

### 2.1 放置

正传是一个**三层加载链**，不是单个 SWF：

```
private-games/shanyi-core/original/
  shanyi-binary.swf          3,485,489 B   ← 外层平台壳（4399）
  core-game.swf              3,457,698 B   ← 内嵌第二层壳（从上面剥出）
  fragments/                 4 个加壳分片  ← 需要脱壳才能用
```

脱壳产物（本地已生成，属于 derived，不是原件）：

```
private-games/shanyi-core/derived/
  core_1.swf    2,380 B    加载器（550×400）
  core_2.swf    2,734 B    提示页（700×450）
  core_3.swf    1,917,739 B  纯代码包（3 个 DoABC 共 1872 KB）
  core_4.swf    3,278,511 B  纯资源包（886 个图形 / 18 段音频 / 6 个字体）
```

### 2.2 入口与参数

| 项目 | 值 |
| --- | --- |
| 入口（原包） | `shanyi-binary.swf` |
| 启动参数 | 无 |
| 舞台 | 800×600，**30 FPS**，背景 `#000000` |
| 运行时类型 | AVM2 |
| 压缩 | CWS，解压长度与声明一致 |

**30 FPS 这条是本次实测补齐的**：审计文档此前只有 `Level.as` 里慢动作结束后的
恢复值 30，没有 SWF 包头证据；现在两者一致。

### 2.3 依赖关系

| 层级 | 内容 | 状态 |
| --- | --- | --- |
| 外壳 | 4399 平台框架（`L4399Main` 等 20 个类） | 内嵌 |
| 平台模块 | `http://cdn.comment.4399pk.com/control/A4399dv_base.swf` | **外部，CORS 拦截** |
| 游戏代码 | `core_3.swf`（988 个 AS3 类） | 内嵌，已脱壳 |
| 游戏资源 | `core_4.swf`（886 图形等） | 内嵌，已脱壳 |
| Alchemy 库 | `cmodule.Box2D` | **在 SWF 内**，不是外部 DLL |

关于 Alchemy：审计文档要求"先检查 `cmodule.Box2D` 是否已包含在 SWF 中，
再判断依赖"。实测 `core_3.swf` 的 `DoABC` 里含 `cmodule.Box2D.*` 类
（反编译源码中有 `Box2DAS/`、`cmodule/` 目录，共 656 个文件引用），
且 `extracted-C-lightning.swf` 在 Ruffle 里能跑起来 —— 说明该运行时**不依赖外部 DLL**。

### 2.4 重新构建需要什么

| 需要 | 状态 |
| --- | --- |
| 原始 FLA | 不存在 |
| 可编译 AS3 工程 | 不存在；`core-decompiled` 有 27,091 处 `§§push/§§pop` 伪指令 |
| 字节码修改链路 | 可用 `abcexport` / `rabcdasm`（32 位，>1.5 MB 的 ABC 会 OOM） |
| 运行时 | Ruffle 0.7.1 可加载，但要先解决平台模块依赖 |

**运行条件与重建条件要分开看**：运行只差"绕开 4399 平台模块"这一步；
重建则完全没有原始工程，只能走反编译修补。

### 2.5 已在远程可取的部分

正传源码（`01-shanyi-binary/core-decompiled/script/scripts/`）已随
`flash-archive-源码版` 交付，共 987 个 `.as`（仓库审计统计值）。
**SWF 原件与脱壳产物都没有以任何形式提供。**

---

## 3. 闪翼双星之闪电行动（对照材料，非正传）

| 项目 | 值 |
| --- | --- |
| 文件 | `extracted-C-lightning.swf`，5,159,778 B |
| 舞台 | 800×600，30 FPS |
| 压缩 | FWS（未压缩） |
| 依赖 | 无外部模块 |
| 本地结果 | **完整运行到主菜单**（5/5 检查通过） |

它是从加壳版本里还原出来的另一款发行包，**不能作为正传双人验收的替身**
（续作的两套按键可能映射到同一角色，见 `docs/SHANYI_SOURCE_AUDIT.md` 第 5 节）。
提供它的唯一用途是证明本地 Ruffle 环境与闪翼引擎链路正常。

---

## 4. 远程 Agent 现在能拿到什么

| 材料 | 远程可否取得 |
| --- | --- |
| 两款游戏的源码文本 | 可以（`flash-archive-源码版-20261117.zip`） |
| 冰火人第一代原 SWF | **不可以** |
| 闪翼正传原 SWF 与脱壳产物 | **不可以** |
| 逐文件哈希、字节数、包头信息 | 可以（本仓库 `evidence/original-games/manifest.json`） |
| 本次播放基准的结论与错误原文 | 可以（`docs/LOCAL_AGENT_FINDINGS.md`、`baseline-results.json`） |

因此 `materialsAvailableToRemoteAgent` 对两款游戏都是 `false`：
哈希清单不等于提供了原文件，而远程没有原文件就无法复现基准。

## 5. 需要用户另行提供的最小集合

按优先级：

1. **冰火人第一代获准自建运行的版本**（或发行方书面许可），
   最小形态就是一份能在非 `addictinggames.com` 域名下跑完初始化的 SWF。
2. **完整归档 `flash-archive-20261117.zip`（319 MB）**，
   含上述所有 SWF 与脱壳产物。远程 Agent 此前拿到的只是源码版（5.3 MB）。
3. 若长期要做重建：`assets.swf` 与原始 FLA / 工程文件。

前两项解决"能不能跑"，第三项只影响"能不能重新编译"。
