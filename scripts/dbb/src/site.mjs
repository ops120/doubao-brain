import fs from "node:fs";
import path from "node:path";

const { writeFileSync, mkdirSync } = fs;
const ensureDir = (dir) => {
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * doubao.com 页面交互层
 *
 * 所有选择器来自真机验证（2026-09）。豆包用 Tailwind + 自定义 CSS module，
 * 类名形如 `inner-item-BjaxFt`（后半段是构建哈希，会变），
 * 因此优先用**语义前缀匹配**（`[class*="inner-item"]`）而不是完整类名。
 *
 * 与 Gemini / DeepSeek 的关键差异：
 *   - 输入框是 TipTap（`div.tiptap.ProseMirror[contenteditable]`）
 *   - 回答**直接在页面里**（没有 Canvas 面板），但有明确的容器类前缀
 *   - 有「对话 / 工作」双模式标签，以及能力栏（视频/图像/音乐/播客/转写）
 *   - 模型选择器在输入框右下角，文案形如「豆包 快速」
 */

export const SITE_URL = "https://www.doubao.com/chat/";

/** 会话 URL：https://www.doubao.com/chat/<数字ID> */
export const CONV_URL_RE = /\/chat\/\d+/;

export const LABELS = {
  editorPlaceholder: "发消息或按住空格说话",
  generationNotice: "AI 生成可能有误",
  newChat: "新对话",
  modelPrefix: "豆包",
  stop: "停止",
};

/* --------------------------------- 状态探测 --------------------------------- */

export const STATE_FN = () => {
  const body = document.body ? document.body.innerText || "" : "";
  const ce = [...document.querySelectorAll('[contenteditable="true"]')].filter((e) => e.getClientRects().length);
  const ta = [...document.querySelectorAll("textarea")].filter((e) => e.getClientRects().length);
  return {
    url: location.href,
    title: document.title,
    hasEditor: ce.length > 0 || ta.length > 0,
    editorKind: ce.length ? "contenteditable" : ta.length ? "textarea" : null,
    editorClass: ce[0] ? String(ce[0].className).slice(0, 80) : null,
    // 登录判定辅助：豆包未登录会显示「登录」按钮
    loginHints: [...document.querySelectorAll("button,a,div[role=button]")]
      .map((e) => (e.innerText || "").trim())
      .filter((t) => /^(登录|立即登录|手机号登录|扫码登录)$/.test(t))
      .slice(0, 3),
    challenge: /滑块|拖动|验证码|人机验证/i.test(body.slice(0, 1200)),
    rateLimited: /操作过于频繁|访问频繁|请求过于频繁|稍后再试/i.test(body),
    textSample: body.replace(/\s+/g, " ").trim().slice(0, 240),
  };
};

export async function pageState(page) {
  return page.evaluate(STATE_FN);
}

export async function gotoSite(page, url = SITE_URL) {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(3500);
}

/** 等输入框就绪（登录判定必须看 cookie，不看界面） */
export async function waitForEditor(page, { timeoutMs = 1800000, pollMs = 3000, onTick } = {}) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await page.evaluate(STATE_FN).catch(() => null);
    if (last?.hasEditor) return { ok: true, state: last };
    onTick?.(last, Date.now() - started);
    await page.waitForTimeout(pollMs);
  }
  return { ok: false, state: last };
}

/* --------------------------------- 输入与发送 -------------------------------- */

/**
 * 注入 prompt（TipTap / ProseMirror）。
 *
 * ⚠️ 必须先清空编辑器：豆包会恢复草稿/残留内容，直接 insertText 会把新问题
 *    追加到旧文本后面（实测导致两个问题被拼成一条消息发出）。
 * 用 execCommand("insertText") 一次性插入：
 *   - keyboard.type 逐字符输入在富文本编辑器里慢且可能触发换行提交
 *   - 直接设 innerHTML 会绕过框架的状态管理
 */
export async function injectPrompt(page, text) {
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.waitFor({ state: "visible", timeout: 20000 });
  await editor.click();
  await page.waitForTimeout(300);

  // ① 清空编辑器（全选 + 删除，走框架认可的方式）
  const cleared = await page.evaluate(() => {
    const ed = document.querySelector('[contenteditable="true"]');
    if (!ed) return { ok: false, before: 0 };
    const before = (ed.innerText || "").trim().length;
    ed.focus();
    if (before === 0) return { ok: true, before: 0, cleared: false };
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(ed);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand("delete", false, null);
    return { ok: true, before, cleared: true };
  });
  await page.waitForTimeout(300);

  const insert = async (t) =>
    page.evaluate((value) => {
      const ed = document.querySelector('[contenteditable="true"]');
      if (!ed) return { ok: false, len: 0 };
      ed.focus();
      // 插入前再次确保光标在末尾（内容为空时即在开头）
      const sel = window.getSelection();
      if (!sel.rangeCount) {
        const r = document.createRange();
        r.selectNodeContents(ed);
        r.collapse(false);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      const ok = document.execCommand("insertText", false, value);
      return { ok, len: (ed.innerText || "").length };
    }, t);

  const first = await insert(text);
  const expected = text.replace(/\s+/g, " ").trim().length;
  if (first.len < expected * 0.9) {
    for (let i = 0; i < 3; i++) {
      const cur = await page.evaluate(() => (document.querySelector('[contenteditable="true"]')?.innerText || "").length);
      if (cur >= expected * 0.9) break;
      await insert(text.slice(cur));
      await page.waitForTimeout(400);
    }
  }
  await page.waitForTimeout(400);
  const finalText = await page.evaluate(() => document.querySelector('[contenteditable="true"]')?.innerText || "");
  const finalLen = finalText.trim().length;
  // 校验：注入后的内容应约等于目标文本（防止把旧内容一起发出去）
  const matches = Math.abs(finalLen - expected) <= Math.max(5, expected * 0.1);
  return {
    ok: finalLen > 0 && matches,
    valueLength: finalLen,
    expected,
    cleared: cleared.cleared,
    clearedLength: cleared.before ?? 0,
    preview: finalText.trim().slice(0, 60),
    reason: matches ? undefined : "INJECT_MISMATCH",
  };
}

export async function sendPrompt(page) {
  await page.locator('[contenteditable="true"]').first().press("Enter");
  await page.waitForTimeout(2000);
  // 兜底：找发送按钮（aria 可能是「发送」或图标按钮）
  const box = await page.evaluate(() => {
    const btns = [...document.querySelectorAll("button")];
    const hit = btns.find((b) => /发送|send/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`));
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    if (r.width < 8) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  });
  if (box) {
    const stillHasText = await page.evaluate(() => (document.querySelector('[contenteditable="true"]')?.innerText || "").trim().length > 0);
    if (stillHasText) {
      await page.mouse.click(box.x, box.y);
      await page.waitForTimeout(1500);
      return { ok: true, method: "button" };
    }
  }
  return { ok: true, method: "enter" };
}

/* ---------------------------------- 模型选择器 -------------------------------- */

/** 读取当前模型：按钮文案形如「豆包 快速」 */
export async function readModel(page) {
  return page.evaluate(() => {
    // 模型按钮在输入框区域，文案以「豆包」开头
    const cands = [...document.querySelectorAll("button,div[role=button],[class*='cursor-pointer']")]
      .filter((e) => {
        const t = (e.innerText || "").trim();
        if (!t || t.length > 24) return false;
        if (!t.startsWith("豆包")) return false;
        const r = e.getBoundingClientRect();
        // 在页面下半部分（输入区）
        return r.width > 20 && r.height > 10;
      })
      .map((e) => {
        const t = (e.innerText || "").trim();
        const r = e.getBoundingClientRect();
        return {
          text: t,
          aria: e.getAttribute("aria-label"),
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        };
      });
    // 取最靠下的那个（输入区里的）
    const btn = cands.sort((a, b) => b.y - a.y)[0] ?? null;
    if (!btn) return null;
    // 「豆包 2.1 Turbo 专家」→ 模式名 = 去掉「豆包」前缀（保留完整名称，如 "2.1 Turbo 专家"）
    const mode = btn.text.replace(/^豆包\s*/, "").trim() || null;
    return { raw: btn.text, current: mode, x: btn.x, y: btn.y };
  });
}

/** 切换模型：点开 → 选目标项 */
export async function setModel(page, target) {
  const before = await readModel(page);
  if (!before) return { ok: false, reason: "SITE_CHANGED", message: "未找到模型选择器" };
  if (target === null || target === undefined) return { ok: true, before: before.current, after: before.current, clicked: false };
  if (before.current && before.current.includes(String(target))) {
    return { ok: true, before: before.current, after: before.current, clicked: false };
  }

  await page.mouse.click(before.x, before.y);
  await page.waitForTimeout(1500);

  const options = await page.evaluate(() =>
    [...document.querySelectorAll('[role="menuitem"], [role="option"], [class*="menu"] [class*="item"], button')]
      .map((e) => {
        const r = e.getBoundingClientRect();
        return {
          text: (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 50),
          visible: r.width > 10 && r.height > 10,
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
        };
      })
      .filter((o) => o.visible && o.text.length > 0)
  );

  const hit = options.find((o) => o.text.toLowerCase().includes(String(target).toLowerCase()));
  if (!hit) {
    await page.keyboard.press("Escape");
    return { ok: false, reason: "INVALID_ARGUMENTS", message: `模型列表里没有「${target}」`, options: options.map((o) => o.text).slice(0, 20) };
  }
  await page.mouse.click(hit.x, hit.y);
  await page.waitForTimeout(2000);
  const after = await readModel(page);
  return { ok: true, before: before.current, after: after?.current ?? null, clicked: true };
}

/* ---------------------------------- 完成判定 --------------------------------- */

/**
 * 监听生成请求。
 * 豆包用 SSE 长连接推送（mcs.doubao.com 是埋点，生成走 chat 相关端点）。
 * 由于端点名可能变化，这里用更宽的关键词匹配，并辅以文本稳定作为主判据。
 */
export function watchCompletion(page, patterns = [/chat\/completion/i, /chat\/message/i, /sse/i, /\/api\/chat/i, /generate/i]) {
  const state = { seen: false, done: false, failed: false, endpoint: null };
  const match = (req) => {
    const url = req.url();
    if (/monitor|log|analytic|track|mcs\.|abtest|settings/i.test(url)) return false;
    return patterns.some((p) => p.test(url));
  };
  const onRequest = (req) => {
    if (match(req)) {
      state.seen = true;
      state.endpoint = req.url().slice(0, 150);
    }
  };
  const onFinished = (req) => match(req) && (state.done = true);
  const onFailed = (req) => match(req) && (state.failed = true);
  page.on("request", onRequest);
  page.on("requestfinished", onFinished);
  page.on("requestfailed", onFailed);
  return {
    get state() {
      return { ...state };
    },
    reset() {
      state.seen = false;
      state.done = false;
      state.failed = false;
    },
    dispose() {
      page.off("request", onRequest);
      page.off("requestfinished", onFinished);
      page.off("requestfailed", onFailed);
    },
  };
}

/** 回答区状态 */
export const EXTRACT_FN = () => {
  const visible = (el) => !!el && el.getClientRects().length > 0;

  /** DOM 文本收集：行内不换行、上标压紧、块级换行 */
  const BLOCK = new Set(["p", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "blockquote", "section", "article", "table", "ul", "ol"]);
  const collectText = (node) => {
    let out = "";
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue;
        continue;
      }
      if (child.nodeType !== 1) continue;
      const el = child;
      const tag = el.tagName.toLowerCase();
      if (tag === "script" || tag === "style") continue;
      if (tag === "sup" || tag === "sub") {
        out += collectText(el);
        continue;
      }
      if (tag === "br") {
        out += "\n";
        continue;
      }
      if (tag === "tr") out += "\n";
      if (tag === "td" || tag === "th") out += " | ";
      const isBlock = BLOCK.has(tag);
      if (isBlock) out += "\n";
      out += collectText(el);
      if (isBlock) out += "\n";
    }
    return out;
  };
  const clean = (s) =>
    (s || "").replace(/\r/g, "").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();

  // 回答容器：豆包的类名形如 `inner-item-<hash>`（哈希会变，用前缀匹配）。
  // 真机实测（2026-09）：用户提问与模型回答各占一个 inner-item。
  // 区分特征（按可靠性排序）：
  //   ① 模型回答内含 div.grid（正文网格），用户提问没有 —— 最可靠
  //   ② 模型回答含推荐追问 (suggest-message-list) 或操作栏 (message-action-bar)
  //   ③ 用户提问靠右对齐
  const items = [...document.querySelectorAll('[class*="inner-item"]')].filter(visible);
  let scope = null;
  if (items.length) {
    const isAnswer = (el) =>
      el.querySelectorAll("div.grid").length > 0 ||
      el.querySelectorAll('[class*="suggest-message"], [class*="message-action-bar"]').length > 0;
    const answers = items.filter(isAnswer);
    if (answers.length) {
      scope = answers[answers.length - 1];
    } else {
      // 兜底：取靠左对齐的最后一个
      const mid = window.innerWidth / 2;
      const leftAligned = items.filter((el) => el.getBoundingClientRect().left < mid);
      const pool = leftAligned.length ? leftAligned : items;
      scope = pool[pool.length - 1];
    }
  }

  // 兜底：找 markdown 容器
  if (!scope) {
    const md = [...document.querySelectorAll('[class*="markdown"], [class*="prose"]')].filter(visible);
    if (md.length) scope = md[md.length - 1];
  }
  // 再兜底：消息区里最后一个文本块
  if (!scope) {
    const blocks = [...document.querySelectorAll("p, pre, ul, ol")].filter(visible);
    if (blocks.length) {
      let node = blocks[blocks.length - 1];
      let best = node;
      for (let i = 0; i < 8 && node.parentElement; i++) {
        node = node.parentElement;
        if ((node.innerText || "").length > 4000) break;
        best = node;
      }
      scope = best;
    }
  }

  // 豆包的 inner-item 容器把「正文 + 操作栏 + 时间戳 + 推荐追问」放在一起。
  // 结构（真机实测 2026-09）：
  //   inner-item > div(flex-row) > div(flex-col)
  //     ├── div(grid)                     ← 正文
  //     ├── div(message-action-bar)+time  ← 操作栏与时间戳
  //     └── div.select-none > .suggest-message-list-wrapper  ← 推荐追问
  let text = "";
  if (scope) {
    const clone = scope.cloneNode(true);
    // ① 推荐追问：有明确类名，直接删
    for (const el of [
      ...clone.querySelectorAll('[class*="suggest-message-list"], [class*="suggest-list-item"], [class*="suggest-message"]'),
    ]) {
      el.remove();
    }
    // ② 操作栏（复制/朗读/赞/踩/重新生成…）与时间戳
    for (const el of [...clone.querySelectorAll('[class*="message-action-bar"], [class*="message-action-button"], time')]) {
      el.remove();
    }
    // ③ 残余噪声叶子节点
    const NOISE = /^(复制|朗读|赞|踩|重新生成|分享|更多|溯源|引用|下载|编辑)$/;
    for (const el of [...clone.querySelectorAll("div, span, p")]) {
      if (el.children.length > 0) continue;
      const t = (el.textContent || "").trim();
      if (!t) continue;
      if (NOISE.test(t)) el.remove();
      else if (/^AI\s*生成可能有误/.test(t)) el.remove();
      else if (/^今天\s+\d{1,2}:\d{2}$/.test(t)) el.remove();
    }
    text = clean(collectText(clone));
  }

  const body = document.body ? document.body.innerText || "" : "";
  return {
    text,
    textLen: text.length,
    answerCount: items.length,
    // 生成中标记（豆包用「停止」按钮）
    stopVisible: [...document.querySelectorAll("button,div[role=button]")].some(
      (el) => /^(停止|停止生成|停止回答)$/.test((el.innerText || "").trim()) && visible(el)
    ),
    url: location.href,
    // 会话 ID
    convId: (location.pathname.match(/\/chat\/(\d+)/) ?? [])[1] ?? null,
  };
};

export async function snapshotMarkers(page) {
  try {
    return await page.evaluate(EXTRACT_FN);
  } catch {
    return { text: "", textLen: 0, answerCount: 0, convId: null };
  }
}

/**
 * 等本次回答完成。
 *
 * 豆包是流式输出，与 DeepSeek 类似（不是 Gemini 那种"一次性返回+打字机"）。
 * 判据：
 *   1. 文本连续 N 次采样不变（主判据）
 *   2. 未检测到停止按钮
 *   3. 若识别到生成请求，则要求其已结束
 */
/**
 * 等本次回答完成。
 *
 * 豆包是流式输出，但**生成类任务有两阶段**：
 *   1. 先回一段文字（"正在生成图片" / "请先确认以下参数"）
 *   2. 稍后才把产物（图片/视频）渲染进 DOM
 * 所以文本稳定后，若发现它在说"生成中/已生成"而产物还没出现，
 * 必须继续等产物，不能直接收工（实测踩过）。
 */
export async function waitForAnswer(page, { timeoutMs = 300000, pollMs = 2000, stableSamples = 3, completion = null, expectArtifact = false, artifactWaitMs = 180000, onPoll } = {}) {
  const started = Date.now();
  let last = "";
  let stable = 0;
  let sawText = false;
  let lastState = null;
  let artifactDeadline = null;

  while (Date.now() - started < timeoutMs) {
    lastState = await page.evaluate(EXTRACT_FN).catch(() => null);
    const cs = completion?.state ?? { seen: false, done: false, failed: false };
    const netIdle = !cs.seen || cs.done || cs.failed;

    if (lastState) {
      const t = lastState.text ?? "";
      if (t.length > 0) sawText = true;
      if (sawText && t === last && t.length > 0) stable++;
      else stable = 0;
      last = t;

      const artifacts = await page
        .evaluate(() => ({
          videos: document.querySelectorAll("video").length,
          images: [...document.querySelectorAll("img")].filter(
            (i) => i.naturalWidth >= 512 && !i.src.startsWith("data:")
          ).length,
        }))
        .catch(() => ({ videos: 0, images: 0 }));

      const textWantsArtifact = /正在生成|生成中|请稍候|马上|正在为你生成/.test(t);
      const artifactPresent = artifacts.videos > 0 || artifacts.images > 0;

      onPoll?.({
        len: t.length,
        stable,
        net: `${cs.seen ? "seen" : "-"}/${cs.done ? "done" : cs.failed ? "failed" : "-"}`,
        artifacts: `${artifacts.videos}v/${artifacts.images}i`,
      });

      if (sawText && t.length > 0 && stable >= stableSamples && !lastState.stopVisible && netIdle) {
        const wantsArtifact = expectArtifact || textWantsArtifact || /已生成|生成完成/.test(t);
        if (wantsArtifact && !artifactPresent) {
          if (artifactDeadline === null) artifactDeadline = Date.now() + artifactWaitMs;
          if (Date.now() < artifactDeadline) {
            await page.waitForTimeout(pollMs);
            continue;
          }
        }
        return { ok: true, ...lastState, artifacts, elapsedMs: Date.now() - started };
      }
    }
    await page.waitForTimeout(pollMs);
  }
  return { ok: false, reason: "STREAM_STALLED", ...(lastState ?? {}), elapsedMs: Date.now() - started };
}

/* --------------------------------- 会话管理 --------------------------------- */

/** 新建对话 */
export async function newThread(page) {
  const clicked = await page.evaluate(() => {
    const hit = [...document.querySelectorAll("button,a,div[role=button]")].find((e) => {
      const t = (e.innerText || "").trim();
      return t === "新对话" || t === "新建对话";
    });
    if (!hit) return { ok: false };
    hit.click();
    return { ok: true };
  });
  if (clicked.ok) await page.waitForTimeout(2500);
  return clicked;
}

/** 从侧栏进入指定会话（按标题关键字） */
export async function openConversation(page, keyword) {
  const res = await page.evaluate((kw) => {
    const links = [...document.querySelectorAll('a[class*="conversation-item"], a[href*="/chat/"]')];
    const hit = kw ? links.find((a) => (a.innerText || "").includes(kw)) : links[0];
    if (!hit) return { ok: false, titles: links.map((a) => (a.innerText || "").trim()).slice(0, 10) };
    hit.click();
    return { ok: true, href: hit.getAttribute("href"), title: (hit.innerText || "").trim().slice(0, 50) };
  }, keyword ?? "");
  if (res.ok) await page.waitForTimeout(6000);
  return res;
}

/** 读取能力栏（对话 / 视频生成 / 图像生成 / 帮我写作 / 音乐生成 / AI 播客 / 录音转写） */
export async function readCapabilities(page) {
  return page.evaluate(() => {
    const known = ["对话", "视频生成", "图像生成", "帮我写作", "音乐生成", "AI 播客", "录音转写", "更多"];
    const hits = [...document.querySelectorAll("button,div[role=button],div[class*='cursor-pointer']")]
      .map((e) => (e.innerText || "").trim())
      .filter((t) => known.includes(t));
    return [...new Set(hits)];
  });
}

/** 当前选中的能力（豆包用高亮/勾选标记） */
export async function readActiveCapability(page) {
  return page.evaluate(() => {
    const known = ["对话", "视频生成", "图像生成", "帮我写作", "音乐生成", "AI 播客", "录音转写"];
    // 已选中的能力通常是「标签」形态（带 × 号），或带高亮类
    const tagged = [...document.querySelectorAll("*")]
      .filter((e) => {
        const t = (e.innerText || "").trim();
        return known.some((k) => t === `${k} ×` || t === `${k}×` || t.startsWith(`${k}\n×`));
      })
      .map((e) => (e.innerText || "").trim().replace(/\s*×\s*$/, ""));
    if (tagged.length) return tagged[tagged.length - 1];
    // 兜底：高亮类
    const active = [...document.querySelectorAll("*")]
      .filter((e) => {
        const cls = typeof e.className === "string" ? e.className : "";
        const t = (e.innerText || "").trim();
        return known.includes(t) && /active|selected|primary|bg-\[|bg-primary/i.test(cls);
      })
      .map((e) => (e.innerText || "").trim());
    return active[active.length - 1] ?? null;
  });
}

/**
 * 切换能力（图像生成 / 视频生成 / 帮我写作 / 音乐生成 / AI 播客 / 录音转写）。
 *
 * ⚠️ 关键：不切能力的话，豆包对「生成图片」之类的请求只会**回一段文字描述**，
 *    页面上不会真正渲染图片/视频（实测踩过）。
 * 切换后输入框区域会出现该能力的参数面板（如视频：模型 + 时长）。
 */
export async function setCapability(page, capability) {
  if (!capability) return { ok: true, switched: false, active: await readActiveCapability(page) };

  const before = await readActiveCapability(page);
  if (before === capability) return { ok: true, switched: false, before, after: before };

  const clicked = await page.evaluate((label) => {
    const hits = [...document.querySelectorAll("button,[role=button],[class*='cursor-pointer'],div,span")]
      .filter((e) => (e.innerText || "").trim() === label && e.getBoundingClientRect().width > 8);
    if (!hits.length) return { ok: false, reason: "NOT_FOUND" };
    // 取最内层元素，再向上找可点击祖先
    const el = hits[hits.length - 1];
    const target = el.closest("button,[role=button],[class*='cursor-pointer']") ?? el;
    target.click();
    return { ok: true };
  }, capability);

  if (!clicked.ok) return { ok: false, reason: "NOT_FOUND", message: `能力栏里没有「${capability}」` };
  await page.waitForTimeout(3000);
  const after = await readActiveCapability(page);
  return { ok: true, switched: true, before, after: after ?? capability };
}

/* ------------------------------- 参数确认流程 ------------------------------- */

/** 待确认关键词（豆包生成视频/图片前会列参数要求确认） */
const CONFIRM_PATTERNS = [
  /请.{0,8}确认/,
  /确认后.{0,8}(开始|生成)/,
  /是否确认/,
  /参数确认/,
  /请确认以下/,
  /确认以下参数/,
];

/** 读取最后一条模型回答的文本 */
export async function readLastAnswer(page) {
  return page.evaluate(() => {
    const visible = (el) => !!el && el.getClientRects().length > 0;
    const items = [...document.querySelectorAll('[class*="inner-item"]')].filter(visible);
    const isAnswer = (el) =>
      el.querySelectorAll("div.grid").length > 0 ||
      el.querySelectorAll('[class*="message-action-bar"], [class*="suggest-message"]').length > 0;
    const answers = items.filter(isAnswer);
    const scope = answers[answers.length - 1];
    return scope ? (scope.innerText || "").replace(/\s+/g, " ").trim() : "";
  });
}

/** 判断最后一条回答是否在等确认 */
export async function isAwaitingConfirmation(page) {
  const text = await readLastAnswer(page);
  return { awaiting: CONFIRM_PATTERNS.some((re) => re.test(text)), text };
}

/** 读取生成耗时预告（豆包会说「预计等待 10 分钟」） */
export async function readEta(page) {
  const text = await readLastAnswer(page);
  const m = text.match(/预计.{0,6}等待\s*(\d+)\s*(秒|分钟)/);
  if (!m) return null;
  const n = Number(m[1]);
  return { raw: m[0], ms: m[2] === "分钟" ? n * 60000 : n * 1000 };
}

/* ------------------------------- 产物提取与下载 ------------------------------- */

/**
 * 产物 URL 的域名特征。
 * 都是字节系 CDN，且**域名会轮换**（实测见过三种）：
 *   图片: p3-flow-imagex-sign.byteimg.com
 *   视频: v9-default.douyin.com / v26-vdl.doubao.com
 * 所以用宽匹配。
 */
const ARTIFACT_HOST_RE = /byteimg\.com|douyin\.com|doubao\.com|doubaocdn|byteacctimg|flow-imagex|zijieapi|snssdk|bytecdn/i;

/**
 * 从页面提取产物 URL。
 * - 图片：`<img src="...byteimg.com...">`
 * - 视频：`<video src="...douyin.com...">`
 * ⚠️ 都是**签名链接会过期**，必须当次提取当次下载，不能缓存 URL 稍后再取。
 */
export async function extractArtifacts(page, { autoScroll = true } = {}) {
  if (autoScroll) {
    // ⚠️ 豆包的视频播放器是**点击后才初始化**的：
    //   <div class="video-player-NmhH16"></div> 初始是空的，<video> 不存在。
    //   必须点一下播放按钮，播放器才会挂载 <video> 并暴露 src。
    //   （另有封面图 <img class="cover-..."> 指向 aka.doubaocdn.com）
    await page
      .evaluate(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        // 找所有还没初始化的视频块（有 video-player 容器但没有 video 元素）
        const wrappers = [...document.querySelectorAll('[class*="video-player-wrapper"]')];
        for (const w of wrappers) {
          if (w.querySelector("video")) continue;
          // 优先点播放按钮，其次点容器本身
          const playBtn =
            w.parentElement?.querySelector('[class*="play-icon"], [class*="play-button"]') ??
            w.parentElement?.querySelector("button") ??
            w;
          try {
            playBtn.click();
            await sleep(1200);
          } catch {
            /* ignore */
          }
        }
        // 若仍无 video，再尝试滚动触发
        if (!document.querySelector("video")) {
          for (let i = 0; i < 10; i++) {
            const sc = [...document.querySelectorAll("div")].find(
              (el) => el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 250 && /scroller|scroll-area|flow-scrollbar/i.test(String(el.className))
            );
            if (sc) sc.scrollTop = sc.scrollHeight;
            else window.scrollBy(0, Math.max(400, window.innerHeight * 0.8));
            await sleep(300);
          }
        }
        await sleep(1000);
      })
      .catch(() => {});
    await page.waitForTimeout(2000);
  }
  return page.evaluate(() => {
    const pickSrc = (v) => v.src || v.currentSrc || v.querySelector?.("source")?.src || "";
    const videos = [...document.querySelectorAll("video")]
      .map((v) => ({
        kind: "video",
        url: pickSrc(v),
        dims: `${v.videoWidth}x${v.videoHeight}`,
        durationSec: Number.isFinite(v.duration) ? Math.round(v.duration * 100) / 100 : null,
        poster: v.poster || null,
        player: (() => {
          const p = v.closest('[class*="xgplayer"], [class*="video-player"]');
          return p ? String(p.className).split(/\s+/)[0] : null;
        })(),
      }))
      .filter((v) => v.url);
    const images = [...document.querySelectorAll("img")]
      .filter((i) => i.naturalWidth >= 512 && !i.src.startsWith("data:"))
      .map((i) => ({ kind: "image", url: i.src, dims: `${i.naturalWidth}x${i.naturalHeight}` }))
      .filter((i) => i.url);
    return { videos, images };
  });
}

/** 过滤出真正的生成产物（排除头像、图标等） */
export function filterArtifacts(artifacts) {
  const isArtifact = (url) => {
    if (!ARTIFACT_HOST_RE.test(url)) return false;
    if (/avatar|user-avatar|\/icon\/|intro\.|static\/image|sparkle/i.test(url)) return false;
    // 封面图（aka.doubaocdn.com/s/xxx 无扩展名）不是产物本体，视频以 <video> 为准
    if (/doubaocdn\.com\/s\//.test(url)) return false;
    return true;
  };
  return {
    videos: artifacts.videos.filter((v) => isArtifact(v.url)),
    images: artifacts.images.filter((i) => isArtifact(i.url)),
  };
}

/**
 * 用 Node 直接下载产物（不经过浏览器 UI）。
 *
 * 为什么不用 UI 的「下载原图」按钮：
 *   - 按钮只在 hover 时渲染，不稳定
 *   - 右键菜单能触发 download 事件，但 Playwright 的 saveAs 有竞态
 *   - 而图片/视频本身是**签名 HTTP URL**，直接请求即可拿到服务器原文件
 */
export async function downloadArtifactsByUrl(urls, outDir, cookieHeader, { referer = "https://www.doubao.com/" } = {}) {
  ensureDir(outDir);
  const saved = [];
  for (const [i, item] of urls.entries()) {
    const url = typeof item === "string" ? item : item.url;
    const kind = typeof item === "string" ? "artifact" : item.kind;
    try {
      const res = await fetch(url, {
        headers: {
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36",
          referer,
          ...(cookieHeader ? { cookie: cookieHeader } : {}),
        },
        signal: AbortSignal.timeout(120000),
      });
      if (!res.ok) {
        saved.push({ ok: false, kind, url: url.slice(0, 100), status: res.status });
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const ct = res.headers.get("content-type") ?? "";
      const ext = ct.includes("mp4")
        ? "mp4"
        : ct.includes("webm")
          ? "webm"
          : ct.includes("png")
            ? "png"
            : ct.includes("jpeg") || ct.includes("jpg")
              ? "jpg"
              : ct.includes("webp")
                ? "webp"
                : "bin";
      const file = path.join(outDir, `doubao-${kind}-${Date.now()}-${i}.${ext}`);
      writeFileSync(file, buf);
      saved.push({ ok: true, kind, file, bytes: buf.length, contentType: ct });
    } catch (error) {
      saved.push({ ok: false, kind, url: url.slice(0, 100), error: String(error).slice(0, 150) });
    }
  }
  return saved;
}
