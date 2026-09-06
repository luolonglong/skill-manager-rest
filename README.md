# Skills 管理端 · REST + TUI（跨平台版）

PowerShell GUI 版（`K:\AI\skill-manager`）的跨平台重实现：**后端是零依赖的 Node REST 服务，前端是终端 TUI**。一份代码同时支持 **Windows**（NTFS Junction）与 **macOS**（Symbolic Link），只需系统装有 Node（无需 `npm install`）。

## 架构

```
┌────────────┐   HTTP(127.0.0.1)   ┌─────────────┐    fs     ┌──────────────────────────┐
│  tui.js    │ ──────────────────▶ │  server.js  │ ────────▶ │ 中央仓库 ~/.agents/skills │
│  终端渲染   │ ◀────────────────── │  REST API   │ 链接/解链  │ 各 Agent ~\.<tool>\skills │
└────────────┘    JSON 状态/动作     └─────────────┘           └──────────────────────────┘
```

- `lib.js` — 核心逻辑（扫描、SKILL.md 元数据、.skill-lock.json 溯源、启用/禁用、仓库分组），与 PS 版语义对齐（返回码 `ok/skip/conflict/nomaster/fail`、`ok/skip/protected/fail`）
- `server.js` — REST 服务，只绑定 `127.0.0.1`，不对外网暴露
- `tui.js` — ANSI 终端界面（Windows Terminal / iTerm2 / 任何 VT 终端）

## 启动

```sh
# 方式一：一步启动（TUI 会自动拉起 server.js，退出时一并结束）
node tui.js

# 方式二：分开启动
node server.js          # 终端 A
node tui.js             # 终端 B

# Windows 双击 start-windows.bat / macOS: sh start-mac.sh
```

可选参数：`node server.js --config <路径> --port 7741 --host 127.0.0.1`；`node tui.js --url http://127.0.0.1:7741 --no-server`

## TUI 按键

| 键 | 功能 | 键 | 功能 |
|---|---|---|---|
| ↑ / ↓ | 移动光标 | w | 切换工作空间 |
| 空格 | 勾选/取消当前行 | e | 批量启用（勾选行 × 目标 Agent） |
| a / i | 全选 / 反选 | d | 批量禁用 |
| ← / → | 切换目标 Agent（含"全部 Agent"） | o | 开关"覆盖已有副本" |
| r | 刷新 | q / Ctrl+C | 退出 |

## REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/state?ws=空间名` | 全量快照：agents、workspaces、rows[]（每行含每个 Agent 的 `linked/copied/none`） |
| POST | `/api/workspace` | `{name}` 切换活动工作空间（持久化到 config.json） |
| POST | `/api/workspaces` | `{add:{name,path}}` 添加项目工作空间 |
| POST | `/api/enable` | `{skills:[目录名], agent:"*"或名字, ws?, overwrite?}` → `{ok,skip,conflict,nomaster,fail}` |
| POST | `/api/disable` | `{skills:[], agent, ws?}` → `{ok,skip,protected,fail}` |
| POST | `/api/repo` | `{dir, repo}` 手动标注仓库分组（repo 留空清除） |

`config.json` 与 PS 版同构（masterDir / agents / workspaces / activeWorkspace / skillRepoMap），可直接互拷。

## 安全设计（与 PS 版一致 + 实测）

- 禁用只删链接本体；真实目录返回 `protected`，**绝不自动删除**
- 启用遇真实副本返回 `conflict`；只有 `overwrite:true`（TUI 需手动按 `o` 开启）才会替换
- 重复操作幂等（`skip`）；master 无原件返回 `nomaster`
- 删除链接用「移除重解析点」语义，不跟随进目标；测试的清理函数也先摘链接再删树
- REST 只监听 127.0.0.1

## 与 PowerShell 版的差异

1. 扫描忽略 `.` 开头的目录（如 Codex 内部的 `.system`），不再作为可启停行显示（PS 版的已知风险点）
2. 禁用会顺手清掉「失效链接」（PS 版因 Test-Path 语义会跳过它们）
3. macOS 用符号链接（POSIX 无 Junction）；`fs.symlinkSync(..., 'junction')` 在 Windows 上无需管理员权限，与 `mklink /J` 等价

> 诚实说明：Windows 路径已由 143 项无头回归完整验证；macOS 路径是同一套代码、仅链接创建/删除分支不同（`fs.symlinkSync('dir')` / `unlink`），未在真实 Mac 上执行过，首次在 Mac 使用时建议先跑一遍 `node test/test-agents.js`。

## 回归测试

```sh
node test/test-agents.js
```

移植自 PS 版 `test-agents.ps1` 的 136 项用例（用例名一一对应：A1–A10 / B1–B6 / C1 / B-1–B-10 / C-0 / R1–R7），全部改为走 HTTP 调 REST，另加 REST 错误处理与 TUI `--once` 冒烟断言，共 143 项。测试使用独立端口(7799)与独立临时配置，不碰生产 `config.json`；真实环境回路做完自动恢复初始状态；结束自动清理沙箱。

**最近结果：`RESULT: pass=143 fail=0`**
