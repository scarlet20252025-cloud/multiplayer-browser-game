# 本地 Agent 检查结论：原游戏材料、播放基准与阻塞

执行日期：2026-11-17（北京时间）
执行环境：Windows 11，Node v22.22.2，npm 10.9.7，Python 3.13.14，
Playwright 1.62.1（chromium-headless-shell），Ruffle 0.7.1（仓库锁文件版本）
代码版本：`1d31780d6e64be65f9c18adaeef6f6a7536578ee`（`work/flash-netplay-lab`，工作区除本次新增外无改动）

---

## 0. 一句话结论

两款原包**都在本地找到了**，逐文件哈希已核对；但**未修改原包都没能进入可玩状态**，
原因分别是发行站点绑定（冰火人）和平台外部模块依赖（闪翼正传）。
作为对照，**未加壳的闪翼续作完整跑到了主菜单**，证明 Ruffle 环境本身没问题。

| 项目 | 结果 |
| --- | --- |
| 森林冰火人第一代（3 个发行版本） | `blocked` — 站点绑定导致 SDK 初始化回调不触发 |
| 闪翼双星正传（4399 发行） | `failed` — 依赖的 4399 CDN 模块被 CORS 拦截 |
| 闪翼双星之闪电行动（对照，非正传） | `passed` — 加载、渲染、主菜单正常 |
| 未修改原包完成关卡 | **未完成**（0 关） |
| 原版联机验证 | **未执行**（`netplayVerified: false`） |

---

## 1. 材料核对

### 1.1 源码与远程审计的对应关系

| 文件 | 本地 SHA-256 | 远程审计值 | 结论 |
| --- | --- | --- | --- |
| 冰火人第一代 `Game.as` | `c0df054d2ce56525f749b93eff0e2d25c9dbda00cb69311be2c4f732b58646cd` | 同 | **一致** |
| 冰火人第一代 `level.as` | `1f38948cdbf0ab437af554ca9fbadfea834743ed4579ae3df69516d05b2f4229` | 同 | **一致** |

### 1.2 版本对应：哪一份 SWF 才是被审计的第一代

`docs/FIREBOY_SOURCE_AUDIT.md` 引用的源码声明 `[SWF(width="640", height="520", ...)]`
（`Game.as:23`，25 FPS）。本地实测 SWF 包头：

| 文件 | 字节数 | 舞台 | 帧率 | 与审计源码匹配 |
| --- | ---: | --- | --- | --- |
| `1-forest-temple_addictinggames.swf` | 1,864,205 | **640×520** | 25.00 | **是** |
| `1-forest-temple_kizi.swf` | 1,994,152 | 640×480 | 25.00 | 否（尺寸不符） |
| `1-forest-temple_sikids.swf` | 1,857,391 | 640×480 | 25.00 | 否（尺寸不符） |

因此**第一代基准只认 `addictinggames` 版**，另两个是同游戏的其他发行打包。
这条同时补齐了审计文档里"没有 SWF 包头、无法确认初始帧率"的缺口：
**实测初始帧率就是 25 FPS**，与源码声明一致。

闪翼同理补齐：正传 `shanyi-binary.swf` 包头是 **800×600 @ 30.00 FPS**，
与 `Level.as` 中慢动作结束后的恢复值 30 FPS 一致（此前只有源码侧证据）。

### 1.3 全部原包清单

见 `evidence/original-games/manifest.json`。要点：

- 冰火人 7 个 SWF（1–4 代 + 第一代 3 个发行版本），全部 AVM2、zlib 完整
  （解压长度与声明长度差值为 0）、资源内嵌（图形 479–815 个，音频 19–46 段）。
- 闪翼正传存在**三层加载链**：
  `shanyi-binary.swf`(3,485,489) → 内嵌 `core-game.swf`(3,457,698) →
  4 个加壳分片。脱壳后得到 `core_1`(2,380) / `core_2`(2,734) /
  `core_3`(1,917,739，纯代码) / `core_4`(3,278,511，纯资源)。
  脱壳算法见 `_scripts/decrypt_4399.py`（在本地归档内，未进本仓库）。
- 闪翼续作 `extracted-C-lightning.swf`(5,159,778) 未加壳，可直接运行。

---

## 2. 森林冰火人第一代：`blocked`（发行站点绑定）

### 2.1 运行时观察

三个发行版本用 `scripts/verify-original-baseline.mjs` 加载，表现一致：

- Ruffle 加载成功，`loadedmetadata` 触发，报告 640×520 或 640×480 @25fps；
- `isPlaying: true`，画布上的同心圆弧**持续旋转**，说明影片在播放；
- 但画面**始终停在预加载帧**，8–15 秒无变化；
- **没有任何 AS3 异常**，**没有 404**，`failedRequests` 为空。

### 2.2 机制（源码证据）

`02-fireboy-watergirl/decompiled/1-export/script/scripts/` 下：

`Game.as:113–115`
```as
AGTK = new AGtoolkit(this,"6050","fireboyandwatergirl","Joliner");
AGTK.AGinitToolkit(CreatePreloader);
```

`AGtoolkit.as:224–228`
```as
public function AGinitToolkit(param1:Function) : void
{
   gameInit = param1;
   domain.initDomain();
}
```

`AGdom.as:116–119`
```as
public function initDomain() : void
{
   AGdomainStatus();
}
```

`AGdom.as:64–70`（`AGdomainStatus` 的关键分支）
```as
_loc3_ = toolkit.AGfileLocation.substr(_loc1_);
toolkit.AGdomain = _loc3_.substring(0,_loc3_.indexOf("/"));
if(_loc3_.indexOf("addictinggames.com") != -1 || _loc3_.indexOf("shockwave.com") != -1)
{
   toolkit.AGmount = true;
   getServer();
}
```

**结论**：`AGfileLocation`（即 SWF 的 loaderURL）不含 `addictinggames.com` 或
`shockwave.com` 时，`getServer()` 不会执行，`AGinitPreloader` 不会被调用，
`CreatePreloader` 回调也就永远等不到 —— 影片停在第 1 帧的预加载动画上。

这**不是** `Game.as:549–553` 那种"把 Game 移出可视区"的表现，而是更早一步的
静默不推进。两者都是同一套发行绑定的结果，但症状不同，远程审计原先推测的是后者。

`AGtoolkit.as:81` 的域名白名单只有 `["www.addictinggames.com"]`；
`shockwave.com` 是额外的放行分支。

### 2.3 未采取的绕行方案（按交接文档第 4 节要求）

没有修改 hosts、没有伪造 Host 头、没有改 SWF、没有删绑定。
本地 `127.0.0.1` 就是拿不到 `addictinggames.com` 这个字符串，
所以状态记为 `blocked` 而不是 `passed`。

---

## 3. 闪翼双星正传：`failed`（平台外部模块依赖）

### 3.1 运行时观察

`shanyi-binary.swf` 加载成功（800×600 @30fps，画布与 WebGL 均正常），
但产生一个失败请求：

```
http://cdn.comment.4399pk.com/control/A4399dv_base.swf
net::ERR_FAILED
Access to fetch at 'http://cdn.comment.4399pk.com/control/A4399dv_base.swf'
from origin 'http://127.0.0.1:PORT' has been blocked by CORS policy:
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

这是 4399 播放壳内置的评论/控制模块，属于**平台外部依赖**，
本地基准宿主不可能提供，也不应该伪造。

### 3.2 判定

按交接文档的分级：**找到具体运行不兼容 → `failed`**（不是环境阻塞，也不是材料缺少）。

补充事实：脱壳后的 `decrypted/core_3.swf`（纯代码包）能加载并渲染
（800×600，WebGL 正常），但画面是**纯白空白** —— 因为它只有 ABC 字节码，
图形与音频全在 `core_4.swf`。

### 3.3 合并实验：静态拼接已证伪

按"代码包 + 资源包"的直觉做了三种合并，**全部未能渲染游戏**：

| 方案 | 做法 | 结果 |
| --- | --- | --- |
| A | core_3 原样 + core_4 的定义 tag 重编号（+1000）后追加 | 加载成功、5/5 检查通过，**纯白** |
| B | 在 A 基础上把文档类从 `fw` 改成 `Main` | 同上，**纯白** |
| C | 加载后调用 Ruffle 的 `player.play()` | 同上，**纯白** |

单独运行的结果对照：

| 包 | 画面 |
| --- | --- |
| `core_3.swf`（代码） | 纯白 |
| `core_4.swf`（资源） | **有画面**：白底、底部黑色地面、正上方一个半球形黑色物体、左上角文字 |
| `core_3 + core_4` 合并 | 纯白 |
| `core-game.swf`（第二层壳，含 4 个加密分片） | 纯黑，点击画面无效 |

**根因**：这不是"代码包 + 资源包"的关系，而是**四段式链式加载**。
`fw` 类里有 4 处独立的加载调用（反编译 `fw.as` 第 1043、2698、2918、4222 行），
分属四个私有方法 `§ fw   §()`、`§  f w  §()`、`§  f w§()`、`§ fw  §()`，
各自 `new` 一个分片类并调用 `§ f  w§(ByteArray, Function)`。这是一条
"前一段加载完成才触发下一段"的链，链头没有被触发时全链不动。

因此：
- `core_3`、`core_4` 只是链上的两段，单独或两两拼接都不会启动；
- 合并包里没有 `fw`，链式加载无从触发，所以即使结构正确、检查全过，画面仍是空白；
- `core-game.swf` 里 `fw` 存在但链头未启动，表现为纯黑且点击无效。

**这条路线要真正走通，只能改 `fw` 的字节码**，在构造函数里直接调用那 4 个私有方法，
或另写一个 AS3 loader 去驱动。本机没有 AS3 编译器（无 mxmlc / Flex SDK），
写 loader 这条暂时不可行；改字节码需要 `rabcdasm`/`rabcasm` 精确插入指令，
`core-game` 的 ABC 只有 50 KB，工具能力上可行，但本次未执行。

合并工具已提交在 `scripts/merge_shanyi_kernel.py`，复现命令：

```bash
python scripts/merge_shanyi_kernel.py core_3.swf core_4.swf -o merged.swf
python scripts/merge_shanyi_kernel.py core_3.swf core_4.swf -o merged.swf --document-class Main
```

它同时验证了 character ID 重编号的正确性：重编号后 2177 个定义的引用关系一致、
SWF 能被 Ruffle 正常解析，只是**缺调度器**。这个工具对后续"把 4 段合并成一个包"
仍然有用，届时需要把 `fw` 一并纳入并改写其触发条件。

---

## 4. 对照组：闪翼续作可以完整运行

`extracted-C-lightning.swf`（5,159,778 B，未加壳，800×600 @30fps）
在同一个 Ruffle 0.7.1 + Chromium 环境里 **5/5 检查通过**，画面是完整的
《闪翼双星之闪电行动 体验版》主菜单：标题、角色立绘、`开始游戏` /
`更多游戏` 按钮、底部工具栏（主页、设置、帮助、音乐、奖杯、全屏）全部正常。

**这条对照证明**：
1. 本地 Ruffle 环境与 WebGL 渲染链路没问题；
2. 闪翼引擎（WCK / Box2DAS / Alchemy `cmodule.Box2D`）在 Ruffle 0.7.1 下能跑起来；
3. 正传的失败**不是**引擎或环境问题，而是 4399 外壳的平台依赖。

**但它不能替代正传验收**：续作是另一个发行包，正传的双人输入、慢动作、
显示列表碰撞都还没在原包上验证过。

---

## 5. 现有探针复现（阶段 B）

在独立 worktree（`../mpbg-baseline`，detached `1d31780`）内执行，
先把历史 `evidence/e2e-results.json`、`evidence/network-results.json`
移到该 worktree 的 `local/previous-evidence/` 再跑，主仓库历史证据未动。

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| `npm test` | 0 | 18 项 Node 测试通过 |
| `npm run test:python` | 5 → 1 | **12/13 通过，1 项失败**（见 5.1） |
| `npm run check:utf8` | 0 | 编码检查通过 |
| `npm run test:network` | 见证据 | 结果文件在 `evidence/local-agent/probe-baseline/` |
| `npm run test:e2e` | 见证据 | 结果文件在 `evidence/local-agent/probe-baseline/` |

### 5.1 Python 测试的 1 项失败（Windows 可移植性缺陷，非环境阻塞）

失败项：`tests/test_fireboy_extract.py::ExtractTests::test_layout_provenance_and_test_map_exclusion`

```
AssertionError: '116e96c75f1fea614424d6b2df2e700ea01d09450a0f978d76d801a12f59c956'
             != '47fcc41b68334c758096c073ecbb274b08b5f4e549eab95a4d1b4184d1a620ac'
  tests/test_fireboy_extract.py:77
    self.assertEqual(result['sourceSha256'], hashlib.sha256(text.encode()).hexdigest())
```

原因：`run_extract()` 用 `p.write_text(text, encoding='utf-8')` 落盘，
而 `Path.write_text` 在 Windows 上默认做 `\n` → `os.linesep`（CRLF）转换；
`audit_fireboy.py:135` 读取的是 `source.read_bytes()`，于是脚本算到的是 CRLF 版本
的哈希，测试断言的却是原始 LF 字符串的哈希。Linux 上 `os.linesep == '\n'`，
所以 CI 通过、Windows 必失败。

已经排除的因素：
- 不是仓库 checkout 的 `core.autocrlf`：把测试文件转成纯 LF 后仍然失败；
- 不是编码：fixture 为纯 ASCII。

**最小修复建议**（本次未改，留给远程 Agent 决定）：
`p.write_text(text, encoding='utf-8', newline='')`，或断言改用 `p.read_bytes()`
的哈希。改完应重跑该文件全部 13 项。

### 5.2 探针复现的证据隔离

新结果放在 `evidence/local-agent/probe-baseline/<run-id>/`，
原有 `evidence/ci-summary.json`、`evidence/screenshots/` 未覆盖、未改写。
本机运行没有重跑 CI，也没有把旧 CI 的成功标记挂到本次提交上。

---

## 6. 复现命令

```bash
# 原包基准（需要先把原包放到忽略目录，见 docs/ORIGINAL_GAME_MATERIALS.md）
node scripts/verify-original-baseline.mjs \
  --root ../flash-archive/02-fireboy-watergirl/flash-original \
  --entry 1-forest-temple_addictinggames.swf \
  --out local/reports/baseline-fireboy.json \
  --shots local/screenshots/fireboy --wait 8000

# 人工观察（只监听 127.0.0.1）
node scripts/original-game-host.mjs \
  --root ../flash-archive/02-fireboy-watergirl/flash-original \
  --entry 1-forest-temple_addictinggames.swf --port 8790

# SWF 包头与标签核查
python scripts/inspect_swf.py ../flash-archive/02-fireboy-watergirl/flash-original \
  --output local/reports/swf-fireboy.json
```

---

## 7. 精确缺件（无法靠现有材料补齐的部分）

| 缺件 | 用途 | 现状 |
| --- | --- | --- |
| 冰火人第一代的**获准自建运行版本** | 绕开 `addictinggames.com` 站点绑定 | 现有 3 个发行版本全部绑定，无法在 `127.0.0.1` 运行 |
| `assets.swf`（`level.as:22` 的 Embed 目标） | 从反编译源码重建可编译工程 | 不在本地任何归档中 |
| 闪翼正传的**平台中立版本** | 绕开 `cdn.comment.4399pk.com` | 4399 版依赖该模块；7k7k 版另有一套加壳算法，未解开 |
| 闪翼正传 `core_3` + `core_4` 的合并产物 | 得到可独立运行的正传 | 两个包都在本地，但合并与验证**未做** |
| 原始 FLA / 可编译 AS3 工程 | 重新编译而非反编译修补 | 不存在于任何已知来源 |

前四项是运行必需，第五项只影响"重新构建"而不影响"运行"。

---

## 8. 建议的下一步

**只做一件事**：先解决冰火人第一代的运行许可问题，而不是继续调网络。

具体路径，按成本从低到高：

1. **向发行方确认**：Coolmath Games 目前托管的是 HTML5 重制版，Flash 原版的
   自建运行许可需要单独确认。拿到许可后，用同一份 `addictinggames` 版 SWF
   在本地验证，`AGmount` 分支能跑通，后续基准才有意义。
2. **如果许可拿不到**，改用 HTML5 版做单关适配：本地已有完整的 1–6 部
   HTML5 运行文件（含 JS、素材、tileset），比 Flash 路线的运行条件更可控，
   代价是要重新做输入桥（不再是 AS3 ExternalInterface）。
3. **闪翼正传先合并 `core_3` + `core_4`**：这是纯技术工作、不涉及许可，
   合并成功后能验证"脱壳产物是否等于原包"，也能立刻得到可运行的正传。

不建议在站点绑定未解决时推进"原游戏输入桥"，因为原包根本进不到关卡，
任何输入桥的测试结果都无法归因。
