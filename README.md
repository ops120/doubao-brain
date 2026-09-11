# doubao-brain

把 **豆包网页版**当作编码 agent 的**外部大脑**：它出推理与内容，你的 agent 出执行。
不需要 API key，不做逆向代理 —— 只驱动官方网页。

- 由本地确定性 CLI（`dbb`）驱动，Agent 只负责调用与判断
- 人工登录一次，之后长期复用（字节系 cookie 是持久型，登录持久化比 Gemini 简单得多）
- 发送前有确定性脱敏闸门（私钥整段拒绝、密钥形状脱敏、家目录路径脱敏、尺寸上限）
- 支持 `[DBB]` 协作协议：让豆包做 PLAN → 你执行 → 它 REVIEW 的循环

> ⚠️ **合规与账号风险**：本项目通过浏览器自动化驱动豆包官方网页版，
> 可能不符合其服务条款，存在账号被限流、弹滑块/人机验证甚至封禁的风险。
> 请自行评估并遵守平台条款，**风险自负**；仅供低频个人使用，不要批量滥用。

## 目录

- [能力](#能力)
- [安装](#安装)
- [快速上手](#快速上手)
- [生成图片 / 视频（重点）](#生成图片--视频重点)
- [命令面](#命令面)
- [返回值契约](#返回值契约)
- [协作协议](#协作协议dbb)
- [失败处理](#失败处理)
- [状态与隐私](#状态与隐私)
- [原理与已知坑](#原理与已知坑)
- [边界](#边界)
- [项目结构](#项目结构)
- [同族项目](#同族项目)

## 能力

豆包的能力栏是同类里最宽的（`dbb list-models` 可查当前可用项）：

| 能力 | 说明 | 怎么用 |
| --- | --- | --- |
| **图像生成** | 出图可下载原图（实测 2048×2048） | `--capability "图像生成"` |
| **视频生成** | 文生视频（实测 1280×720 / 10s / 带音轨） | `--capability "视频生成"` |
| **音乐生成** | 生成音乐 | `--capability "音乐生成"` |
| **AI 播客** | 生成播客音频 | `--capability "AI 播客"` |
| **录音转写** | 音频转文字（需用 `--attach` 传音频） | `--capability "录音转写" --attach x.mp3` |
| **帮我写作** | 长文写作模式（文本模式，不产文件） | `--capability "帮我写作"` |

其他可用的开关：

| 开关 | 说明 | 怎么用 |
| --- | --- | --- |
| **多模型可选** | 快速（默认）/ 2.1 Turbo | `--model "2.1 Turbo"` |
| **协作循环** | 规划 / 执行 / 复核的迭代协议 | `--protocol INIT\|EXECUTED` |

> ⚠️ **产物生成类任务必须显式指定 `--capability`**。
> 不切能力时，豆包对「生成一张图」这类请求**只会回一段文字描述**，页面上不会真正渲染产物。
> 这是本项目开发中验证过的坑，详见 [原理与已知坑](#原理与已知坑)。

**能力分两类**（行为不同）：

| 类型 | 能力 | 是否需要参数确认 | 是否产出文件 |
| --- | --- | --- | --- |
| **产物生成**（必须显式 `--capability`） | 图像生成 / 视频生成 / 音乐生成 / AI 播客 / 录音转写 | 视频必现，其余视情况 | ✓ 下载到 `files[]` |
| **文本模式** | 帮我写作 | 通常不需要 | ✗ 只回文本 |

## 安装

### 前置要求

- **Node.js ≥ 20**，含 npm —— 首次配置要把 `playwright-core` 装到状态目录
- 系统已装 **Chrome / Edge / Brave / Chromium** 任一（自动探测，不下载 Chromium）
- 能访问 `doubao.com` 的**浏览器**
- 一个豆包账号（**无需 API key**）
- **需要图形界面**：首次配置会打开有头浏览器请你本人登录，纯 SSH / 容器环境无法完成

### 作为 Skill 安装

目标目录不存在时先建父目录（`git clone` 不会自动创建）：

```bash
mkdir -p ~/.claude/skills ~/.codex/skills ~/.agents/skills   # 已存在则无副作用

# 三条命令按你的宿主任选其一，不要全都执行
git clone https://github.com/ops120/doubao-brain ~/.claude/skills/doubao-brain     # Claude Code
git clone https://github.com/ops120/doubao-brain ~/.codex/skills/doubao-brain      # Codex
git clone https://github.com/ops120/doubao-brain ~/.agents/skills/doubao-brain     # 通用 / ZCode
```

> Windows 的 cmd / PowerShell 不展开 `~`，请改用 `%USERPROFILE%\.claude\skills\...` 这类绝对路径。

装好后对 agent 说：**「用 doubao-brain 完成首次配置」**。

> **关于命令写法（重要）**：本文档里的 `dbb <命令>` 是**文档简写**，并非已安装的命令，
> 等价于 `node "<skill-root>/scripts/dbb/cli.mjs" <命令>`，
> 其中 `<skill-root>` 就是 clone 下来的仓库目录（例如 `~/.agents/skills/doubao-brain`）。
> **直接复制示例前请先配别名**（路径按你的实际安装位置改）：
> ```bash
> alias dbb='node "$HOME/.agents/skills/doubao-brain/scripts/dbb/cli.mjs"'
> ```
> 不配别名也可以，把示例里的 `dbb` 整体替换成上面的 `node "..."` 全路径即可。

### 首次配置

```bash
node "<skill-root>/scripts/dbb/cli.mjs" setup
```

1. 检查 Node 版本与系统浏览器
2. 把 `playwright-core` 装到**状态目录**
3. 打开有头浏览器，**请你本人登录**（手机号验证码 / 抖音扫码，agent 不接触凭证）
4. 导出登录态并冒烟验证

**登录策略**：登录一次后通常长期有效。字节系的登录 cookie 基本都带 `Expires`（持久型），
因此不需要 Gemini 那套 session cookie 的 workaround。服务端会话过期、风控或网站**重弹验证**时
仍需你重新登录。

## 快速上手

```bash
# 体检（建议每次任务前跑）
node "<skill-root>/scripts/dbb/cli.mjs" doctor --json

# 普通问答
node "<skill-root>/scripts/dbb/cli.mjs" ask --prompt-file ./question.txt --json

# 指定模型
node "<skill-root>/scripts/dbb/cli.mjs" ask --prompt "分析下这段代码" --model "2.1 Turbo" --json

# 列出模型与能力
node "<skill-root>/scripts/dbb/cli.mjs" list-models --json

# 写检查点（session set 完整形态；protocol-state / waiting-for 只接受枚举值）
#   --protocol-state: INIT | PLAN_RECEIVED | EXECUTING | EXECUTED_LOCAL | EXECUTED_SENT | DONE | BLOCKED
#   --waiting-for:    none | BRAIN_PLAN | BRAIN_REVIEW | USER
node "<skill-root>/scripts/dbb/cli.mjs" session set   --protocol-state PLAN_RECEIVED --waiting-for none --next-step "execute PLAN" --json

# 生成图片
node "<skill-root>/scripts/dbb/cli.mjs" ask \
  --prompt "一只布偶猫趴在窗台上晒太阳，油画风格" \
  --capability "图像生成" --thread new --json

# 生成视频（异步，需要更长超时）
node "<skill-root>/scripts/dbb/cli.mjs" ask \
  --prompt "一只熊猫在竹林里啃竹子，阳光斑驳" \
  --capability "视频生成" --timeout 900000 --json

# 附件分析
node "<skill-root>/scripts/dbb/cli.mjs" ask --prompt "总结这份文档" --attach ./doc.pdf --json
```

对 agent 说人话也一样：**「让豆包画一只猫」**、**「用豆包生成一段短视频」**。

> 时长 / 比例等参数由豆包在生成前**列出并等你确认**（CLI 会自动确认），
> 当前 CLI **不提供**指定时长的参数。

## 生成图片 / 视频（重点）

### 图片生成

```bash
dbb ask --prompt "一只柴犬坐在樱花树下，水彩插画风格" --capability "图像生成" --thread new --json
```

- 实测约 **30 秒**完成，一次返回 **4 张 2048×2048** 原图（每张 5–7 MB）
- 产物自动下载到 `<state>/downloads/<workspaceId>/`，`files[]` 给绝对路径

### 视频生成（异步 + 参数确认）

```bash
dbb ask --prompt "一只熊猫在竹林里啃竹子，阳光斑驳" --capability "视频生成" --timeout 900000 --json
```

视频走的是**三阶段流程**，CLI 已全自动处理：

```
① 切换能力「视频生成」        → 出现参数面板（模型 Seedance 2.0 Mini + 时长）
② 发送提示词
③ 豆包回复「请先确认以下参数」  → CLI 读取并自动回复「确认，开始生成」
   （列出模型/时长/比例/创作方向/声音/画面文字 6 项）
④ 豆包回复「预计等待 10 分钟…生成好后我会主动发送给你」  ← 异步！
⑤ 约 3 分钟后豆包主动 push 新消息「你的视频生成好了。」
⑥ CLI 提取视频 URL 并下载
```

**要点**：

- **参数确认必须回应**，否则永远等不到产物（CLI 默认自动确认，`--auto-confirm` 控制）
- **视频是异步的**：豆包回复的是"已受理"，不是"已完成"。CLI 会读 ETA 并按预算轮询
- 实际耗时通常**比预告快**（预告 10 分钟，实测约 3 分钟）
- 产物实测 **1280×720 / 10 秒 / H.264 + AAC**，带「豆包AI生成」水印
- 建议给足超时：`--timeout 900000`（15 分钟）
- ⚠️ 产物提取依赖页面上的播放器初始化，若长时间无产物，CLI 会以 `STREAM_STALLED`
  上报而非静默成功

## 命令面

`--json`（机器可读）与 `--debug`（保存页面 HTML）为全局选项；
`--keep-open`（保留浏览器窗口）只对会打开浏览器的命令（`ask` / `doctor` / `setup` / `login` / `list-models`）有意义。
各命令的完整参数以 `--help` 为准。示例使用 `dbb` 简写，未配别名时请展开为 `node "<skill-root>/scripts/dbb/cli.mjs"`。

| 命令 | 作用 | 关键参数 |
| --- | --- | --- |
| `setup` | 首次配置：装依赖 → 打开浏览器 → 人工登录 | `--timeout <ms>` |
| `login` | 重新登录 | `--timeout <ms>` |
| `logout` | 清除登录态（清 `profile/` 与 `storage-state.json`） | — |
| `doctor` | 体检 | `--deep`（真机探测页面/cookie/模型选择器）、`--html` |
| `ask` | 提问 / 生成 | `--prompt` / `--prompt-file`、**`--capability`**、`--model`、`--attach`、`--thread`、`--auto-confirm` / `--no-auto-confirm`、`--no-download`、`--protocol <状态>`、`--task <id>`、`--iteration <n>`、`--timeout`、`--allow-sensitive`、`--allow-large` |
| `list-models` | 列出可用模型与能力栏 | — |
| `thread` | 线程管理 | `status` / `use <url>` / `new` |
| `session` | 工作区级线程与检查点 | `get` / `set --protocol-state --waiting-for --next-step ...` |
| `logs` | 查看脱敏日志 | `-n <行数>`、`--verbose` |
| `update-check` | 检查更新 | `--force` |

> **注意 `--protocol` 与 `--protocol-state` 是两套不同的枚举，别混用**：
> `--protocol`（用于 `ask`）取 `INIT` / `PLAN` / `EXECUTING` / `EXECUTED` / `REVIEW` / `HANDOFF`；
> `--protocol-state`（用于 `session set`）取 `INIT` / `PLAN_RECEIVED` / `EXECUTING` / `EXECUTED_LOCAL` / `EXECUTED_SENT` / `DONE` / `BLOCKED`。

运行方式：`node "<skill-root>/scripts/dbb/cli.mjs" <命令>`。

### 生成类参数速查

| 参数 | 默认 | 说明 |
| --- | --- | --- |
| `--capability <名称>` | 无 | **产物生成类必填**：`图像生成` / `视频生成` / `音乐生成` / `AI 播客` / `录音转写`（`帮我写作` 为文本模式，可选） |
| `--auto-confirm` | `true` | 自动读取并回复豆包的参数确认。关闭方式：`--no-auto-confirm` 或 `--auto-confirm=false`。⚠️ 自动确认会一并确认额度消耗，高风险场景建议关闭并由人工确认 |
| `--no-download` | `false` | **完全跳过产物提取**：`files[]` 为空、`artifacts` 不报告（调试用） |
| `--timeout <ms>` | `300000` | 视频建议 ≥ `900000` |

### doctor 检查项

| 检查项 | 含义 |
| --- | --- |
| `node` | Node 版本 ≥ 20 |
| `deps` | `playwright-core` 已装到状态目录 |
| `browser` | 找到可用的 Chromium 系浏览器（含走哪条探测路径） |
| `stateDir` | 状态目录可写 |
| `network` | 能访问站点（Node 直连失败不算死，会注明） |
| `login` | **仅 `--deep` 时**：cookie 里有登录标志 |
| `deep` | **仅 `--deep` 时**：真机探测页面状态 / 模型选择器 / 能力栏，并截图 |

## 返回值契约

```json
{
  "ok": true,
  "requestId": "dbb_ab12",
  "threadUrl": "https://www.doubao.com/chat/38441140378980354",
  "modes": { "model": "快速", "requested": null,
             "capability": "视频生成", "capabilityRequested": "视频生成" },
  "text": "……回答正文……",
  "files": [{ "file": "<state>/downloads/<wsid>/doubao-video-1731…-0.mp4",
              "bytes": 2840316, "kind": "video", "contentType": "video/mp4" }],
  "artifacts": { "videos": 1, "images": 0 },
  "confirmRounds": 1,
  "mode": "artifact",
  "truncated": false,
  "elapsedMs": 187774
}
```

> `file` 是**状态目录下**的绝对路径，即
> `%LOCALAPPDATA%\doubao-brain\downloads\<workspaceId>\…`（Windows）或对应的 macOS / Linux 路径，
> 不是项目目录。

**字段说明**：

- `modes.model` —— **实际生效**的模型（从按钮读取，如「快速」「2.1 Turbo」）
- `modes.requested` —— **仅指请求的模型**（`--model` 的值）；未指定时为 `null`
- 二者不一致时必须标注；能力另由 `capability` / `capabilityRequested` 表示
- `modes.capability` —— 实际生效的能力（生成类任务的关键字段）。⚠️ 若未显式传 `--capability`，
  这里可能是**上一次残留**的能力栏状态，不代表本次请求
- `files[]` —— **已下载到本地的产物**绝对路径，带 `kind`（`video` / `image`）与 `contentType`
- `artifacts` —— 页面上发现的产物计数（`videos` / `images`）
- `confirmRounds` —— 走了几轮参数确认（视频通常为 1）
- `mode` —— 取值 `chat`（纯文本）或 `artifact`（有产物下载）
- `truncated` —— `true` 表示可能被截断，需如实告知用户

失败（**判别联合**）：`{ "ok": false, "reason": "LOGIN_REQUIRED", "message": "…" }`；
限流场景会额外带 `retryAfterMs`（建议退避毫秒数）。

## 协作协议（`[DBB]`）

与 deepseek-brain / gemini-brain 同构：让豆包当「规划与审查大脑」，
**执行权始终在本地 agent 手里**。示例使用 `dbb` 简写，未配别名时请展开为全路径。

```bash
dbb ask --protocol INIT --task dbb_f81a --iteration 0 --prompt-file goal.txt --json
#   → protocol.reply：PLAN = 拿到方案 | BLOCKED = 停下问用户

dbb ask --protocol EXECUTED --iteration 1 --prompt-file report.txt --json
#   → DONE = 结束 | PLAN = 还有下一轮 | BLOCKED = 停下
#   --task / --iteration 省略时会自动沿用工作区 session 里的值

dbb thread status --json   # 查进度（checkpoint 自动落盘）
```

- 信封由 CLI 自动封装，回复状态由代码解析
- 建议同一任务不超过 12 轮，到顶暂停问用户（这是给 agent 的使用约定，不是 CLI 参数）
- 线程丢失 → 依据 checkpoint 发 HANDOFF，**不粘贴日志或 diff**
- 协议模式下返回值会多一个 `protocol` 字段（`sent` / `reply` / `taskId` / `iteration`），
  详见 [references/protocol.md](references/protocol.md)

## 失败处理

| reason | 含义 | 动作 |
| --- | --- | --- |
| `LOGIN_REQUIRED` | 登录失效 | 停；让用户登录，一次一个动作 |
| `HUMAN_VERIFICATION_REQUIRED` | 人机验证（豆包为**滑块 / 拖动验证**） | 停；用户在浏览器手动完成，一次一个动作 |
| `RATE_LIMITED` | 限流 | 停；按 `retryAfterMs` 退避 |
| `COMPOSER_NOT_FOUND` / `SITE_CHANGED` | 站点改版、选择器漂移 | **版本问题**：`doctor --deep` 定位，修 `scripts/dbb/src/site.mjs` 并发版 |
| `SEND_FAILED` | 发送失败 | 重试一次 |
| `INJECT_MISMATCH` | 注入到输入框的内容与预期长度偏差 > 10%（可能残留旧文本） | 检查是否清空失败；重试一次，仍失败按 `SITE_CHANGED` |
| `STREAM_STALLED` | 流式停滞 / 超时 | 标注「可能截断」；生成类任务可给更长超时后重试 |
| `UPLOAD_REJECTED` | 附件被拒 | 检查类型 / 大小（网页端限制由豆包决定，CLI 不预设白名单） |
| `THREAD_LOST` | 会话 404 | 新会话重问（或 HANDOFF） |
| `LOCKED` | 浏览器被占用 | 等，或问用户 |
| `DEPENDENCY_MISSING` | 依赖缺失 | `setup` 自愈 |
| `SENSITIVE_BLOCKED` | 闸门拦截 | 移除敏感内容；确需发送要用户明确同意 |
| `PAYLOAD_TOO_LARGE` | 正文超 50 KB | 摘要或分片；`--allow-large` 放宽到 200 KB |

完整表（含对用户话术）见 [references/failure-taxonomy.md](references/failure-taxonomy.md)。

**硬规则**：绝不把失败伪装成结果；绝不静默降级后不告知；同类失败最多重试 2 次。

**生成类特别注意**：

- **耗时长的不是失败**：视频预告 10 分钟、实测约 3 分钟属正常，不要过早判失败
- **产物 URL 会过期**：都是签名链接，必须当次提取当次下载，不能缓存 URL 稍后再取

## 状态与隐私

状态目录（`DBB_STATE_DIR` 可覆盖）：

```
Windows  %LOCALAPPDATA%\doubao-brain\
macOS    ~/Library/Application Support/doubao-brain/
Linux    $XDG_STATE_HOME/doubao-brain/   （该变量未设置时通常为 ~/.local/state/doubao-brain/）
```

| 内容 | 说明 |
| --- | --- |
| `deps/` | `playwright-core` |
| `profile/` | 持久化浏览器 profile —— 登录态来源 |
| `storage-state.json` | cookie 备份。**通常不依赖**（字节系 cookie 是持久型，profile 已够用），仅作为异常时的兼容手段 |
| `downloads/<workspaceId>/` | **产物**：生成的图片、视频等 |
| `threads/<workspaceId>.json` | 工作区级线程与检查点 |
| `outputs/<workspaceId>.jsonl` | 审计：每次问答一行元数据 |
| `logs/dbb.log` | 脱敏日志 |
| `debug/` | 仅 `--debug` 或失败时保存的页面截图与 HTML —— ⚠️ **可能含回答正文与你的输入，未脱敏**，排障后建议删除；**不要直接上传到公开 issue** |

**隐私要点**：

- 状态目录权限 `0700`、文件 `0600`（**仅 Unix/macOS 生效**；Windows 依赖用户目录 ACL）
- **不要把状态目录同步 / 备份 / 分享** —— `profile/` 与 `storage-state.json` 含登录 cookie
- **回答正文默认不落盘**，只记录元数据；**产物文件**按需落盘
- cookie / storageState **永不**导出到项目目录、**永不**进日志、**永不**进 prompt
- prompt 发往豆包服务器 —— 发送前经过确定性闸门（拒绝私钥、脱敏密钥与家目录路径）

## 原理与已知坑

### 工作方式

```
你 / Agent ──调用──▶ dbb CLI ──Playwright──▶ 持久 Chrome ──▶ doubao.com
                        │
                        ├─ 发送前：确定性净化闸门
                        ├─ 能力切换：点能力栏入口（生成类必做）
                        ├─ 输入框：contenteditable（TipTap）→ 先清空，再一次性注入
                        ├─ 等待：三阶段（文字回复 → 参数确认 → 产物）
                        └─ 产物：提取签名 URL → Node 直接下载
```

### 真机验证过的坑（别再踩）

1. **不切能力 = 不出产物**（最重要）。直接说「生成一张图」而没点「图像生成」，
   豆包只回一段**文字描述**（"已生成 3 张…"），页面上**根本不渲染图片**。
   必须先在输入框上方的能力栏点对应入口。

2. **生成前会要求确认参数**（视频必现）。豆包先列出 6 项参数
   （模型 / 时长 / 比例 / 创作方向 / 声音 / 画面文字），说「确认后我再开始生成视频」。
   **必须读这条回复并回应确认**，否则永远等不到产物。

3. **视频是异步的**。确认后的回复是「预计等待 10 分钟…生成好后我会主动发送给你」——
   意为**已受理，不是已完成**。豆包会在几分钟后**主动 push 一条新消息**到会话里。
   所以等待策略要读 ETA、按预算轮询、并留意新回复（不能傻等 DOM 元素）。

4. **视频播放器是点击后才初始化的**（最隐蔽）。
   页面上的结构是：

   ```html
   <div class="block-video-…">
     <img src="https://aka.doubaocdn.com/s/…" class="cover-…">   ← 封面图
     <div class="video-player-wrapper-…">
       <div class="video-player-…"></div>                          ← 空的！<video> 不存在
     </div>
     <div class="play-icon-wrapper-…">▶</div>                      ← 播放按钮
   </div>
   ```

   直接 `document.querySelectorAll("video")` 返回 **0**。
   **必须点一下播放按钮**，xgplayer 才会挂载 `<video>` 并暴露 src。
   CLI 的 `extractArtifacts()` 已内置这一步。

5. **聊天区是独立滚动容器**。`window.scrollBy` 无效，要滚那个
   `div[class*="scroller"]` 才能触发懒加载。

6. **产物不用 UI 下载按钮**。三条路都试过：

   | 方式 | 结果 |
   | --- | --- |
   | hover 出现「下载原图」按钮 | ✗ 按钮渲染不稳定 |
   | 右键菜单「下载原图」 | △ 能触发 download 事件，但 Playwright 的 `saveAs` 有竞态（实测崩溃） |
   | **直接请求签名 URL** | ✓ **采用**：图片/视频本身就是签名 HTTP URL，带 cookie 直接请求即得服务器原文件 |

7. **CDN 域名会轮换**：

   | 类型 | 见过的域名 |
   | --- | --- |
   | 图片 | `p3-flow-imagex-sign.byteimg.com` |
   | 视频 | `v9-default.douyin.com`、`v26-vdl.doubao.com` |

   所以域名匹配必须放宽（写死会漏）。另注意 `aka.doubaocdn.com/s/…` 是**封面图**，不是产物本体。

   > 顺带解释：**为什么视频域名是 douyin.com** —— 豆包、抖音同属字节跳动，共用媒体 CDN。
   > 这不是"跳转到抖音"，只是文件存放地址。

8. **输入框要先清空**。豆包会恢复草稿/残留内容，直接注入会把新问题**追加到旧文本后面**
   （实测导致两个问题被拼成一条消息发出）。CLI 会先 `selectNodeContents` + `delete` 清空，
   注入后还会校验长度（偏差 > 10% 报 `INJECT_MISMATCH`）。

9. **用户提问与模型回答要区分**。两者都渲染为 `[class*="inner-item"]`（类名后半段是构建哈希，
   会随版本变，必须**前缀匹配**）。判据：**模型回答含 `div.grid`**，用户提问没有。

10. **回答容器里混着四类噪声**，抽取时必须剔除：
    推荐追问（`suggest-message-list`）、操作栏（`message-action-bar`）、
    时间戳（`<time>`）、免责声明（"AI 生成可能有误"）。

11. **浏览器启动参数**（见 `src/browser.mjs`）：
    - `chromiumSandbox: true` —— 默认 `false` 会注入 `--no-sandbox`，触发 Chrome 警告条且属自动化特征
    - `viewport: null` —— 固定视口会阻止窗口最大化
    - 抹除 `navigator.webdriver`

12. **`--thread new` 不能只靠 goto 首页**：首页会恢复上次会话，必须显式点「新对话」按钮。

### 站点改版了怎么办

唯一需要改的地方是 **`scripts/dbb/src/site.mjs`**：

```bash
# 在 skill 根目录执行（<skill-root> 换成实际安装路径）
node "<skill-root>/scripts/dbb/cli.mjs" doctor --deep --html --json   # 定位漂移
# 改 scripts/dbb/src/site.mjs（选择器集中在此，注意用前缀匹配）
node "<skill-root>/scripts/dbb/tests/sanitize.test.mjs"               # 跑单测
```

## 边界

- **低频辅助工具**：每次问答会真实打开浏览器窗口，不适合批量调用。
  生成类任务耗时长属正常（视频实测约 3 分钟，给足 `--timeout`）。
- **不做批量 / 不做并发**：同一时间只跑一个会话。
- **不做 web2api**：只在本机驱动官方网页，不逆向私有协议、不做 HTTP 代理、不对外暴露接口。
- **能力以页面实际显示为准**：`dbb list-models` 可查当前可用模型与能力栏；
  豆包会调整能力栏（如新增/下线某项）。
- **产物带水印**：生成的图片/视频带「豆包AI生成」水印（平台行为，无法去除）。
- **消耗每日额度**：视频生成会提示"本次生成将消耗每日免费额度"；
  `--auto-confirm` 默认会自动确认这一步，介意的话用 `--no-auto-confirm`。
- **合规风险**：自动化驱动网页版可能违反平台条款，存在限流/验证/封号风险，详见文首警告。

## 项目结构

```
SKILL.md                给 agent 的说明书
README.md               本文件
references/
  install.md            安装、登录策略、更新、卸载
  failure-taxonomy.md   失败码 → 动作
  site-map.md           站点交互地图（含能力栏 / 参数确认 / 异步推送 / 提取三坑）
  protocol.md           [DBB] 协作协议
scripts/dbb/
  cli.mjs               命令面 + JSON 契约 + 三阶段流程
  src/browser.mjs       浏览器探测 + 持久化 + cookie 登录判定
  src/site.mjs          站点层（能力切换、参数确认、产物提取与下载）
  src/sanitize.mjs      发送前确定性净化闸门
  src/session.mjs       线程 / 检查点 / 审计
  src/paths.mjs         状态目录布局
  src/logger.mjs        脱敏日志
  tests/sanitize.test.mjs   14 项净化闸门单测
```

## 同族项目

三个「网页版大脑」共享同一套机制层（净化闸门、会话、日志、CLI 契约），
但**各自独立仓库、独立 skill、互不依赖**：

| | deepseek-brain | gemini-brain | doubao-brain |
| --- | --- | --- | --- |
| CLI | `dsb` | `gmb` | `dbb` |
| 定位 | 推理 + 联网搜索 | 生图 + 代码 Canvas | **生图 + 生视频** + 音乐/播客 |
| 生图 | ✗ | ✓（2816×1536 原图） | ✓（2048×2048） |
| 生视频 | ✗ | ✗ | ✓（1280×720） |
| 音频类 | ✗ | ✗ | ✓ 音乐 / 播客 / 转写 |
| 模型可选 | ✗（只有思考/搜索开关） | ✓（Flash-Lite / Flash / Pro） | ✓（快速 / 2.1 Turbo） |
| 登录持久化 | 简单 | 复杂（需三重保险） | 简单 |

**加第四家怎么做**：复制本仓库，机制层文件可原样复用
（`sanitize.mjs` / `session.mjs` / `logger.mjs` / `paths.mjs`），
只需按站点重写 `browser.mjs`（登录持久化方式可能不同）与 `site.mjs`（选择器与交互流程）。
**不能直接跑** —— 站点层是每个站点专属的。

## 许可证

本项目基于 MIT License 开源。

## 社区

本项目在 [LINUX DO](https://linux.do/) 社区进行开源推广，感谢社区佬友的交流、反馈与建议。
