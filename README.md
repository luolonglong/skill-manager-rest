# Skills 管理端 · REST + Web 桌面 UI + TUI（跨平台版）

PowerShell GUI 版（`K:\AI\skill-manager`）的跨平台重实现：**Node 零依赖 REST 后端 + 对齐 CC Switch 风格的 Web 桌面界面**（Edge/Chrome App 窗口，无地址栏），另保留终端 TUI。一份代码同时支持 **Windows**（NTFS Junction）与 **macOS**（Symbolic Link）；免安装包自带 Node 运行时，普通用户解压双击即用。

## 界面

- **Web 桌面 UI（推荐）**：顶部工作空间切换 + 每个 Agent 的彩色计数徽章（点击设为批量目标）、搜索框、状态筛选（全部/已链接/副本/未安装）、按仓库分组的技能卡片；每张卡片右侧是各 Agent 的状态头像（实心=已链接、描边=副本、灰色=未安装），**点头像即切换该 Agent 的启停**；勾选多张卡片后底部浮出批量操作栏。
- **TUI（终端，高级用法）**：`node tui.js`，或 `node tui.js --once` 做无头渲染。

## 启动

```sh
# 方式一（推荐）：双击 启动.bat（Windows）/ 启动.command（macOS）
#   → 后台拉起服务 + 自动打开桌面 App 窗口；关闭服务运行 关闭.bat / 关闭.command

# 方式二：分开运行
node server.js          # 终端 A
node app.js             # 终端 B：打开窗口（或直接浏览器访问 http://127.0.0.1:7741）

# TUI
node tui.js             # 或 start-windows.bat / start-mac.sh
```

可选参数：`node server.js --config <路径> --port 7741 --host 127.0.0.1`；`node tui.js --url ... --once --no-server`；`node app.js --no-browser`（只起服务不开窗）。

## REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 |
| GET | `/api/state?ws=空间名` | 全量快照：agents、workspaces、rows[]（含 `skill/desc/repo/url` 与每个 Agent 的 `linked/copied/none`） |
| GET | `/` | Web 桌面 UI（本仓库 `web/index.html`） |
| POST | `/api/workspace` | `{name}` 切换活动工作空间（持久化到 config.json） |
| POST | `/api/workspaces` | `{add:{name,path}}` 添加项目工作空间 |
| POST | `/api/enable` | `{skills:[目录名], agent:"*"或名字, ws?, overwrite?}` → `{ok,skip,conflict,nomaster,fail}` |
| POST | `/api/disable` | `{skills:[], agent, ws?}` → `{ok,skip,protected,fail}` |
| POST | `/api/repo` | `{dir, repo}` 手动标注仓库分组（repo 留空清除） |

服务写入 `.server-pid`（关闭脚本据此停止）；重复启动自动探测已有实例并安静退出。`config.json` 与 PS 版同构。

## 打包分发

`release/` 或 GitHub Releases 提供免安装包（自带 Node 24 运行时，无需安装 Node）：

- `Skills管理端-Windows-v1.1.zip` — 解压后双击 `启动.bat`
- `Skills管理端-macOS-v1.1.tar.gz` — 解压后终端运行 `sh 启动.command`（或双击；首次若被 Gatekeeper 拦截，右键→打开）

## 安全设计（与 PS 版一致 + 实测）

- 禁用只删链接本体；真实目录返回 `protected`，**绝不自动删除**
- 启用遇真实副本返回 `conflict`；只有 `overwrite:true`（Web UI 需在批量栏手动勾选）才会替换
- 重复操作幂等（`skip`）；master 无原件返回 `nomaster`
- REST 只监听 `127.0.0.1`

## 与 PowerShell 版的差异

1. 扫描忽略 `.` 开头的目录（如 Codex 内部的 `.system`）
2. 禁用会顺手清掉失效链接（PS 版因 Test-Path 语义会跳过）
3. macOS 用符号链接；Windows 用 Junction（`fs.symlinkSync(..., 'junction')` 无需管理员权限）

> 诚实说明：Windows 路径已由 143 项无头回归完整验证；macOS 路径是同一套代码、仅链接创建/删除分支不同，未在真实 Mac 上执行过，首次在 Mac 使用时建议先跑一遍 `node test/test-agents.js`。

## 回归测试

```sh
node test/test-agents.js   # 143 项断言（移植 PS 版 136 项 + REST/TUI 冒烟），自动起停测试服务并恢复环境
```

**最近结果：`RESULT: pass=143 fail=0`**

## 更新记录

- **v1.1（2026-09-07）**：新增对齐 CC Switch 风格的 Web 桌面 UI（`web/index.html`，`/` 直接托管）；`app.js` 桌面启动器（拉起服务 + Edge/Chrome App 窗口，支持 `--no-browser`）；`启动/关闭.bat|command` 一键脚本；技能卡片带来源仓库外链（lock 溯源 url，去除 `.git` 后缀）；服务写 `.server-pid`、重复启动优雅退出
