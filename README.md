# doubao-brain

把 **豆包网页版**当作编码 agent 的**外部大脑**：它出推理与内容，你的 agent 出执行。

**豆包独有能力**（能力栏实测可用）：

- 🖼️ **图像生成** —— 出图后可下载
- 🎬 **视频生成** —— 文生视频 / 图生视频
- 🎙️ **AI 播客** —— 生成播客音频
- 🎵 **音乐生成**
- 📝 **录音转写** —— 音频转文字
- ✍️ **帮我写作** —— 长文写作模式
- 🧠 **多模型可选** —— 快速（默认）/ 2.1 Turbo

其他特性：

- 不用 API key，不做逆向代理 —— 只驱动官方网页。
- 人工登录一次，长期复用（字节系 cookie 是持久型，比 Google 系简单）。
- 发送前有确定性脱敏闸门：私钥整段拒绝、密钥形状脱敏、家目录路径脱敏、尺寸上限。
- 机制全在一个可测试的本地 CLI（`dbb`）里，Skill 只负责判断与汇报。

## 安装

把本仓库 clone 到宿主（Claude Code / Codex / ZCode…）的 skills 目录即可，**无需修改任何路径**：

```bash
git clone <repo-url> ~/.claude/skills/doubao-brain     # Claude Code
git clone <repo-url> ~/.codex/skills/doubao-brain      # Codex
git clone <repo-url> ~/.agents/skills/doubao-brain     # 通用
```

然后对 agent 说：**「用 doubao-brain 完成首次配置」**——它会装好依赖、打开浏览器让你登录一次。

依赖：Node.js ≥ 20、系统已装 Chrome / Edge / Brave 任一、一个豆包账号。**不需要 API key。**

## 使用

直接对 agent 说人话：

- 「让豆包画一只柴犬在樱花树下奔跑」
- 「用豆包做个 15 秒的短视频」
- 「让豆包帮我写一篇产品介绍」
- 「用豆包 2.1 Turbo 分析下这个报错」

## 命令面

agent 直接调用，人也可以手跑；全部支持 `--json`。

| 命令 | 作用 |
| --- | --- |
| `dbb setup` / `login` / `logout` | 首次配置 / 重新登录 / 清除登录态 |
| `dbb doctor [--deep]` | 体检（`--deep` 真机探测页面、cookie、模型选择器） |
| `dbb ask --prompt-file f [--model "2.1 Turbo"] [--attach a.pdf] [--thread new\|<url>]` | 单次问答 / 生成 |
| `dbb list-models` | 列出可用模型与能力栏 |
| `dbb ask --protocol INIT\|EXECUTED --task <id> --iteration <n>` | 协作循环（PLAN → EXECUTED → DONE） |
| `dbb thread status` / `dbb session get` | 查看会话与进度检查点 |
| `dbb logs [-n 50]` | 查看脱敏日志 |

运行方式：`node <skill-root>/scripts/dbb/cli.mjs <命令>`。

## 产物

生成的图片 / 视频等会**下载到本地**并在返回的 `files[]` 里给出绝对路径：

```
{ "ok": true, "mode": "artifact",
  "files": [{ "file": "C:/Users/…/downloads/<wsid>/xxx.png", "bytes": 123456 }] }
```

## 结构

```
SKILL.md           给 agent 的说明书：何时用、怎么调、失败怎么办
references/        安装、失败分类、站点地图、[DBB] 协作协议
scripts/dbb/       机制层 CLI（setup/login/doctor/ask/list-models/thread/session/logs）
  tests/           单元测试：node scripts/dbb/tests/sanitize.test.mjs
```

## 状态与隐私

- 状态目录：Windows `%LOCALAPPDATA%\doubao-brain`，macOS / Linux 对应位置；项目目录零残留。
- 登录态存在专用 profile；`storage-state.json` 存 cookie 备份。
- cookie **永不**导出到项目目录、**永不**进日志、**永不**进 prompt。
- 回答正文默认不落盘，只记录元数据；产物文件按需落盘到状态目录。

## 边界

- 多模态能力（视频/音乐/播客）以页面能力栏实际显示为准，`dbb list-models` 可查。
- 低频辅助工具：每次问答会真实打开浏览器窗口，不适合批量调用。
- 多模态生成耗时长（可达数分钟），属正常。

## 与 deepseek-brain / gemini-brain 的关系

同属「网页版大脑」工具族，共享同一套机制层（净化闸门、会话、日志、CLI 契约），
但**各自独立仓库、独立 skill**，互不依赖：

| | deepseek-brain | gemini-brain | doubao-brain |
| --- | --- | --- | --- |
| CLI | `dsb` | `gmb` | `dbb` |
| 生图 | ✗ | ✓（原图 2816×1536） | ✓ |
| 生视频 | ✗ | ✗ | ✓ |
| 代码 Canvas | ✗ | ✓ | — |
| 登录持久化难度 | 低 | 高（需三重保险） | 低（cookie 持久型） |

## License

MIT
