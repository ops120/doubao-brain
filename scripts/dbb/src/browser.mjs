import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { dirs, ensureDir, readJson } from "./paths.mjs";
import { log } from "./logger.mjs";

/**
 * 浏览器自适应探测（五层，从最明确到最兜底）：
 *   1. 环境变量覆盖 DBB_BROWSER_PATH
 *   2. 常见安装路径（多厂商 / 多渠道 / 多盘符）
 *   3. PATH 里的可执行名
 *   4. Windows 注册表 App Paths（不写死盘符）
 *   5. 交给 Playwright 的 channel 机制
 */
export function findBrowser() {
  const envPath = process.env.DBB_BROWSER_PATH;
  if (envPath) {
    if (fs.existsSync(envPath)) return { executablePath: envPath, via: "env" };
    log("warn", `DBB_BROWSER_PATH 指向的文件不存在，已忽略：${envPath}`);
  }

  const rel = [
    "Google/Chrome/Application/chrome.exe",
    "Google/Chrome Beta/Application/chrome.exe",
    "Google/Chrome Dev/Application/chrome.exe",
    "Microsoft/Edge/Application/msedge.exe",
    "BraveSoftware/Brave-Browser/Application/brave.exe",
    "Vivaldi/Application/vivaldi.exe",
    "Chromium/Application/chrome.exe",
  ];
  const roots = [
    "C:/Program Files",
    "C:/Program Files (x86)",
    process.env.LOCALAPPDATA?.replace(/\\/g, "/"),
    process.env.PROGRAMFILES?.replace(/\\/g, "/"),
    process.env["PROGRAMFILES(X86)"]?.replace(/\\/g, "/"),
  ].filter(Boolean);

  const candidates = {
    win32: roots.flatMap((r) => rel.map((x) => `${r}/${x}`)),
    darwin: [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ],
    linux: [
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/microsoft-edge",
      "/snap/bin/chromium",
    ],
  }[process.platform] ?? [];

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return { executablePath: file, via: "path-scan" };
    } catch {
      /* ignore */
    }
  }

  const names =
    process.platform === "win32"
      ? ["chrome.exe", "msedge.exe", "brave.exe"]
      : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      try {
        if (fs.existsSync(file)) return { executablePath: file, via: "PATH" };
      } catch {
        /* ignore */
      }
    }
  }

  if (process.platform === "win32") {
    for (const exe of ["chrome.exe", "msedge.exe"]) {
      try {
        const out = execFileSync(
          "reg",
          ["query", `HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${exe}`, "/ve"],
          { encoding: "utf8", windowsHide: true, timeout: 5000 }
        );
        const match = out.match(/REG_SZ\s+(.+\.exe)/i);
        if (match && fs.existsSync(match[1].trim())) return { executablePath: match[1].trim(), via: "registry" };
      } catch {
        /* ignore */
      }
    }
  }

  return { channel: "chrome", via: "playwright-channel" };
}

export function depsEntry() {
  return path.join(dirs().deps, "node_modules", "playwright-core", "index.js");
}

export function depsInstalled() {
  return fs.existsSync(depsEntry());
}

export async function loadPlaywright() {
  const entry = depsEntry();
  if (!fs.existsSync(entry)) {
    throw Object.assign(new Error("playwright-core 未安装：先运行 dbb setup"), { code: "DEPENDENCY_MISSING" });
  }
  const mod = await import(pathToFileURL(entry).href);
  return mod.default ?? mod;
}

/**
 * 启动持久化浏览器。
 *
 * 豆包（字节系）相比 Google 的优势：登录态 cookie 基本都是**持久型**
 * （sessionid / sid_guard / sid_tt / uid_tt / ttwid 都带 Expires），
 * 所以不需要 `--restore-last-session` 那套 workaround。
 * 但仍保留 storage-state 备份作为第二重保险。
 *
 * 通用要点：
 *   - chromiumSandbox: true（默认 false 会注入 --no-sandbox，
 *     既是安全降级也是自动化特征）
 *   - viewport: null（否则窗口无法最大化）
 *   - 优雅关闭（ctx.close()）：强杀会跳过 cookie 落盘
 */
export async function launchBrowser({ headless = false, acceptDownloads = true } = {}) {
  const pw = await loadPlaywright();
  const d = dirs();
  ensureDir(d.profile, 0o700);
  const found = findBrowser();
  if (!found) {
    throw Object.assign(
      new Error("未找到可用的 Chromium 系浏览器（Chrome / Edge / Brave）。可用 DBB_BROWSER_PATH 指定路径。"),
      { code: "DEPENDENCY_MISSING" }
    );
  }

  const launchOpts = {
    headless,
    viewport: headless ? { width: 1280, height: 900 } : null,
    chromiumSandbox: true,
    locale: "zh-CN",
    acceptDownloads,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
      "--start-maximized",
    ],
  };
  if (found.executablePath) launchOpts.executablePath = found.executablePath;
  else launchOpts.channel = found.channel;

  log("info", `browser launch: ${found.executablePath ?? `channel=${found.channel}`} (via ${found.via}), headless=${headless}`);

  const ctx = await pw.chromium.launchPersistentContext(d.profile, launchOpts);
  ctx.setDefaultTimeout(20000);

  // 降低自动化特征
  await ctx.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    const orig = window.navigator.permissions?.query?.bind(window.navigator.permissions);
    if (orig) {
      window.navigator.permissions.query = (p) =>
        p && p.name === "notifications" ? Promise.resolve({ state: Notification.permission }) : orig(p);
    }
  });

  injectStorageState(ctx, d.storageState);

  return ctx;
}

/** 注入上次导出的 storage_state（第二重保险）。 */
export async function injectStorageState(ctx, stateFile) {
  if (!fs.existsSync(stateFile)) return { injected: 0 };
  try {
    const st = readJson(stateFile);
    if (st?.cookies?.length) {
      await ctx.addCookies(st.cookies);
      log("debug", `已注入 storage_state 的 ${st.cookies.length} 个 cookie`);
      return { injected: st.cookies.length };
    }
  } catch (error) {
    log("warn", `storage_state 注入失败: ${String(error).slice(0, 120)}`);
  }
  return { injected: 0 };
}

export async function exportStorageState(ctx, stateFile) {
  try {
    ensureDir(path.dirname(stateFile));
    await ctx.storageState({ path: stateFile });
    const st = readJson(stateFile) ?? {};
    const names = (st.cookies ?? []).map((c) => c.name);
    const loginCookies = names.filter((n) => LOGIN_COOKIE_RE.test(n));
    log("info", `storage_state 已导出: ${names.length} 个 cookie，登录 cookie ${loginCookies.length} 个`);
    return { ok: true, total: names.length, loginCookies };
  } catch (error) {
    log("warn", `storage_state 导出失败: ${String(error).slice(0, 120)}`);
    return { ok: false, error: String(error).slice(0, 200) };
  }
}

/**
 * 豆包（字节系）登录态标志 cookie。
 * 实测 2026-09：sessionid / sessionid_ss / sid_guard / sid_tt / uid_tt /
 * uid_tt_ss / ttwid / passport_csrf_token / odin_tt / n_mh / sid_ucp_v1
 */
export const LOGIN_COOKIE_RE =
  /^(sessionid|sessionid_ss|sid_guard|sid_tt|uid_tt|uid_tt_ss|ttwid|passport_csrf_token|odin_tt|n_mh|sid_ucp_v1|ssid_ucp_v1|has_biz_token)$/;

export async function readLoginCookies(ctx) {
  try {
    const cookies = await ctx.cookies();
    const names = cookies.map((c) => c.name);
    const loginCookies = names.filter((n) => LOGIN_COOKIE_RE.test(n));
    return { total: names.length, loginCookies, loggedIn: loginCookies.length > 0 };
  } catch (error) {
    return { total: 0, loginCookies: [], loggedIn: false, error: String(error).slice(0, 120) };
  }
}

export async function openPage(ctx) {
  const pages = ctx.pages();
  return pages.length > 0 ? pages[0] : ctx.newPage();
}
