#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

import { VERSION, dirs, ensureDir, writeJson, readJson, workspaceId, nowIso } from "./src/paths.mjs";
import { log, tailLines } from "./src/logger.mjs";
import { sanitizeOutbound } from "./src/sanitize.mjs";
import { getSession, setSession, appendAudit, saveDebugHtml } from "./src/session.mjs";
import {
  launchBrowser,
  findBrowser,
  depsInstalled,
  depsEntry,
  exportStorageState,
  readLoginCookies,
  openPage,
} from "./src/browser.mjs";
import * as site from "./src/site.mjs";

const { values: flags, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  strict: false,
  options: {
    json: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
    version: { type: "boolean", default: false },
    model: { type: "string" },
    "list-models": { type: "boolean", default: false },
    prompt: { type: "string" },
    "prompt-file": { type: "string" },
    attach: { type: "string" },
    thread: { type: "string" },
    timeout: { type: "string" },
    deep: { type: "boolean", default: false },
    html: { type: "boolean", default: false },
    debug: { type: "boolean", default: false },
    headless: { type: "boolean", default: false },
    capability: { type: "string" },
    "auto-confirm": { type: "boolean", default: true },
    "no-auto-confirm": { type: "boolean", default: false },
    "no-download": { type: "boolean", default: false },
    "allow-sensitive": { type: "boolean", default: false },
    "allow-large": { type: "boolean", default: false },
    "keep-open": { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    lines: { type: "string" },
    force: { type: "boolean", default: false },
    url: { type: "string" },
    title: { type: "string" },
    task: { type: "string" },
    iteration: { type: "string" },
    state: { type: "string" },
    protocol: { type: "string" },
    "protocol-state": { type: "string" },
    "waiting-for": { type: "string" },
    "next-step": { type: "string" },
    goal: { type: "string" },
    "known-issues": { type: "string" },
    "clear-checkpoint": { type: "boolean", default: false },
  },
});

const cmd = String(positionals[0] ?? "help").toLowerCase();
const json = !!flags.json;

function emit(payload, { exitCode = 0 } = {}) {
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else printHuman(payload);
  if (exitCode) process.exitCode = exitCode;
  return payload;
}

function fail(reason, message, extra = {}) {
  const payload = { ok: false, reason, message, ...extra };
  log("error", `${reason}: ${message}`);
  if (json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  else process.stderr.write(`✗ ${reason}: ${message}\n`);
  process.exitCode = 1;
  return payload;
}

function printHuman(payload) {
  if (!payload || typeof payload !== "object" || payload.ok === false) return;
  if (typeof payload.text === "string") {
    process.stdout.write(`${payload.text}\n`);
    const m = payload.modes ?? {};
    process.stdout.write(
      `\n来源：doubao.com · 模型：${m.model ?? "-"} · request: ${payload.requestId ?? "-"} · 截断：${payload.truncated ? "是" : "否"}\n`
    );
    if (payload.files?.length) {
      process.stdout.write(`产物：\n${payload.files.map((f) => `  ${f.file} (${f.bytes} bytes)`).join("\n")}\n`);
    }
    return;
  }
  for (const [k, v] of Object.entries(payload)) {
    if (k === "ok") continue;
    process.stdout.write(`✓ ${k}: ${typeof v === "object" ? JSON.stringify(v) : v}\n`);
  }
}

function newRequestId() {
  return `dbb_${crypto.randomBytes(2).toString("hex")}`;
}

/* ------------------------------ [DBB] 协议 ------------------------------ */

const PROTOCOL_STATES = ["INIT", "PLAN", "EXECUTING", "EXECUTED", "REVIEW", "HANDOFF"];
const CHECKPOINT_FOR_REPLY = {
  PLAN: { protocolState: "PLAN_RECEIVED", waitingFor: "none" },
  REVIEW: { protocolState: "EXECUTED_SENT", waitingFor: "BRAIN_REVIEW" },
  DONE: { protocolState: "DONE", waitingFor: "none" },
  BLOCKED: { protocolState: "BLOCKED", waitingFor: "USER" },
};

export function buildProtocolMessage(state, body, { taskId, iteration }) {
  return `[DBB]\nSTATE: ${state}\nTASK_ID: ${taskId}\nITERATION: ${iteration}\n\n${body}`;
}

export function parseProtocolReply(text) {
  if (!text) return null;
  const state = text.match(/STATE:\s*([A-Z_]+)/);
  if (!state) return null;
  const task = text.match(/TASK_ID:\s*(\S+)/);
  const iter = text.match(/ITERATION:\s*(\d+)/);
  return { state: state[1], taskId: task ? task[1] : null, iteration: iter ? Number(iter[1]) : null };
}

/* ---------------------------------- setup --------------------------------- */

function installDeps() {
  const d = dirs();
  ensureDir(d.deps);
  writeJson(path.join(d.deps, "package.json"), {
    name: "dbb-deps",
    private: true,
    dependencies: { "playwright-core": "^1.40.0" },
  });
  const args = ["install", "--prefix", d.deps, "--no-audit", "--no-fund", "--loglevel", "error"];
  const npmCli = path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const res = fs.existsSync(npmCli)
    ? spawnSync(process.execPath, [npmCli, ...args], { stdio: "inherit", windowsHide: true })
    : spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, { stdio: "inherit", windowsHide: true, shell: process.platform === "win32" });
  return res.status === 0;
}

/**
 * 登录流程。
 * 判定必须用 cookie（豆包 未登录时会隐藏「登录」按钮，看界面会误判）。
 */
async function waitLoginFlow({ timeoutMs }) {
  const ctx = await launchBrowser({ headless: false });
  try {
    const page = await openPage(ctx);
    await site.gotoSite(page);
    process.stderr.write("浏览器已打开。请完成 Google 账号登录（含人机验证，需你本人操作）。\n");

    const started = Date.now();
    let lastBeat = 0;
    let ck = await readLoginCookies(ctx);
    let st = await site.pageState(page).catch(() => null);

    while (Date.now() - started < timeoutMs) {
      if (ck.loggedIn && st?.hasEditor) break;
      await page.waitForTimeout(3000);
      ck = await readLoginCookies(ctx);
      st = await site.pageState(page).catch(() => null);
      const sec = Math.round((Date.now() - started) / 1000);
      if (sec - lastBeat >= 30) {
        lastBeat = sec;
        process.stderr.write(`  …等待登录 ${sec}s（cookie ${ck.total} 个，登录 cookie ${ck.loginCookies.length} 个）\n`);
      }
    }

    const d = dirs();
    const prefs = readJson(d.prefs) ?? {};
    if (!ck.loggedIn) {
      ensureDir(d.debug);
      const shot = path.join(d.debug, `login-failed-${Date.now()}.png`);
      await page.screenshot({ path: shot }).catch(() => {});
      writeJson(d.prefs, { ...prefs, lastLoginCheckAt: nowIso() });
      return { ok: false, reason: st?.challenge ? "HUMAN_VERIFICATION_REQUIRED" : "LOGIN_REQUIRED", state: st, screenshot: shot };
    }

    // 登录成功：导出 storage_state（session cookie 的备份）
    const exported = await exportStorageState(ctx, d.storageState);
    writeJson(d.prefs, { ...prefs, lastLoginAt: nowIso() });
    return { ok: true, loginState: "logged-in", url: st?.url ?? site.SITE_URL, loginCookies: ck.loginCookies.length, storageState: exported };
  } finally {
    await ctx.close(); // 优雅关闭：确保 cookie 落盘
  }
}

async function cmdSetup() {
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  if (nodeMajor < 20) return fail("DEPENDENCY_MISSING", `需要 Node ≥ 20，当前 ${process.version}`);

  if (!depsInstalled()) {
    process.stderr.write("安装依赖（playwright-core）到状态目录…\n");
    if (!installDeps() || !depsInstalled()) return fail("DEPENDENCY_MISSING", `依赖安装失败（目标：${depsEntry()}）`);
  }
  const br = findBrowser();
  if (!br) return fail("DEPENDENCY_MISSING", "未找到系统 Chrome / Edge；请安装其一后重试。");

  const res = await waitLoginFlow({ timeoutMs: Number(flags.timeout ?? 1800000) });
  if (!res.ok) return fail(res.reason, "等待登录超时，请重试。", res);
  return emit({ ok: true, ...res, browser: br.executablePath ?? br.channel, stateDir: dirs().root });
}

async function cmdLogin() {
  const res = await waitLoginFlow({ timeoutMs: Number(flags.timeout ?? 1800000) });
  if (!res.ok) return fail(res.reason, "登录未完成，请重试。", res);
  return emit({ ok: true, ...res });
}

async function cmdLogout() {
  const d = dirs();
  for (const target of [d.profile, d.storageState]) {
    if (!fs.existsSync(target)) continue;
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 3 });
    } catch (error) {
      return fail("LOCKED", `清除失败（可能有浏览器仍在运行）：${error.message}`);
    }
  }
  return emit({ ok: true, loggedOut: true, cleared: [d.profile, d.storageState] });
}

/* --------------------------------- doctor --------------------------------- */

async function cmdDoctor() {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node", ok: nodeMajor >= 20, detail: process.version });
  checks.push({ name: "deps", ok: depsInstalled(), detail: depsInstalled() ? dirs().deps : "未安装（运行 dbb setup）" });

  const br = findBrowser();
  checks.push({ name: "browser", ok: !!br, detail: br ? br.executablePath ?? `channel=${br.channel}` : "未找到 Chrome / Edge" });

  let stateWritable = true;
  try {
    ensureDir(dirs().root);
    fs.accessSync(dirs().root, fs.constants.W_OK);
  } catch {
    stateWritable = false;
  }
  checks.push({ name: "stateDir", ok: stateWritable, detail: dirs().root });

  let netOk = false;
  let netDetail = "";
  try {
    const res = await fetch("https://doubao.com/app", {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/151.0.0.0 Safari/537.36" },
      signal: AbortSignal.timeout(15000),
    });
    netOk = res.status > 0;
    netDetail = `HTTP ${res.status}`;
  } catch (error) {
    // Node 直连 Google 可能因 TLS/代理失败，但系统浏览器通常可用 —— 不据此判死
    netDetail = `${error.message}（Node 直连失败；浏览器可能仍可用）`;
    netOk = true;
  }
  checks.push({ name: "network", ok: netOk, detail: netDetail });

  let deep = null;
  if (flags.deep) {
    if (!depsInstalled() || !br) {
      deep = { skipped: true, reason: "DEPENDENCY_MISSING" };
    } else {
      const ctx = await launchBrowser({ headless: !!flags.headless });
      try {
        const page = await openPage(ctx);
        await site.gotoSite(page);
        const st = await site.pageState(page);
        const cookies = await readLoginCookies(ctx);
        const model = await site.readModel(page);
        deep = { state: st, cookies: { total: cookies.total, login: cookies.loginCookies }, model };
        ensureDir(dirs().debug);
        const shot = path.join(dirs().debug, `doctor-${Date.now()}.png`);
        await page.screenshot({ path: shot }).catch(() => {});
        deep.screenshot = shot;
        if (flags.html) deep.htmlFile = saveDebugHtml(await page.content(), "doctor");
      } finally {
        await ctx.close();
      }
    }
  }

  const cookieCheck = deep?.cookies ? { name: "login", ok: deep.cookies.login.length > 0, detail: deep.cookies.login.join(", ") || "无登录 cookie" } : null;
  if (cookieCheck) checks.push(cookieCheck);

  let ok = checks.every((c) => c.ok);
  let reason;
  if (!ok) {
    const firstBad = checks.find((c) => !c.ok)?.name;
    reason = ["deps", "browser"].includes(firstBad) ? "DEPENDENCY_MISSING" : firstBad === "login" ? "LOGIN_REQUIRED" : "SEND_FAILED";
  }
  if (deep && !deep.skipped) {
    if (deep.state.challenge) {
      ok = false;
      reason = "HUMAN_VERIFICATION_REQUIRED";
    } else if (deep.state.rateLimited) {
      ok = false;
      reason = "RATE_LIMITED";
    } else if (!deep.state.hasEditor) {
      ok = false;
      reason = "COMPOSER_NOT_FOUND";
    } else if (deep.cookies && deep.cookies.login.length === 0) {
      ok = false;
      reason = "LOGIN_REQUIRED";
    } else if (!deep.model) {
      ok = false;
      reason = "SITE_CHANGED";
    }
  }
  return emit({ ok, checks, reason, deep }, { exitCode: ok ? 0 : 1 });
}

/* ----------------------------------- ask ---------------------------------- */

async function cmdAsk() {
  const wsid = workspaceId();
  const session = getSession(wsid);

  let promptText = flags.prompt ?? null;
  if (!promptText && flags["prompt-file"]) {
    try {
      promptText = fs.readFileSync(flags["prompt-file"], "utf8");
    } catch (error) {
      return fail("INVALID_ARGUMENTS", `读不到 --prompt-file：${error.message}`);
    }
  }
  if (!promptText) return fail("INVALID_ARGUMENTS", "缺少 --prompt 或 --prompt-file");

  // 协议封装
  let protocolState = null;
  let taskId = flags.task !== undefined ? String(flags.task) : session.taskId ?? null;
  let iteration = flags.iteration !== undefined ? Number(flags.iteration) : Number(session.iteration) || 0;
  if (flags.protocol !== undefined) {
    if (flags.protocol === true) return fail("INVALID_ARGUMENTS", `--protocol 需要值：${PROTOCOL_STATES.join(" | ")}`);
    protocolState = String(flags.protocol).toUpperCase();
    if (!PROTOCOL_STATES.includes(protocolState)) return fail("INVALID_ARGUMENTS", `--protocol 只接受 ${PROTOCOL_STATES.join(" | ")}`);
    if (!taskId) taskId = newRequestId();
  }

  const gate = sanitizeOutbound(
    protocolState ? buildProtocolMessage(protocolState, promptText, { taskId, iteration }) : promptText,
    { allowSensitive: !!flags["allow-sensitive"], allowLarge: !!flags["allow-large"] }
  );
  if (!gate.ok) return fail(gate.reason, gate.message);
  const subject = gate.text;

  const threadArg = flags.thread === true ? "new" : flags.thread ?? null;
  let targetUrl = site.SITE_URL;
  if (threadArg && threadArg !== "new" && /^https?:/.test(threadArg)) targetUrl = threadArg;
  else if (!threadArg && session.threadUrl) targetUrl = session.threadUrl;

  const requestId = newRequestId();
  const startedAt = Date.now();
  const timeoutMs = Number(flags.timeout ?? 300000);

  let ctx;
  try {
    ctx = await launchBrowser({ headless: !!flags.headless });
  } catch (error) {
    return fail(error.code ?? "DEPENDENCY_MISSING", error.message);
  }

  const downloadsDir = ensureDir(path.join(dirs().downloads, wsid));

  try {
    const page = await openPage(ctx);
    const completion = site.watchCompletion(page);

    await site.gotoSite(page, targetUrl);

    let st = await site.pageState(page);
    if (st.challenge) return fail("HUMAN_VERIFICATION_REQUIRED", "页面出现人机验证，请在浏览器里手动完成后重试。", { state: st });
    const ck = await readLoginCookies(ctx);
    if (!ck.loggedIn) return fail("LOGIN_REQUIRED", "需要登录：请运行 dbb login 完成人工登录。", { state: st });
    if (st.rateLimited) return fail("RATE_LIMITED", "豆包 提示请求过于频繁，请稍后再试。", { retryAfterMs: 300000 });

    let threadLost = false;
    if (!st.hasEditor) {
      if (targetUrl !== site.SITE_URL) {
        threadLost = true;
        await site.gotoSite(page, site.SITE_URL);
        st = await site.pageState(page);
      }
      if (!st.hasEditor) return fail("COMPOSER_NOT_FOUND", "页面上找不到输入框（可能改版或登录失效）。", { state: st });
    }

    // --thread new：显式点「新对话」（豆包首页会恢复上次会话，不能只靠 goto）
    if (threadArg === "new") {
      const nt = await site.newThread(page);
      log("info", `新对话: ${JSON.stringify(nt)}`);
      await page.waitForTimeout(2500);
      st = await site.pageState(page);
    }

    // 模型
    const modelBefore = await site.readModel(page);
    let modelRes = { ok: true, before: modelBefore?.current ?? null, after: modelBefore?.current ?? null, clicked: false };
    if (flags.model !== undefined) {
      modelRes = await site.setModel(page, String(flags.model));
      if (!modelRes.ok) {
        return fail(modelRes.reason ?? "SITE_CHANGED", modelRes.message ?? "模型切换失败", { options: modelRes.options });
      }
    }

    // 能力切换（图像生成 / 视频生成 / …）
    // ⚠️ 关键：不切能力，豆包对「生成图片」类请求只会回一段文字描述，
    //    页面上不会真正渲染产物（实测踩过）。
    let capabilityRes = { ok: true, switched: false, active: null, after: null };
    if (flags.capability) {
      capabilityRes = await site.setCapability(page, String(flags.capability));
      if (!capabilityRes.ok) {
        return fail(
          capabilityRes.reason ?? "SITE_CHANGED",
          capabilityRes.message ?? `无法切换到能力「${flags.capability}」`
        );
      }
      log("info", `能力切换: ${JSON.stringify(capabilityRes)}`);
      await page.waitForTimeout(2000);
    } else {
      capabilityRes.active = await site.readActiveCapability(page);
    }

    // 附件上传（豆包 用隐藏 input[type=file]）
    if (flags.attach) {
      const files = String(flags.attach).split(",").map((s) => s.trim()).filter(Boolean);
      for (const f of files) {
        if (!fs.existsSync(f)) return fail("INVALID_ARGUMENTS", `附件不存在：${f}`);
      }
      const input = page.locator('input[type="file"]').first();
      if ((await page.locator('input[type="file"]').count()) === 0) {
        return fail("UPLOAD_REJECTED", "页面上没有文件输入框");
      }
      try {
        await input.setInputFiles(files, { timeout: 60000 });
        await page.waitForTimeout(4000);
      } catch (error) {
        return fail("UPLOAD_REJECTED", `附件上传失败：${error.message}`);
      }
    }

    const injected = await site.injectPrompt(page, subject);
    if (!injected.ok) return fail("SEND_FAILED", `输入注入失败（${injected.valueLength}/${injected.expected} 字符）`);

    const sent = await site.sendPrompt(page);
    if (!sent.ok) return fail(sent.reason, sent.message);

    const GENERATIVE = /图像生成|视频生成|音乐生成|AI 播客|录音转写/;
    const expectArtifact = GENERATIVE.test(String(flags.capability ?? capabilityRes.active ?? ""));

    // 阶段 1：先只等**文字**回复（不等产物）—— 因为豆包可能先要求确认参数，
    //         一味等产物会浪费时间（实测踩过：文本稳定 177 字，脚本还在傻等产物）
    let ans = await site.waitForAnswer(page, {
      timeoutMs: Math.min(timeoutMs, 180000),
      completion,
      expectArtifact: false,
      onPoll: (info) => log("debug", "waitForAnswer poll (stage1/text)", info),
    });

    // 先看回复说了什么（不傻等产物）
    {
      const said = await site.readLastAnswer(page);
      log("info", `豆包回复: ${said.slice(0, 400)}`);
      if (flags.json) process.stderr.write(`  豆包回复: ${said.slice(0, 200)}
`);
    }

    // 阶段 2：豆包生成前会列参数要求确认（视频必现；图片有时）
    // 读它的回复内容，自动回复确认，然后重新等
    let confirmRounds = 0;
    // 关闭自动确认的三种写法都要支持：
    //   --no-auto-confirm
    //   --auto-confirm=false   （parseArgs 对 boolean 类型会解析成字符串 "false"，需显式判断）
    //   --auto-confirm false   （同上，也是字符串）
    const wantConfirm =
      flags["no-auto-confirm"] !== true && flags["auto-confirm"] !== false && String(flags["auto-confirm"]) !== "false";
    while (wantConfirm && confirmRounds < 2) {
      const check = await site.isAwaitingConfirmation(page);
      if (!check.awaiting) break;
      confirmRounds += 1;
      const eta = await site.readEta(page);
      log("info", `豆包要求确认参数（第 ${confirmRounds} 轮）${eta ? `，预计等待 ${eta.raw}` : ""}`);
      if (flags.json) {
        process.stderr.write(`  豆包要求确认参数${eta ? `（${eta.raw}）` : ""}，自动回复「确认」…
`);
      }
      const inj = await site.injectPrompt(page, "确认，开始生成");
      if (!inj.ok) break;
      await page.waitForTimeout(600);
      await page.keyboard.press("Enter");
      // 重新等待（这次是真正的生成）
      completion.reset();
      const waitMs = eta?.ms ? Math.min(timeoutMs, Math.max(timeoutMs, eta.ms + 120000)) : timeoutMs;
      ans = await site.waitForAnswer(page, {
        timeoutMs: waitMs,
        completion,
        onPoll: (info) => log("debug", "waitForAnswer poll (after confirm)", info),
      });
    }
    // 阶段 3：生成类任务 —— 等产物。
    //
    // 豆包有两类行为，都要覆盖：
    //   A. 同步型（图片）：确认后很快在同一轮回复里渲染出图
    //   B. 异步型（视频）：回复「预计等待 N 分钟…生成好后我会主动发送给你」，
    //      然后**过几分钟自己 push 一条新消息**到会话里
    // 所以这里循环：定期提取产物；没有就继续等（同时读它的新回复）。
    if (expectArtifact) {
      const said = await site.readLastAnswer(page);
      const eta = await site.readEta(page);
      const asyncHint = /主动发送|生成好后|稍后发送/.test(said);
      const budget = eta?.ms ? eta.ms + 180000 : asyncHint ? 900000 : 300000;
      log("info", `等产物：${asyncHint ? "异步推送型" : "同步型"}${eta ? `，eta=${eta.raw}` : ""}，预算 ${Math.round(budget / 1000)}s`);

      const deadline = Date.now() + budget;
      let found = null;
      let lastSeenText = said;
      while (Date.now() < deadline) {
        await page.waitForTimeout(8000);
        const raw = await site.extractArtifacts(page);
        const filtered = site.filterArtifacts(raw);
        if (filtered.videos.length || filtered.images.length) {
          found = filtered;
          break;
        }
        // 读有没有新回复（异步推送）
        const nowText = await site.readLastAnswer(page);
        if (nowText && nowText !== lastSeenText) {
          lastSeenText = nowText;
          log("info", `豆包新回复: ${nowText.slice(0, 200)}`);
          if (flags.json) process.stderr.write(`  豆包: ${nowText.slice(0, 120)}
`);
        }
      }
      if (found) {
        log("info", `产物已就绪: ${found.videos.length} 视频 / ${found.images.length} 图片`);
      } else {
        log("warn", "产物等待超时（异步任务可能仍在队列中）");
      }
    }
    completion.dispose();

    if (flags.debug || !ans.ok) {
      const tag = ans.ok ? "ask" : "ask-timeout";
      const file = saveDebugHtml(await page.content(), tag);
      if (!ans.ok) process.stderr.write(`超时取证 HTML：${file}\n`);
      else if (flags.debug) process.stderr.write(`调试 HTML：${file}\n`);
    }

    // 产物提取与下载（图片 byteimg / 视频 douyin CDN）
    // 说明：这些是**签名 URL 会过期**，所以必须当次提取当次下载；不复用旧 URL。
    let files = [];
    let artifactsSeen = { videos: 0, images: 0 };
    if (!flags["no-download"]) {
      const raw = await site.extractArtifacts(page, { autoScroll: false });
      const filtered = site.filterArtifacts(raw);
      artifactsSeen = { videos: filtered.videos.length, images: filtered.images.length };
      if (artifactsSeen.videos || artifactsSeen.images) {
        const cookieHeader = (await ctx.cookies())
          .map((c) => `${c.name}=${c.value}`)
          .join("; ");
        const targets = [
          ...filtered.videos.map((v) => ({ kind: "video", url: v.url, meta: v })),
          ...filtered.images.map((i) => ({ kind: "image", url: i.url, meta: i })),
        ];
        const downloaded = await site.downloadArtifactsByUrl(targets, downloadsDir, cookieHeader);
        files = downloaded.filter((d) => d.ok).map((d) => ({ file: d.file, bytes: d.bytes, kind: d.kind, contentType: d.contentType }));
        const failed = downloaded.filter((d) => !d.ok);
        log("info", `产物下载: ${files.length} 成功, ${failed.length} 失败`);
        if (failed.length) process.stderr.write(`  部分产物下载失败（签名 URL 可能已过期）：${failed.length} 个\n`);
      }
    }

    if (!ans.ok && !ans.text && !files.length) {
      return fail(ans.reason ?? "STREAM_STALLED", "等待回答超时，且没有抓到文本或产物。", { threadUrl: ans.url });
    }

    const threadUrl = ans.url && site.CONV_URL_RE.test(ans.url) ? ans.url : session.threadUrl ?? null;
    const protocolReply = protocolState ? parseProtocolReply(ans.text) : null;
    const patch = { threadUrl, title: session.title ?? null };
    if (protocolState) {
      patch.taskId = taskId;
      patch.iteration = iteration;
      patch.state = protocolReply?.state ?? protocolState;
      const cp = protocolReply ? CHECKPOINT_FOR_REPLY[protocolReply.state] : null;
      if (cp) patch.checkpointPatch = cp;
    } else {
      patch.state = "ANSWERED";
    }
    setSession(patch, wsid);

    appendAudit(
      {
        ts: nowIso(),
        requestId,
        threadUrl,
        model: { requested: flags.model ?? null, before: modelRes.before, after: modelRes.after },
        mode: ans.mode ?? null,
        chars: ans.text?.length ?? 0,
        files: files.map((f) => ({ suggested: f.suggested, bytes: f.bytes })),
        protocol: protocolState ? { sent: protocolState, reply: protocolReply?.state ?? null, taskId, iteration } : null,
        truncated: !ans.ok,
        redactions: gate.redactions,
        elapsedMs: Date.now() - startedAt,
      },
      wsid
    );

    return emit({
      ok: true,
      requestId,
      threadUrl,
      modes: {
        model: modelRes.after,
        requested: flags.model ?? null,
        capability: capabilityRes.after ?? capabilityRes.active ?? null,
        capabilityRequested: flags.capability ?? null,
      },
      text: ans.text ?? "",
      files,
      artifacts: artifactsSeen.videos || artifactsSeen.images ? artifactsSeen : undefined,
      confirmRounds: confirmRounds || undefined,
      mode: ans.mode ?? (files.length ? "artifact" : "chat"),
      truncated: !ans.ok,
      elapsedMs: ans.elapsedMs ?? Date.now() - startedAt,
      threadLost: threadLost || undefined,
      redactions: gate.redactions.length ? gate.redactions : undefined,
      modelSwitch: modelRes.clicked ? { before: modelRes.before, after: modelRes.after } : undefined,
      protocol: protocolState ? { sent: protocolState, taskId, iteration, reply: protocolReply } : undefined,
    });
  } finally {
    if (!flags["keep-open"]) await ctx.close().catch(() => {});
  }
}

/* -------------------------------- thread / session ------------------------------- */

function cmdThread() {
  const sub = String(positionals[1] ?? "status").toLowerCase();
  const wsid = workspaceId();
  const session = getSession(wsid);
  if (sub === "status" || sub === "list") {
    return emit({ ok: true, workspaceId: wsid, threadUrl: session.threadUrl, title: session.title, state: session.state, checkpoint: session.checkpoint });
  }
  if (sub === "use") {
    const url = flags.url ?? positionals[2];
    if (!url) return fail("INVALID_ARGUMENTS", "用法：dbb thread use <url>");
    return emit({ ok: true, ...setSession({ threadUrl: url }, wsid) });
  }
  if (sub === "new") {
    return emit({ ok: true, ...setSession({ threadUrl: null, state: "NEW" }, wsid), note: "下一条 ask 会从首页开新对话" });
  }
  return fail("INVALID_ARGUMENTS", `未知子命令 thread ${sub}`);
}

function cmdSession() {
  const sub = String(positionals[1] ?? "get").toLowerCase();
  const wsid = workspaceId();
  if (sub === "get") return emit({ ok: true, session: getSession(wsid) });
  if (sub !== "set") return fail("INVALID_ARGUMENTS", `未知子命令 session ${sub}`);

  const patch = {};
  const cp = {};
  if (flags.url !== undefined) patch.threadUrl = flags.url;
  if (flags.title !== undefined) patch.title = flags.title;
  if (flags.task !== undefined) patch.taskId = flags.task;
  if (flags.iteration !== undefined) patch.iteration = Number(flags.iteration);
  if (flags.state !== undefined) patch.state = flags.state;
  if (flags["protocol-state"] !== undefined) cp.protocolState = flags["protocol-state"];
  if (flags["waiting-for"] !== undefined) cp.waitingFor = flags["waiting-for"];
  if (flags["next-step"] !== undefined) cp.nextExpectedStep = flags["next-step"];
  if (flags.goal !== undefined) cp.originalGoal = flags.goal;
  if (flags["known-issues"] !== undefined) cp.knownIssues = flags["known-issues"];
  if (Object.keys(cp).length) patch.checkpointPatch = cp;
  if (flags["clear-checkpoint"]) patch.clearCheckpoint = true;
  if (!Object.keys(patch).length) return fail("INVALID_ARGUMENTS", "没有要写入的字段");

  try {
    return emit({ ok: true, ...setSession(patch, wsid) });
  } catch (error) {
    return fail(error.code ?? "INTERNAL_ERROR", error.message);
  }
}

function cmdLogs() {
  const lines = tailLines(Number(flags.lines ?? 50), { verbose: !!flags.verbose });
  if (json) return emit({ ok: true, lines });
  process.stdout.write(`${lines.join("\n")}\n`);
  return { ok: true };
}

function cmdUpdateCheck() {
  const d = dirs();
  const cache = readJson(d.updateCheck) ?? {};
  const today = new Date().toISOString().slice(0, 10);
  if (!flags.force && cache.checkedOn === today) {
    return emit({ ok: true, version: VERSION, checked: false, updateAvailable: cache.updateAvailable ?? false, note: "今日已检查（缓存）" });
  }
  const note = "未配置远端仓库（git remote），无法自动检查更新；更新方式见 references/install.md";
  writeJson(d.updateCheck, { checkedOn: today, updateAvailable: false, note });
  return emit({ ok: true, version: VERSION, checked: true, updateAvailable: false, note });
}

/** 列出可用模型（打开选择器读选项，不做切换） */
async function cmdListModels() {
  let ctx;
  try {
    ctx = await launchBrowser({ headless: !!flags.headless });
  } catch (error) {
    return fail(error.code ?? "DEPENDENCY_MISSING", error.message);
  }
  try {
    const page = await openPage(ctx);
    await site.gotoSite(page);
    const current = await site.readModel(page);
    if (!current) return fail("SITE_CHANGED", "未找到模型选择器");
    await page.mouse.click(current.x, current.y);
    await page.waitForTimeout(2000);
    const options = await page.evaluate(() =>
      [...document.querySelectorAll('[role="menuitem"], [role="option"], [class*="menu"] [class*="item"]')]
        .map((e) => (e.innerText || "").replace(/\s+/g, " ").trim().slice(0, 60))
        .filter(Boolean)
    );
    await page.keyboard.press("Escape");
    // 顺带报告能力栏
    const capabilities = await site.readCapabilities(page);
    return emit({ ok: true, current: current.current, options: [...new Set(options)], capabilities });
  } finally {
    await ctx.close().catch(() => {});
  }
}

function usage() {
  process.stdout.write(`dbb ${VERSION} — doubao-brain 机制层

用法：node <skill-root>/scripts/dbb/cli.mjs <命令> [选项]

命令：
  setup                 首次配置：装依赖 → 打开浏览器 → 人工登录一次
  login / logout        重新登录 / 清除登录态
  doctor [--deep] [--html]   体检（--deep 真机探测页面、cookie 与模型选择器）
  ask --prompt-file f [--capability 图像生成|视频生成|...] [--model 2.1 Turbo]
      [--attach a.png,b.pdf] [--thread new|<url>] [--no-download] [--json]
  list-models           列出可用模型与能力栏
  capabilities          列出能力栏可选值
  thread status|use <url>|new
  session get|set [...]      工作区线程与 checkpoint
  logs [-n 50] [--verbose]
  update-check [--force]

通用：--json 机器可读；--debug 保存页面 HTML；--keep-open 保留浏览器窗口
`);
  return { ok: true };
}

/* --------------------------------- dispatch --------------------------------- */

try {
  if (flags.version) emit({ ok: true, version: VERSION });
  else if (cmd === "setup") await cmdSetup();
  else if (cmd === "login") await cmdLogin();
  else if (cmd === "logout") await cmdLogout();
  else if (cmd === "doctor") await cmdDoctor();
  else if (cmd === "ask") await cmdAsk();
  else if (cmd === "list-models") await cmdListModels();
  else if (cmd === "thread") cmdThread();
  else if (cmd === "session") cmdSession();
  else if (cmd === "logs") cmdLogs();
  else if (cmd === "update-check") cmdUpdateCheck();
  else usage();
} catch (error) {
  fail(error.code ?? "INTERNAL_ERROR", error.message ?? String(error));
}
