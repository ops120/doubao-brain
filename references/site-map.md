# 豆包网页版交互地图（仅诊断 / 维护用）

> 正常流程一律走 `dbb` CLI，不要读本文件去手写 DOM 操作。
> 本文件只在站点改版诊断或维护选择器时使用。
> **全部来自真机验证（2026-09，Windows / Chrome 151 / Playwright）**。

## 页面结构

- **输入框**：`div.tiptap.ProseMirror[contenteditable="true"]`（TipTap 富文本）
  - 占位符：`发消息或按住空格说话...`（支持语音输入）
  - **不是 textarea**，React setter 注入法无效
- **发送**：`Enter` 可发送（兜底找 aria 含「发送」的按钮）
- **模型选择器**：输入框右下角，按钮文案形如 **`豆包 快速`** / **`豆包 2.1 Turbo`**
  - 模式名 = 去掉「豆包 」前缀
  - 注意：按钮上可能只显示短名（如「2.1 Turbo」），菜单里才是全名
- **能力栏**（输入框下方，实测可用）：
  `对话` / `视频生成` / `图像生成` / `帮我写作` / `音乐生成` / `AI 播客` / `录音转写` / `更多`
- **顶部模式标签**：`对话` / `工作`（两种不同模式，本 skill 走「对话」）
- **侧栏**：`新对话`、`新工作任务`、`定时任务`、`技能·连接器·伙伴`、`云盘`、`API 服务`；
  会话历史 `a[class*="conversation-item"]`（href 形如 `/chat/<数字ID>`）

## ⚠️ 回答 DOM（最容易踩坑的地方）

豆包用 **Tailwind + CSS module**，类名形如 `inner-item-BjaxFt`
（**后半段是构建哈希，会随版本变化**）→ 必须用**语义前缀匹配** `[class*="inner-item"]`。

### 消息容器结构（真机实测）

```
inner-item
└── div (flex-row)
    └── div (flex-col)                    ← 这一层有 3 个子元素
        ├── div (grid)                    ← [0] 正文（含 div.grid 是回答的标志）
        ├── div (message-action-bar) + <time>   ← [1] 操作栏与时间戳
        └── div .select-none
            └── .suggest-message-list-wrapper   ← [2] 推荐追问
                └── .suggest-list-item ×N
```

### 区分「用户提问」与「模型回答」

一次会话里有多个 `inner-item`。可靠判据（按优先级）：

1. **模型回答含 `div.grid`**，用户提问没有 ← 最可靠
2. 模型回答含 `suggest-message-list` 或 `message-action-bar`
3. 用户提问靠右对齐（左边界在视口右半边）

### 噪声剔除（必须做，否则正文会被污染）

回答容器里混着四类噪声，都要删：

| 噪声 | 选择器 |
| --- | --- |
| 推荐追问 | `[class*="suggest-message-list"]` / `[class*="suggest-list-item"]` |
| 操作栏（复制/朗读/赞/踩/重新生成） | `[class*="message-action-bar"]` / `[class*="message-action-button"]` |
| 时间戳 | `time` 元素（文本形如 `今天 13:11`） |
| 免责声明 | 文本 `AI 生成可能有误` |

**做法**：克隆节点 → 逐个 `remove()` 噪声 → 自写 DOM 文本收集（上标压紧、块级换行）。

## ⚠️ 输入注入（踩过的坑）

**必须两步**：

1. **先清空编辑器**：豆包会恢复草稿/残留内容。
   直接 `insertText` 会把新问题**追加到旧文本后面**（实测导致两个问题被拼成一条消息发出）。
   清空方式：`range.selectNodeContents(ed)` + `execCommand("delete")`
2. **再一次性插入**：`execCommand("insertText", false, text)`
   - 不要用 `keyboard.type()` 逐字符输入（富文本编辑器里慢，且换行可能触发提交）
   - 不要直接设 `innerHTML`（绕过框架状态管理）

**注入后必须校验**：比较 `innerText.length` 与期望长度，偏差超过 10% 就报 `INJECT_MISMATCH`。

## 生成请求

豆包用 SSE 长连接推送。埋点域名（**要排除**）：
`mcs.doubao.com` / `mcs.zijieapi.com` / `mon.zijieapi.com` / `opt.doubao.com` / `mssdk.bytedance.com`

生成端点匹配模式：`/chat\/completion/i`, `/chat\/message/i`, `/sse/i`, `/\/api\/chat/i`, `/generate/i`
（端点名会变，因此**以文本稳定为主判据**，网络信号为辅）

## 完成判定

豆包是**流式输出**（与 DeepSeek 同类，不是 Gemini 那种"一次性返回+打字机"）。判据：

1. 文本连续 3 次采样不变（主判据）
2. 未检测到「停止」按钮
3. 若识别到生成请求，则要求其已结束

实测单次问答 8–16 秒。

## 会话 URL

```
https://www.doubao.com/chat/<数字ID>
例：https://www.doubao.com/chat/38441156656953090
```
- 侧栏会话项 `a[class*="conversation-item"]` 的 href 直接给出
- **注意**：豆包首页 `/chat/` 会**恢复上次会话**，所以 `--thread new` 必须显式点「新对话」按钮，
  不能只靠 `goto` 首页

## 登录态（cookie）

字节系登录 cookie（**都是持久型**，无 session cookie 问题）：
```
sessionid, sessionid_ss, sid_guard, sid_tt, uid_tt, uid_tt_ss,
ttwid, passport_csrf_token, odin_tt, n_mh, sid_ucp_v1, ssid_ucp_v1, has_biz_token
```
实测 36 个 cookie 中 13 个是登录标志。

## 失败形态

- 未登录：cookie 里无上述登录标志（界面也可能显示「登录」按钮）
- 风控：页面出现`滑块`/`拖动`/`验证码`
- 限流：`操作过于频繁` / `访问频繁` / `请求过于频繁`
- 站点改版：`div.tiptap.ProseMirror` / `[class*="inner-item"]` / 模型按钮定位失败

## 维护规则

- 选择器集中在 `scripts/dbb/src/site.mjs`，改完跑 `doctor --deep` 与单测。
- 豆包的类名哈希会变，**始终用前缀匹配**（`[class*="inner-item"]` 而不是 `.inner-item-BjaxFt`）。
