# 安装、配置与维护

## 依赖

- Node.js ≥ 20
- 系统已安装 Chrome / Edge / Brave / Chromium 任一（自动探测，无需下载 Chromium）
- 能访问 `doubao.com` 的**浏览器**（Node 直连可能因 TLS/代理失败，不影响使用）
- 一个 Google 账号（**建议用小号**：Google 对自动化浏览器有风控）

**无需 API key。**

## 安装

本仓库根目录就是 skill 目录：

```bash
git clone <repo-url> ~/.claude/skills/doubao-brain     # Claude Code
git clone <repo-url> ~/.codex/skills/doubao-brain      # Codex
git clone <repo-url> ~/.agents/skills/doubao-brain     # 通用
```

## 定位 skill 根

命令里的 `<skill-root>` = `SKILL.md` 所在目录。按顺序尝试：

1. 宿主的 skill 加载路径（通常已在上下文里给出）；
2. 常见位置：`~/.claude/skills/doubao-brain`、`~/.codex/skills/doubao-brain`、`~/.agents/skills/doubao-brain`；
3. 仍找不到 → 问用户。

## 首次配置

```bash
node "<skill-root>/scripts/dbb/cli.mjs" setup
```

依次：检查 Node 与浏览器 → 把依赖装到状态目录 → 打开浏览器**请用户登录 Google** → 导出登录态。

登录用手机号验证码 / 抖音扫码，由用户本人操作；登录态持久化，之后长期有效。

## 登录持久化原理

豆包（字节系）比 Google 系简单：登录态 cookie 基本都是**持久型**
（`sessionid` / `sid_guard` / `sid_tt` / `uid_tt` / `ttwid` 都带 Expires），
所以不需要 `--restore-last-session` 那类 workaround。

仍保留的保险：
- `storage-state.json` 导出 + 启动时注入（第二重保险）
- 优雅关闭 `ctx.close()`（强杀会跳过 cookie 落盘）

**登录判定用 cookie，不看界面**（界面可能隐藏登录按钮造成误判）。
标志性 cookie：
`sessionid / sessionid_ss / sid_guard / sid_tt / uid_tt / uid_tt_ss / ttwid / passport_csrf_token / odin_tt / n_mh`

**降低风控的启动参数**（已内置）：`chromiumSandbox: true`、`viewport: null`、
`--disable-blink-features=AutomationControlled`、抹除 `navigator.webdriver`。

## 状态目录

- Windows `%LOCALAPPDATA%\doubao-brain\`；macOS `~/Library/Application Support/doubao-brain/`；Linux `$XDG_STATE_HOME/doubao-brain/`（`GMB_STATE_DIR` 可覆盖）。
- 内容：`profile/`（登录态）、`storage-state.json`（cookie 备份）、`downloads/<workspace>/`（生图/代码产物）、`threads/`、`logs/`、`outputs/`。
- cookie **永不**导出到项目目录、**永不**进日志、**永不**进 prompt。

## 更新

```bash
cd <skill-root> && git pull
node scripts/dbb/cli.mjs update-check --force --json
```

站点改版时 `doctor --deep` 会报 `SITE_CHANGED`，拉取最新版即可（选择器集中在 `src/site.mjs`）。

## 敏感数据与 `--allow-sensitive`

默认拒绝私钥、`.env`、密钥形状。确需发送时（**用户明确知情同意**后）加 `--allow-sensitive`。
不要替用户做这个决定。

## 卸载

1. 删除宿主 skills 目录下的 `doubao-brain/`；
2. 删除状态目录（含登录态与产物）。
