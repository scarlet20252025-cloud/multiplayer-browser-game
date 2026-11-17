# HTML5 原包 ZIP 核验（不公开游戏素材）

目标：对用户上传的 html5-online-20261117.zip 做原始字节的来源核验，不把研究候选当成用户原包，也不把 ZIP 检查当作实机运行。

## 使用命令

```powershell
py -3 scripts/audit_html5_zip.py "E:\实际目录\html5-online-20261117.zip" --out local/html5-upload-audit.json
```

```bash
python3 scripts/audit_html5_zip.py /path/to/html5-online-20261117.zip --out local/html5-upload-audit.json
```

工具只读，逐文件计算 SHA-256、识别六部 game.js、输出第一代关键入口数量与换行格式。拒绝目录穿越、符号链接、重复或大小写冲突、加密与超出限额的归档。结果默认保存在被忽略的 local/。输出 status=inspected 仅表示六部脚本被找到，gameplayVerified/netplayVerified 一律为 false。

作为比较的第三方固定研究候选 game.js 哈希：337125629748bace45e23b040e54b0d206e4cd78c9c8709d7785faa637e00677。哈希不一致需要调查，不能静默认为两者相同。换行归一化哈希仅用于诊断，不改变原始字节哈希。

## 原包的实际下一步

1. 在 local/ 或私人资料目录中安全解包，保留原始文件和结构，不提交游戏 JS、图片、声音和 SWF。
2. 先使用原本未修改的入口做独立播放基准；再使用 scripts/verify-html5-adaptation.mjs 的仅 HTTP 响应注入版本检查跳跃、暂停及两次状态快照。两种测试必须分开命名。
3. 记录源文件 SHA-256、HTTP 响应 SHA-256、脚本版本差异、三项任务实际状态、截图/日志及失败原因。
4. 通过后再接入正式房间输入、暂停命令和状态广播，双客户端实测后才称为原游戏联机。

此前已通过的候选浏览器检查：https://github.com/scarlet20252025-cloud/multiplayer-browser-game/actions/runs/44049750845

本次新增工具和单元测试使用原创 ZIP 夹具，不包含原游戏数据。原游戏版权不因此转移，公开部署还需要相应授权。
