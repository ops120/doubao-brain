# 失败分类与恢复动作

`dbb` 的所有失败都是可枚举的：`{ok:false, reason, message?, retryAfterMs?}`。
按下表处理；需要用户介入时**一次只给一个动作**。

| reason | 含义 | 动作 | 对用户说 |
| --- | --- | --- | --- |
| `LOGIN_REQUIRED` | 登录失效 / 无登录 cookie | 停；让用户在浏览器完成登录（含 reCAPTCHA）；「好了」后重试 | 「豆包 需要重新登录，请在打开的浏览器里完成，好了叫我。」 |
| `CHALLENGE` | 风控 / 滑块验证 | 同上；验证必须用户本人点 | 「碰到人机验证，请在浏览器里点一下。」 |
| `HUMAN_VERIFICATION_REQUIRED` | 滑块 / 拖动验证 | 停；让用户在浏览器里手动完成；「好了」后重试 | 「碰到人机验证，请在浏览器里拖一下。」 |
| `RATE_LIMITED` | 限流 | 停，按 `retryAfterMs` 退避 | 「豆包 提示请求过于频繁，建议 N 分钟后再试。」 |
| `COMPOSER_NOT_FOUND` | 输入框定位失败 | `doctor --deep`；多半是改版 → 按 `SITE_CHANGED` | 不要把 DOM 细节讲给用户 |
| `SITE_CHANGED` | 选择器漂移 | **版本问题**：`doctor --deep` 定位；告知维护者修 `scripts/dbb/src/site.mjs` 并发版。不要现场硬试 DOM | 「豆包 页面改版了，需要更新 doubao-brain。」 |
| `SEND_FAILED` | 发送失败 | 重试一次；仍失败按 `SITE_CHANGED` | — |
| `STREAM_STALLED` | 流式停滞 / 超时 | 已捕获内容标注「可能截断」；生图类可重试（耗时较长属正常） | 「回答可能不完整。」 |
| `UPLOAD_REJECTED` | 附件被拒 | 检查类型 / 大小；`connectOverCDP` 模式有 50MB 限制 | 「这个文件网页版收不了，换一个或压缩后再试。」 |
| `THREAD_LOST` | 会话 404 / 丢失 | 新会话重问；`[GMB]` 模式则从 checkpoint 发 HANDOFF | — |
| `LOCKED` | 另一任务占用浏览器 | 等；或问用户是否停掉另一个任务 | 「有另一个任务正在使用 豆包 浏览器。」 |
| `DEPENDENCY_MISSING` | 依赖缺失 | 自愈：`setup` | — |
| `SENSITIVE_BLOCKED` | 闸门拦截 | 移除敏感内容或改用摘要；确需发送必须用户明确同意 | 「内容里含敏感信息，已被拦截；需要你确认才能发送。」 |
| `PAYLOAD_TOO_LARGE` | 正文超过 50 KB | 先摘要或分片；确需整段加 `--allow-large` | 「内容太长，我先压缩一下再发。」 |

## 硬规则

- **绝不**把失败伪装成结果；**绝不**静默降级模型后不告知。
- **绝不**为绕过失败去手工操作 DOM——机制只存在于 CLI。
- 重试有上限：同类失败最多 2 次，之后交用户或上报维护者。
- **生图 / 写代码耗时长是正常的**（30–60 秒），不要因为慢就判失败。
