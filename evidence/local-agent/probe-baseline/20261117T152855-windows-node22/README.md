# 探针基线复现记录：20261117T152855-windows-node22

本目录是**本地 Agent 于 2026-11-17 在 Windows 上重新运行原创探针**产生的新结果，
与仓库已有的 CI 结果（`evidence/ci-summary.json`、`evidence/e2e-results.json`、
`evidence/network-results.json`）是**不同环境、不同时间的两批证据**。

## 运行条件

| 项目 | 值 |
| --- | --- |
| 代码版本 | `1d31780d6e64be65f9c18adaeef6f6a7536578ee` |
| 分支 | `work/flash-netplay-lab` |
| 工作区状态 | 除本目录等新增文件外无改动；未修改锁文件、未修改测试与被测代码 |
| 运行位置 | 独立 worktree（detached HEAD），非交付仓库根目录 |
| 操作系统 | Windows 11 |
| Node / npm | v22.22.2 / 10.9.7 |
| Python | 3.13.14 |
| Ruffle | 0.7.1（`package-lock.json` 锁定，未升级） |
| Playwright | 1.62.1，chromium-headless-shell，SwiftShader 软件渲染 |

**为什么用独立 worktree**：现有网络/E2E 脚本会写入 `evidence/`。
为避免新 JSON 与历史 `ci-summary.json` 的哈希和运行来源混在一起，
按 `docs/LOCAL_AGENT_HANDOFF.md` 第 4B 节，在 `../mpbg-baseline` 里运行；
运行前先把该 worktree 内历史的 `e2e-results.json`、`network-results.json`
移到 `local/previous-evidence/`，确保不会把残留的 passed 文件当成本次通过。

## 结果

| 命令 | 退出码 | 结果 |
| --- | ---: | --- |
| `npm test` | 0 | 全部 Node 测试通过 |
| `npm run test:python` | 5 → 1 | **12/13 通过，1 项失败**，见下 |
| `npm run check:utf8` | 0 | 编码检查通过 |
| `npm run test:network` | 0 | `passed`，8/8 检查通过 |
| `npm run test:e2e` | 0 | `passed`，13/13 检查通过 |

原始输出见 `logs/`，JSON 见本目录下两份 `*-results.json`，
截图见 `screenshots/`（实验页面，非原游戏画面）。

## 已知偏差：Python 1 项失败

`tests/test_fireboy_extract.py::ExtractTests::test_layout_provenance_and_test_map_exclusion`

`run_extract()` 用 `Path.write_text(text, encoding='utf-8')` 落盘，Windows 上该方法
默认把 `\n` 转成 `os.linesep`（CRLF）；而 `audit_fireboy.py:135` 读的是
`source.read_bytes()`，于是脚本算的是 CRLF 版本哈希，测试断言的却是原始 LF 字符串
哈希，必然不等。Linux 上 `os.linesep == '\n'`，所以 CI 通过。

已排除 checkout 的 `core.autocrlf`（把测试文件转成纯 LF 后仍失败）与编码因素
（fixture 为纯 ASCII）。修复建议：`write_text(..., newline='')`，或断言改用
`read_bytes()`。本次**未修改**被测代码或测试，只记录偏差。

## 与历史 CI 的关系

- 本目录**不覆盖**、**不改写** `evidence/ci-summary.json` 与既有截图；
- 本机没有重跑 GitHub Actions，也没有把历史 CI 的成功标记挂到新提交上；
- 两个 `passed` 状态来自本次实际运行，`recordedAt` 与本文件时间一致。
