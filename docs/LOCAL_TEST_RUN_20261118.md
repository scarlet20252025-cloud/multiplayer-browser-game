# 本地测试记录：2026-11-18

执行环境：Windows 11，Node v22.22.2，npm 10.9.7，Python 3.13.14，Playwright 1.62.1
代码版本：`8af9f6aedadc959da184626d6df1e02af95565cb`（`work/flash-netplay-lab`）

---

## 1. 自动化测试结果

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm ci` | 通过 | 4 packages，0 vulnerabilities |
| `npm test` | **108/108 通过** | 从上一轮的 18 项增长到 108 项 |
| `npm run test:python` | **Ran 0 tests** | npm script 里的单引号在 Windows 未展开，需直接跑 |
| `python3 -m unittest discover -s tests -p "test_*.py"` | **17/18 通过，1 失败** | 失败项见 §3 |
| `npm run check:utf8` | 通过 | 129 个文本文件 |
| `npm run test:network` | **8/8 通过** | 含 40 ms 双向延迟中继 |
| `npm run test:e2e` | **13/13 通过** | 真实 AS3 权威 + 两个独立浏览器 |

---

## 2. 本机双标签页入口：实测通过

按 `docs/HTML5_LOCAL_TWO_TAB.md` 的说明启动：

```bash
MSYS_NO_PATHCONV=1 node scripts/start-html5-local-room.mjs \
  --root "E:\肥鱼不乐园\flash-archive\02-fireboy-watergirl\html5-online\games" \
  --script 1-forest-temple/js/game.js --require-script lib/require.js \
  --entry-path /1-forest-temple/index.html \
  --expected-sha256 98666cf499473dfadb9b708af10ef2e5e13b50300881a32b7c8d65d7756a5700
```

> Git Bash 会把 `/1-forest-temple/...` 当 Windows 路径转换，必须加 `MSYS_NO_PATHCONV=1`，
> 否则报 `entryPath must be a URL path`。PowerShell 无此问题。

结果：

| 检查 | 结果 |
| --- | --- |
| `http://127.0.0.1:8787/1-forest-temple/index.html` | 200 |
| `http://127.0.0.1:8788/health` | 返回房间 JSON |
| 第一个标签页 | `state=level`，界面显示 **火娃 · 第 1 轮 · 等待另一位玩家** |
| 第二个标签页 | `state=level`，界面显示 **水娃 · 第 1 轮 · 正在游戏** |
| 房间状态 | `ready:[true,true]`、`connected:[true,true]`、`bothReady:true` |

画面确认：完整关卡地图、火娃（左下）、水娃（左中）、红/蓝钻石、黄色杠杆、灰色箱子、
紫色平台、两扇门、倒计时 00:07，右上角 HUD 显示席位与房间状态。

**席位分配符合文档描述**：先连的拿火娃（席位 0），后连的拿水娃（席位 1）。

`game.js` 的 SHA-256 与文档期望值完全一致：
`98666cf499473dfadb9b708af10ef2e5e13b50300881a32b7c8d65d7756a5700`。

---

## 3. 本次发现的两个问题

### 3.1 Windows 下 `shared-assets` 必须手动合并，否则卡在 loading

**现象**：按文档启动后，权威页面 60 秒超时：

```
HTML5_LOCAL_ROOM_FAILED: page.waitForFunction: Timeout 60000ms exceeded.
```

诊断后确认 `state` 停在 `"load"`，控制台有两个 404：

```
404 /1-forest-temple/assets/images/branding/branding_logo_kizi.png
404 /1-forest-temple/assets/atlasses/PreloaderAssets.png
pageerror: Cannot read properties of null (reading 'x')
```

**原因**：这两个文件只存在于 `games/shared-assets/assets/...`，
原仓库靠 `games/sw.js` 的 Service Worker 做透明重定向。
研究宿主用 `page.route` 拦截所有请求（`server/html5-research-room.mjs:24-27`），
Service Worker 的重定向没有生效。

**修复**（本地材料准备，不改代码）：

```bash
cd html5-online/games
cp -rn shared-assets/assets/* 1-forest-temple/assets/
```

补完后 `state` 立即变成 `"menu"`，随后可正常进关。

**建议**：在 `docs/HTML5_LOCAL_TWO_TAB.md` 的"运行条件"里加一步，
说明需要先执行 `tools/restore-assets.sh` 或等价的手动合并，
否则新手会卡在 60 秒超时且不知道该看哪里。

### 3.2 `test_html5_zip_audit` 有一个用例在 Windows 必然失败

```
FAIL: test_reject_unsafe_paths_and_case_duplicates (bad='a\\b')
AssertionError: UnsafeArchive not raised
```

`scripts/audit_html5_zip.py:37` 的检查是对的（`"\\" in raw` 会拒绝反斜杠）。
问题在测试 fixture：`zipfile.writestr("a\\b", ...)` 在 Windows 上会把 `\` 自动转成 `/`
（`ZipInfo.__init__` 里的 `filename.replace(os.sep, "/")`），
于是写进包的其实是合法的 `a/b`，审计当然不报错。

**修复建议**：fixture 里绕过转换，直接构造后赋 `filename`：

```python
info = zipfile.ZipInfo("placeholder")
info.filename = "a\\b"      # 直接赋值，不走 __init__ 的替换
stream.writestr(info, b"synthetic")
```

这是测试的可移植性问题，不是产品代码缺陷；Linux CI 上不会暴露。

---

## 4. 结论

- 远端这一轮的产出**在 Windows 上可以跑通**，108 + 8 + 13 项自动化检查全过。
- 本机双标签页研究室**实测可用**，两席位分配正确，能进关卡。
- 两处需要修补的地方都不影响主链路：一处是文档缺步骤，一处是测试 fixture 的跨平台问题。
- 未验证：整关通关、换关、32 关全覆盖、真实异地延迟、公开发行授权。
