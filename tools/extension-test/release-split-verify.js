/**
 * 发布副本校验：确认「不含内置题库的扩展」+「独立题库包」这条分发路径真的可用。
 *
 * 三个场景：
 *   A 发布副本能被 Chrome 加载（manifest 合法、service worker 起得来）
 *   B 副本里没有内置题库（bank/index.json 取不到）—— 剥离确实生效
 *   C 填「题库地址」指向发布版题库包 → 46 类 / 18.6 万题全部加载成功，且能命中作答
 *   D 什么都不填 → 按预期降级，并给出可照着做的提示（不是静默失败）
 *
 * 用法：node tools/extension-test/release-split-verify.js
 */
const H = require("./harness");
const path = require("path");
const fs = require("fs");
const os = require("os");

const ROOT = path.join(__dirname, "..", "..");
const REL_EXT = path.join(ROOT, "_release", "extension");
const BANK_DIR = path.join(ROOT, "_release", "bank-package");
const PORT = 8097;

const { chromium } = H.ensurePlaywright();

const STEM = "3 + 4 =（  ）";
const OPTS = ["6", "7", "8"];
// 页面结构用 .question/.q-stem/.opt/.opt-text —— 走「题卡结构」识别路径，
// 与 real-ext-test.js 保持一致（自己造的 label>input 结构走不通那条路径）。
const pageWith = () => `<!doctype html><meta charset="utf-8"><title>release split</title><body>
<div class="question"><div class="q-stem">${STEM}</div>
${OPTS.map(t => `<div class="opt"><input type="radio" name="q1"><span class="opt-text">${t}</span></div>`).join("\n")}
</div></body>`;
const PAGE = pageWith();

const R = H.Reporter();

function mkProfile() {
  // profile 目录不能放 os.tmpdir()：Chromium 在那里建 ProcessSingleton 锁文件会
  // 报「拒绝访问 (0x5)」。同 real-ext-test.js，用仓库根的隐藏目录。
  const root = path.join(ROOT, ".ext-test-profiles");
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, "aa-release-"));
}

const sendToTab = (sw, urlPattern, msg) => sw.evaluate(async ({ pattern, m }) => {
  const tabs = await chrome.tabs.query({ url: pattern });
  if (!tabs.length) return { ok: false, error: "no tab for " + pattern };
  try {
    return { ok: true, reply: await chrome.tabs.sendMessage(tabs[0].id, m) };
  } catch (e) { return { ok: false, error: String(e) }; }
}, { pattern: urlPattern, m: msg });

async function waitLog(page, re, tries = 24) {
  const read = () => page.evaluate(
    () => (document.querySelector("#aa-log, .aa-runlog") || {}).innerText || "");
  for (let i = 0; i < tries; i++) {
    await H.sleep(2500);
    const txt = await read().catch(() => "");
    if (re.test(txt)) return txt;
  }
  return await read().catch(() => "(log container not found)");
}

H.run(async () => {
  R.t("发布副本目录存在", fs.existsSync(path.join(REL_EXT, "manifest.json")), REL_EXT);
  R.t("发布副本内确实没有 bank/", !fs.existsSync(path.join(REL_EXT, "bank")), "应为不存在");
  R.t("题库包目录存在", fs.existsSync(path.join(BANK_DIR, "index.json")), BANK_DIR);

  const idx = JSON.parse(fs.readFileSync(path.join(BANK_DIR, "index.json"), "utf-8"));
  const expectCats = idx.length;
  const expectTotal = idx.reduce((s, e) => s + (e.count || 0), 0);

  const site = await H.serve({
    port: PORT, staticDir: BANK_DIR, defaultFile: "index.json",
    // 两个场景必须用**不同路径**：tabs.query 返回全部匹配标签页，
    // 同 URL 会让第二个 START 打到第一个标签页上（实测踩过）。
    // D 故意放在 /sub/ 下：这样页面自身兜底要找的 ./bank/index.json 会解析到
    // /sub/bank/index.json（不存在）→ 三个来源全落空 → 才能真正测到降级路径。
    routes: { "/page.html": PAGE, "/sub/page2.html": PAGE },
  });
  const userDataDir = mkProfile();
  let ctx = null;
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        "--headless=new",
        `--disable-extensions-except=${REL_EXT}`,
        `--load-extension=${REL_EXT}`,
        "--no-sandbox",
      ],
    });

    let sw = ctx.serviceWorkers()[0];
    for (let i = 0; i < 30 && !sw; i++) { await H.sleep(500); sw = ctx.serviceWorkers()[0]; }
    R.t("A｜发布副本能被 Chrome 加载（service worker 启动）", !!sw, sw ? sw.url() : "(none)");
    if (!sw) { R.finish(); return; }

    const bg = await sw.evaluate(async () => {
      const out = {};
      try {
        out.url = chrome.runtime.getURL("bank/index.json");
        const res = await fetch(out.url);
        out.status = res.status;
        out.len = (await res.text()).length;
      } catch (e) { out.error = String(e); }
      return out;
    });
    R.t("B｜副本内置题库不可读（剥离生效）", !bg.len || bg.status >= 400 || !!bg.error, bg);

    // ---- C：题库地址指向发布版题库包 ----
    const p3 = await ctx.newPage();
    const errs3 = [];
    p3.on("pageerror", e => errs3.push(e.message));
    await p3.goto(site.url + "/page.html");
    await p3.waitForSelector(".question", { timeout: 15000 }).catch(() => {});
    await H.sleep(1500);
    const sent3 = await sendToTab(sw, `http://localhost:${PORT}/page.html`, {
      type: "START",
      settings: { mode: "bank", intervalMs: 50, fillHosts: "*", showLog: true, bankBaseUrl: site.url + "/" },
    });
    R.t("C｜内容脚本收到 START", sent3.ok === true, sent3);
    const log3 = await waitLog(p3, /完成：题库命中|题库加载失败|没有任何可用题库/);
    console.log("----- log3 -----\n" + log3.slice(0, 1200) + "\n----------------");
    const cats = log3.match(/大题库：(\d+)\/(\d+)/) || [];
    R.t(`C｜${expectCats} 个类别全部加载成功`, cats[1] === String(expectCats) && cats[2] === String(expectCats),
      `${cats[1]}/${cats[2]}（期望 ${expectCats}/${expectCats}）`);
    R.t("C｜来源标注为「自定义题库地址」", /来源：自定义题库地址/.test(log3), (log3.match(/来源：[^\n，)]*/) || [""])[0]);
    const total3 = Number((log3.match(/共 (\d+) 题/) || [])[1] || 0);
    R.t(`C｜题量 >= ${Math.floor(expectTotal * 0.99)}（发布版 ASCII 改名后仍可完整加载）`,
      total3 >= Math.floor(expectTotal * 0.99), `${total3} / 期望约 ${expectTotal}`);
    const checked3 = await p3.evaluate(() => [...document.querySelectorAll(".opt input")].map(i => i.checked));
    R.t("C｜题库命中并正确勾选（下标 1 = 7）",
      checked3[1] === true && checked3.filter(Boolean).length === 1, checked3);
    R.t("C｜无未捕获异常", errs3.length === 0, errs3);

    // ---- D：不填题库地址 → 应降级并给出可操作提示 ----
    const p4 = await ctx.newPage();
    await p4.goto(site.url + "/sub/page2.html");
    await p4.waitForSelector(".question", { timeout: 15000 }).catch(() => {});
    await H.sleep(1500);
    await sendToTab(sw, `http://localhost:${PORT}/sub/page2.html`, {
      type: "START",
      settings: { mode: "bank", intervalMs: 50, fillHosts: "*", showLog: true, bankBaseUrl: "" },
    });
    const log4 = await waitLog(p4, /题库加载失败|没有任何可用题库|大题库没加载到/);
    console.log("----- log4 -----\n" + log4.slice(0, 1200) + "\n----------------");
    R.t("D｜无内置题库时明确报失败（不静默）", /题库加载失败|没有任何可用题库|大题库没加载到/.test(log4),
      (log4.match(/(题库加载失败|大题库没加载到)[^\n]*/) || [""])[0]);
    R.t("D｜给出「填题库地址 / 换仅 AI」的可操作提示", /题库地址/.test(log4) && /仅 AI/.test(log4),
      "见日志提示行");
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    if (site) await site.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 });
  }
  R.finish();
});
