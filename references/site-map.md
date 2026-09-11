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



## 能力栏（图像/视频生成的入口，必读）

输入框下方有一排**能力入口**：

```
对话 | 视频生成 | 图像生成 | 帮我写作 | 音乐生成 | AI 播客 | 录音转写 | 更多
```

⚠️ **不切能力 = 不出产物**。实测：直接说「生成一张图」而没点「图像生成」，
豆包只回一段**文字描述**（"已生成 3 张…"），页面上**根本不渲染图片**。
CLI 里对应 `--capability "图像生成"`。

切换后输入框区域会出现该能力的**参数面板**：
- 图像生成：无额外参数（或很少）
- 视频生成：**模型**（如 `Seedance 2.0 Mini`）+ **时长**（如 `自动 · 10s`）

## 生成前的参数确认（视频必现）

豆包在真正生成前会先列参数**要求确认**：

```
我将为你生成一条...视频，请先确认以下参数：
视频生成参数确认
模型： Seedance 2.0 Mini
时长： 10 秒
比例： 16:9 横屏
创作方向： ...
声音： ...
画面文字： ...
确认后我再开始生成视频。
```

**必须读这条回复并回复确认**，否则永远等不到产物。
CLI 里由 `isAwaitingConfirmation()` 检测 + 自动回复「确认，开始生成」。

## 产物是异步推送（视频）

确认后豆包的回复是：

> 本次使用 Seedance 2.0 Mini 生成，**预计等待 10 分钟**。视频生成好后，**我会主动发送给你**。

即**异步**：任务进队列，几分钟后**主动 push 一条新消息**「你的视频生成好了。」
（实测约 3 分钟，比预告快）。这期间页面上没有产物。

因此等待策略必须是：
1. 读回复拿 ETA（`readEta()` 解析「预计等待 N 分钟」）
2. 按 ETA 预算轮询：定期提取产物 + 读有无新回复
3. 视频出现后立即下载（签名 URL 会过期）

## 产物提取的两个坑

**坑 1：视频是 xgplayer 懒加载**
豆包用 **xgplayer（西瓜播放器）**。不在视口内时 `<video>` **根本不挂载**，
`document.querySelectorAll("video")` 返回空。
→ 必须先分步滚动到页面底部触发挂载（`extractArtifacts({autoScroll:true})` 已内置）。

**坑 2：签名 URL 会过期**
```
图片: p3-flow-imagex-sign.byteimg.com/...     （字节图片 CDN）
视频: v9-default.douyin.com/...               （抖音媒体 CDN）
```
URL 带时间戳签名（`dy_q=`、`l=`），**必须当次提取当次下载**，不能缓存稍后再取。

**为什么不用 UI 下载按钮**：
- 「下载原图」只在 hover 时渲染，不稳定
- 右键菜单能触发 `download` 事件，但 Playwright 的 `saveAs` 有竞态（实测崩溃）
- 图片/视频本身是签名 HTTP URL，**直接请求即可拿到服务器原文件**，最稳

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
