# 给本地 Agent 的交接任务：补齐原游戏材料、验证并提交仓库

更新日期：2026-11-17（北京时间）。本文可直接作为本地 Agent 的任务指令；不需要前面的聊天记录。

## 1. 你的任务与交付目标

用户正在搭建自有服务器上的双人网页游戏平台，目标是把本地双人游戏改成异地联机。**已放弃视频串流；允许适度修改游戏代码。** 远程 Agent 已完成源码审计、方案比较和真实 AS3 网络探针实验，现在需要你利用用户本地的完整资料补齐原游戏运行条件。

请实际检查仓库和本地资料，完成能执行的验证，并把所需工具、报告、证据及获准公开的材料 **commit 并 push 到指定仓库分支**。不要只回复计划或只在本机保存。若有缺件或兼容性阻塞，也要提交准确的报告，让远程 Agent 能据此继续。

本次必做范围：**材料核对 → 复现现有探针 → 未修改原游戏的播放基准 → 提交并回报。** 原游戏单关联网适配是后续阶段；先完成本次交接，不把它扩大为全量游戏重写、平台上线或全关卡验收。

### 仓库位置

| 项目 | 值 |
| --- | --- |
| 仓库 | <https://github.com/scarlet20252025-cloud/multiplayer-browser-game> |
| 工作分支 | `work/flash-netplay-lab` |
| 分支入口 | <https://github.com/scarlet20252025-cloud/multiplayer-browser-game/tree/work/flash-netplay-lab> |
| 现有 Draft PR | <https://github.com/scarlet20252025-cloud/multiplayer-browser-game/pull/1> |
| 本交接文档编写前的资料基线 | `c3805684e30251529fd5fd2be16805b70937a57c` |
| 已完成真实运行测试的代码提交 | `b1779ed50d5d222a61b5e95d7388c1bec9425801` |
| 已通过的 CI | <https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44033828759> |

**使用工作分支的最新提交。** 上述 SHA 是溯源基线，不是要求回退到旧提交。编写本文时 `main` 只有初始化内容，不能只检查默认分支。保持现有 PR；不自动合并到 `main`，不强制推送，不覆盖用户已有修改。

## 2. 已完成什么，仍缺什么

仓库已完整保存当前实验成果：Node.js/WebSocket 房间服务、席位输入校验、匹配与重连、服务端 Chromium/Ruffle 权威宿主、浏览器显示端、自写 AS3 探针源码和 SWF、锁定依赖、测试、运行证据、截图以及两款游戏源码审计。

已保存的 CI 结果为 18 项 Node 测试、13 项 Python 测试、13 项真实浏览器检查、8 项真实 AS3 网络检查和 UTF-8 检查通过。**它们验证的是仓库原创探针。两款原游戏未运行、未完成联机适配，也未部署到用户服务器。** 具体范围见 `docs/VERIFICATION_REPORT.md`、`evidence/ci-summary.json`。

远程实际读到的 `flash-archive-源码版-20261117.zip` 解包后有 4,425 个文件，包含反编译 AS3、ASASM、JSON 和其他文本；没有原游戏 SWF、运行 JavaScript、HTML、图片、音频或字体。另一份名为 `flash-archive-20261117.zip` 的附件当时无法取得，**其实际内容未确认**。优先在用户本地查找这一份完整包，但不能仅凭文件名或包内 README 就认定齐全。

请先按以下顺序阅读仓库：

1. `README.md`：启动方式、当前能力与边界。
2. `docs/ARCHITECTURE_DECISION.md`：已研究的候选路线及官方参考来源。
3. `docs/FIREBOY_SOURCE_AUDIT.md`、`docs/SHANYI_SOURCE_AUDIT.md`：真实源码位置、缺件与版本风险。
4. `docs/INPUT_AND_CLOCK_CONTRACT.md`：输入、时间轴、暂停和重连语义。
5. `docs/VERIFICATION_REPORT.md`、`evidence/ci-summary.json`：已有测试究竟证明了什么。
6. `docs/DEPLOYMENT.md`、`package.json`、`.gitignore`：环境与材料存放约定。

## 3. 需要你找到和核实的材料

### 3.1 每款游戏共同需要

- 未修改的原运行文件、入口页面或启动方式、加载参数，以及实际引用的外部依赖。保留原目录关系和大小写。
- 逐文件的相对路径、字节数和原始字节 SHA-256；压缩包本体和解包文件分别计算，不混为一个哈希。
- 游戏名称、代数/版本、来源与取得日期（能确认多少记录多少）、是否修改过，以及可公开分发的依据。
- 如有原始 FLA、完整 AS3 工程、库符号、SWC、构建脚本或补丁工具，记录其作用、版本和实际缺件。运行条件与重新编译条件分开报告。
- 原游戏与此前反编译源码是否对应的证据。仅同名不够；可使用原 SWF 哈希、已知来源记录、固定工具版本的类/关键逻辑比对。证据不足就填 `unknown`。

先在用户指定的游戏资料目录、现有项目目录或已明确提供的压缩包中查找。不要无限扫描整台电脑；没有资料路径时，先完成仓库检查和环境验证，再向用户索取具体目录或文件。

### 3.2 森林冰火人：优先第一代

| 材料 | 核对要求 |
| --- | --- |
| 第一代原 SWF | 确认是已审计第一代对应的游戏，不用后续代数或另一款重制版替代 |
| 入口/loader/外部资源 | 实际检查加载关系；如果单个 SWF 已内嵌资源，记录为内嵌，不虚构外部缺件 |
| 可重建工程 | 若存在，保留 Embed 所需资源、库符号与构建说明；反编译文本本身不等于可编译工程 |
| 自建运行条件 | 源码发现发行站点 URL 绑定；记录其对获准自建部署的影响，不删除或绕过绑定来制造通过结果 |

第一代反编译路径为：

```text
02-fireboy-watergirl/decompiled/1-export/script/scripts/
```

其中 Embed 引用 `/_assets/assets.swf`。这说明**从这些反编译源码重建时缺少相应符号资产**；不意味着原版 SWF 在运行时一定从外部加载同名文件。应分别检查原包实际依赖和源码重建依赖。

已有源码 SHA-256，可用于判断拿到的文本是否为同一份：

| 文件 | SHA-256 |
| --- | --- |
| `Game.as` | `c0df054d2ce56525f749b93eff0e2d25c9dbda00cb69311be2c4f732b58646cd` |
| `level.as` | `1f38948cdbf0ab437af554ca9fbadfea834743ed4579ae3df69516d05b2f4229` |

不要把这些源码哈希与 SWF 哈希比较。换行或导出工具不同也可能改变源码哈希；哈希不匹配需解释，不能直接断言游戏版本一定不同。

已提取的 32 关完整数据保存在远程原工作环境的忽略目录，未公开进仓库。若需要，可用仓库 `scripts/audit_fireboy.py` 从同版 `level.as` 重现。未知瓦片值 `4` 必须继续标为 unsupported，不猜含义。

### 3.3 闪翼双星：正传

- 找到正传的原 loader/core SWF（若该发行包采用这种拆分）及实际外部资源、启动参数，保留加载链。
- 对应源码目录为 `01-shanyi-binary/core-decompiled/script/scripts/`；不要用 `lightning-decompiled` 的续作代替。
- 先检查 Alchemy/`cmodule.Box2D` 是否已包含在 SWF 中，再判断依赖。不能凭名称假定缺少外部 DLL。
- 当前正传源码有大量 `§§` 反编译伪指令；不要宣称直接用 Flex 就能重新编译。若需要重新反编译或修改字节码，先记录工具版本和原 SWF 哈希，保留原件及单独产物。
- 基准需确认火/冰两角色可分别操作。两套按键都能移动同一个角色，不算双人通过。

### 3.4 本地如果还有完整 HTML5 版本

可作为备选单独登记，包括完整运行 JS、资源、构建/启动方式，以及关卡引用的 `Ground.json`、`Chars.json`、`Objects.json`、适用时的 `LargeObjects.json` 等 tileset。现在仓库审计所对应的材料只有关卡 JSON，不能根据 GID 数字猜地形或机关。

它是否比 Flash 路线更适合接入，要以版本、玩法和实际完整性比较；不要因名称相同就当作同一个原版。

## 4. 执行步骤

### A. 取得正确分支并保留已有工作

如果没有本地克隆：

```bash
git clone --branch work/flash-netplay-lab https://github.com/scarlet20252025-cloud/multiplayer-browser-game.git
cd multiplayer-browser-game
git status --short
git log -1 --format="%H %s"
```

如果已有克隆，先检查 `git status --short` 和当前分支，再 fetch。工作区干净、分支存在时可执行：

```bash
git fetch origin
git switch work/flash-netplay-lab
git pull --ff-only origin work/flash-netplay-lab
```

若本地尚无该分支，使用 `git switch --track origin/work/flash-netplay-lab`。发现未提交改动或分支分叉，先检查并保留，不用 `reset --hard`、强制 checkout 或 force push 覆盖；必要时另建 worktree 处理。

### B. 复现现有探针，保留历史证据

使用 Node.js 22 或以上（现有 CI 使用 24）、npm、Python 3 和 Playwright 对应 Chromium。先用 `npm ci`，保留锁文件中的 Ruffle 0.7.1、Playwright 1.62.1、ws 8.23.0，不在第一次基准时顺便升级依赖。

**现有网络/E2E 脚本会写入 `evidence/`。** 请在单独的基线测试 worktree 中运行，避免把新 JSON 与旧 `ci-summary.json` 的哈希/运行来源混在一起。例如，从工作仓库根目录执行以下命令；目录已存在时换一个未占用名字：

```bash
git worktree add --detach ../multiplayer-browser-game-baseline HEAD
cd ../multiplayer-browser-game-baseline
npm ci
```

新 worktree 自带历史 `evidence/e2e-results.json` 和 `evidence/network-results.json`。**仅在这个临时测试 worktree 内**，先把这两份旧输出移到 `local/previous-evidence/` 再运行测试，主工作仓库的历史证据保持原样。安装或模块导入失败可能发生在写结果之前；没有本次新结果就记录阻塞/失败，不能把残留的 passed 文件当成本次通过。

Linux：

```bash
npx playwright install --with-deps chromium-headless-shell
npm test
npm run test:python
npm run check:utf8
npm run test:network
npm run test:e2e
```

Windows PowerShell：

```powershell
npx playwright install chromium-headless-shell
npm test
py -3 -m unittest discover -s tests -p "test_*.py"
py -3 scripts/check_utf8.py
npm run test:network
npm run test:e2e
```

Windows 若没有 `py` 启动器而 `python` 已指向 Python 3，则用 `python` 替换 `py -3`。每条命令记录退出码；shell 连续执行不代表前一条成功。运行预编译探针不需要 Java，只有重新编译 AS3 时才需要对应工具链。

只将本次实际生成、`recordedAt` 与退出码/日志/状态一致的新结果、必要截图和精简日志拷回工作仓库的独立目录，例如 `evidence/local-agent/probe-baseline/<run-id>/`，并生成运行说明，记录测试时的 `git rev-parse HEAD`、工作区是否有未提交源码修改、时间与环境。截图实际输出位置以脚本为准（当前为 `local/screenshots/`）。不要覆盖原 CI JSON、截图或手改旧 `ci-summary.json` 来表示新的成功。

如需手动打开实验页面，在一个单独终端运行：

```bash
npm start
```

访问 <http://127.0.0.1:8780>，用两个独立浏览器上下文验证两席位。`npm start` 默认只监听本机；创建房间会实际启动权威 Ruffle。首页或 `/health` 正常还不足以证明 AS3 已运行。

本任务的原包检查先用本机地址。如果后续验证用户局域网，在 PowerShell 可设置 `$env:HOST="0.0.0.0"`、`$env:PORT="8780"` 后启动；Linux 对应 `HOST=0.0.0.0 PORT=8780 npm start`。这是监听设置，不代表公网部署已经完成。

**测试和新证据复制完成后，回到原工作仓库。** 上例执行 `cd ../multiplayer-browser-game`，已有克隆使用其实际目录，再执行 `git branch --show-current` 确认是 `work/flash-netplay-lab`。后续材料检查、文件修改和提交均在该工作仓库进行，不在 detached 测试 worktree 里交付。

### C. 建立材料清单

将原始材料放在用户已有资料目录或仓库忽略目录，例如：

```text
private-games/fireboy-1/original/
private-games/shanyi-core/original/
local/original-games/derived/
```

这些是建议目录，**当前并不存在已填好的原包**。解包时保留原目录、中文文件名和原始字节；拒绝路径越界，不自动执行包内脚本。原文件保持不变，任何导出/补丁产物放在单独的 derived 目录。

已有只读源码扫描工具可复用：

```bash
python3 scripts/audit_archive.py "/实际的解包目录" --output local/reports/archive-audit.json --manifest local/reports/archive-file-manifest.json
```

Windows 使用 `py -3` 或可用的 Python 3 命令。该工具不是完整 SWF 兼容性验证器；为二进制包补充 SWF 包头、入口、资源请求和依赖检查。公开清单使用资料包内相对路径，不记录本机用户名、私人绝对路径、账号令牌或带签名的下载地址。

### D. 验证未修改原包

先完成原包的本地播放基准，**原文件保持不变**。基准首选仓库已锁定的 Ruffle 0.7.1；如另测新版或其他运行时，用单独记录对比，不能覆盖第一次结果或悄悄修改锁文件。

现有首页只加载原创 `probe.swf`，没有通用原游戏启动器。若需要，请新增一个原创、可复现的本地基准宿主/脚本：只监听 `127.0.0.1`，使用配置明确指定的游戏根目录和入口，保留相对加载路径，防止目录越界，不暴露整个硬盘。提交宿主代码与说明，原包保持在忽略目录。不要把原包塞进探针路径，或通过修改 catalog/health 把它标成已联机。

| 每款原游戏要检查的内容 | 必须记录的证据 |
| --- | --- |
| 真实原 SWF 加载 | 文件哈希、入口/参数、实际 Ruffle 与浏览器版本、加载错误或缺失资源；不能仅记录首页截图 |
| 菜单进入实际关卡 | 操作步骤、关卡名称/编号、加载后的状态，必要时可公开的截图 |
| 两名角色独立控制 | 分别移动、同时移动、跳跃、按住/松开、一次短按；记录实际按键与结果 |
| 规则能推进 | 冰火人至少观察收集、机关/门、死亡重试；闪翼观察双角色、碰撞和一项实际可到达的交互 |
| 至少一个关卡完成 | 成功进入通关结果并能重试或继续；如果做不到，写清未完成或阻塞，不用“能移动”替代 |
| 运行异常 | console/page error、请求失败、可见提示、站点绑定或启动参数问题；记录错误原文和复现步骤 |

阶段结果采用 `passed`、`failed`、`blocked`、`not-run`：环境启动不了是环境阻塞；找到具体运行不兼容是失败；没有材料是材料阻塞；没执行就是未运行。部分检查通过不自动把整款游戏标为可玩。音频未验收等未覆盖项另列。

保留原始日志于本地；提交前脱敏。不得通过删除站点绑定、绕过访问限制、忽略异常或改写报告来获得 passed。若无法取得获准自建运行的版本，继续完成材料清单、其他游戏和阻塞报告。

## 5. 需要提交回仓库的文件

以下是本次任务要求新建的交付路径，不是声称仓库已经包含这些原包结果。字段可扩展，但必须真实、可机器读取并能定位证据。

| 路径 | 必需内容 |
| --- | --- |
| `docs/LOCAL_AGENT_FINDINGS.md` | 本地检查总结、版本对应、每款游戏已完成/失败/缺件、复现命令、下一步建议；文件不足时列出精确需求 |
| `docs/ORIGINAL_GAME_MATERIALS.md` | 原包放置方式、入口及参数、依赖关系、运行和重新构建分别需要什么、哪些已在远程可取、哪些需另行提供 |
| `evidence/original-games/manifest.json` | 两款游戏逐文件清单、哈希、字节数、归属/角色、相对路径、来源、公开分发状态和远程可取得性 |
| `evidence/original-games/baseline-results.json` | 未修改原包的实测环境、输入文件哈希、逐项状态、错误/阻塞、证据路径；缺材料也要写 blocked |
| `evidence/local-agent/probe-baseline/<run-id>/` | 本机复现原创探针的新结果，明确与原游戏基准区分；保留原 CI 历史 |
| 必要的 `scripts/`、本地基准宿主与对应说明 | 本次原创的扫描/运行/记录工具，使后续 Agent 在拿到同一原包后可复现 |

### 清单字段约定

`manifest.json` 顶层至少包含 `schemaVersion`、`recordedAt`、`repositoryCommit`、`games`。`recordedAt` 用带时区的 ISO 8601；`repositoryCommit` 是执行检查时的代码版本，不虚构尚未产生的提交 SHA。

每个 game 至少记录：

- `gameId`：建议 `fireboy-1` 或 `shanyi-core`；`versionDescription`、`sourceVersionMatch` 和对应证据。
- `materialsLocated`：`complete` / `partial` / `none` / `unknown`，另列 `missing`；只有实际依赖已核查时才用 complete。
- `entrypoint`、`launchParameters`、`dependencies`；记录依赖是内嵌、已找到的外部文件还是缺失项。
- `files[]`：至少有 `relativePath`、`role`（archive/entry/loader/core/asset/source 等）、`bytes`、`sha256`、`modified`、`source`。
- 每个文件的 `publicRedistribution`：`allowed` / `restricted` / `unknown` 与 `basis`；`repositoryPath`（不公开时为 null）；`availability`（例如 repo/private-local/missing）。
- `materialsAvailableToRemoteAgent`：`true` / `false`，另附缺少哪些运行必需文件。只有远程能实际取得全部运行必需文件才为 true；哈希清单不等于提供了原文件。

如能可靠读取 SWF 包头和必要标签，分别记录压缩签名、SWF version、画面尺寸、声明帧率与 AS/AVM 类型。AS/AVM 类型需依据 FileAttributes、ABC 等实际标签/内容确认，不能仅凭 SWF version 推断；无法确认就写未知及原因。源码里的恢复帧率不能充当实测包头初始帧率。

### 运行结果字段约定

`baseline-results.json` 顶层至少包含 `schemaVersion`、`recordedAt`、`testedCommit`、`workingTreeDirty`、`environment`、`games`。每个 game 记录原文件 SHA-256、入口、参数、运行时版本、`checks[]`、`errors[]`、`evidencePaths`、`blockers`。

每个 check 有 `name`、`status`、操作/观察 `detail` 和证据路径。分别记录 `baselinePlayable`（true/false/null，null 表示未能判定）与 `netplayVerified`。**本任务仅完成未修改原包播放时，`netplayVerified` 仍为 false。** 如工具失败，保存失败退出码和错误，不生成成功占位 JSON。

## 6. 哪些材料可以进这个公开仓库

本仓库是公开仓库。已提供源码归档的 README 注明用于保存/学习研究、禁止再发布素材，并不代表获得原作者再分发授权；探针目录的 MIT 许可也不覆盖原游戏。

因此按下面的规则执行，无须为正常提交原创工具和报告再次停下来申请确认：

1. **提交原创工作和可公开证据。** 包括工具、适配器新增代码、最小必要且获准公开的补丁、脱敏清单/哈希、说明和实测结果。游戏画面截图也先判断是否可公开；不能公开时提交观察记录及本地证据哈希。
2. **有明确公开分发依据的游戏材料**，连同来源、许可和版本说明一并提交。使用独立目录（例如 `games/<game-id>/runtime/`），保持入口相对路径，记录 manifest 中的仓库路径。不要把文件加入 `public/` 就当作完成适配。
3. **受限或授权不明的原 SWF、源码、地图、素材**，保留于 `private-games/`、`local/` 或用户资料目录；提交文件名、哈希、缺件及放置说明，明确告诉用户需通过获准的私有交付方式提供哪些文件，或直接重新上传原归档给远程 Agent。不要把仅本机存在写成仓库已齐全。
4. 不提交账号凭据、`.env`、个人绝对路径、带令牌链接、整个第三方 SDK、`node_modules` 或未经确认的整包。不要用 `git add -f` 绕过忽略规则批量上传原包。

若材料不能公开，资料报告仍应按时提交；将“工具/报告已交付”和“远程尚无法取得完整原包”分别写明。不要为了交付方便改变仓库可见性或许可。

## 7. 后续原游戏适配必须保留的方向

这些是后续设计约束，**不要求本次先完成全部适配再交付材料**：

- 服务端一个权威实例推进玩法，客户端发送本席位输入并应用结构化场景状态；不恢复视频串流方案。
- 优先保留原游戏的 `ENTER_FRAME`、时间轴、Timer 和动态帧率；在已核实的输入读取点消费队列、在游戏更新末尾采样。探针的手动 `netStep` 不作为原游戏通用模板。
- 冰火人舞台声明 25 FPS、物理步长 `1/26` 是不同参数；闪翼慢动作也有独立帧率/步长。先保留语义，不统一改成 60 Hz。
- `EXIT_FRAME` 未经验证不能当作全游戏更新屏障；`MovieClip.stop()` 也不能保证其他玩法监听器停止。
- 输入持续状态、按下/松开和重复点击要分别处理；确认序号对应已经被玩法消费的输入，不能收包即确认。菜单、重试、暂停优先用房间命令。
- 客户端显示适配须禁用本地物理、AI、伤害、收集、胜负等规则副作用；位置一致不等于机关、动画和通关一致。
- 原游戏状态快照不等于完整 VM/物理恢复点；未经验证，不声称确定性锁步、回滚、服务器崩溃恢复或高并发已完成。

材料和原包基准可用后，优先用冰火人第一代一关验证输入桥、场景状态导出和两个客户端显示，再决定是否扩大。闪翼正传因 Alchemy、反编译质量和显示列表碰撞依赖单独评估。路线变更需用实测证据解释，不用简化方块或另一款游戏代替原版验收。

## 8. 提交、推送和最终验收

### 提交前

- 审查 diff，确认没有意外改动历史证据、锁文件、原包或无关代码；所有新文本使用 UTF-8，运行仓库编码检查并检查中文是否可读。
- 纯文档/清单更新检查格式、路径、JSON 和哈希即可；若修改可运行代码，补充有针对性的测试，涉及房间或 AS3 链路时运行相应既有回归。
- 新测试证据明确记录实际测试版本和范围。先跑测试再提交证据时，允许用已测代码提交加工作区变更说明，不把旧 CI 自动标到新代码上。
- `.gitignore` 保护原包目录；显式选择提交文件，先看 `git diff --cached --stat` 和 `git diff --cached`。需要公开的二进制另外逐个核对来源、体积和哈希。

### 实际提交并推送

下列命令中的路径须已实际创建。工具文件和本次独立证据目录也需按实际名字显式 `git add`，不能漏交；不要使用占位文件来凑齐路径。

```bash
git add docs/LOCAL_AGENT_FINDINGS.md docs/ORIGINAL_GAME_MATERIALS.md
git add evidence/original-games/manifest.json evidence/original-games/baseline-results.json
git diff --cached --stat
git diff --cached
git commit -m "Record original game materials and local playback baselines"
git push origin HEAD:work/flash-netplay-lab
git rev-parse HEAD
git ls-remote origin refs/heads/work/flash-netplay-lab
```

提交前确认当前分支仍为 `work/flash-netplay-lab`，远程没有未经处理的新提交。若推送因分叉被拒，fetch 后检查并保留双方工作，再正常合并或整理自己的提交；不 force push。只提交文档/证据且无需运行 CI 时可在提交信息标 `[skip ci]`；有运行代码变化时不要据此跳过所需验证。

推送成功后核对远程 SHA，并打开远程文件确认内容存在。现有 PR #1 会跟随分支更新，保持 Draft，不自行 merge。若当前环境没有写权限或推送失败，保留本地提交并明确报告阻塞，不能声称远程已更新。

### 什么才算本次完成

| 层级 | 完成条件 |
| --- | --- |
| 工具和资料报告已交接 | 必需报告/清单/实测或阻塞记录已提交并可从远程读取 |
| 原包材料已齐全 | 每款游戏入口与所有实际运行依赖已核实；受限文件仍仅在本地时，不能声称远程已齐全 |
| 原包播放基准通过 | 同一未修改原包在记录环境中通过本次所有必需检查，至少完成一个关卡；部分通过明确列出 |
| 原版联机通过 | 另行完成原游戏真实双客户端、权威输入/状态及玩法验收；本次探针或原包播放均不能代替 |

## 9. 给用户和远程 Agent 的回报模板

完成后请使用下面结构答复，附真实链接，不只说“已完成”：

```text
远程提交：<SHA 与 commit URL；未推送成功则明确写失败原因>
工作分支：work/flash-netplay-lab
PR：https://github.com/scarlet20252025-cloud/multiplayer-browser-game/pull/1

已提交文件：<报告、manifest、baseline-results、工具和新增证据路径>
现有探针复现：<通过/失败/阻塞；测试环境与证据路径>
冰火人第一代：<材料完整性；原包基准结果；原版联机是否实际测试>
闪翼双星正传：<材料完整性；原包基准结果；原版联机是否实际测试>

远程 Agent 现在是否只靠仓库就能复现原包：<是/否，分别说明两款>
仍缺或不能公开的文件：<精确文件名、大小、SHA-256、用途；未知就写未知>
用户需要另行提供：<最小文件集合/完整归档名及放置方式>
建议下一步：<一个有明确依据的下一项实验>
```

最终目标是让远程 Agent 收到可核查的提交，准确知道“现在能运行什么、还缺什么、接下来应改哪里”。有阻塞时诚实交付部分结果和精确缺件，比把未验证项目填成通过更有用。
