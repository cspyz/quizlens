/**
 * 真实扩展端到端测试（唯一一个不 stub chrome 的测试）。
 *
 * 为什么必须有这个测试：其余 13 个测试都是「往页面里 addScriptTag 注入 content.js + 手写 chrome stub」，
 * 于是有三样东西从来没被真正执行过：
 *   ① chrome.runtime.getURL("bank/")   —— stub 里根本没有这个方法，content.js 里是靠 try/catch 跳过的
 *   ② manifest 的 web_accessible_resources —— stub 环境不校验，写错了也发现不了
 *   ③ background.js 的 FETCH_BANK 后台代理 —— stub 直接返回 {ok:false}，走的永远是退回分支
 * 而这三样恰好是 P0-2 修复的主干：真实网站上题库能不能加载，全看它们。
 * 本测试用 launchPersistentContext + --load-extension 加载真扩展，走真 service worker。
 *
 * 注意：扩展只能在 headless=new 下加载（老 headless 不支持扩展），
 * 所以这里 headless:false + args 里手动加 --headless=new。
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();
const path = require("path");
const os = require("os");
const fs = require("fs");

const PORT = 8096;               // 避开其他测试占用的 8081-8095
const EXT_ID_RE = /^chrome-extension:\/\/[a-p]{32}\/background\.js$/;

// 前置条件：内置题库必须先同步进扩展目录（python tools/sync_bank.py）。
// 没同步的话下面每一条都会失败，报错却看不出原因，所以先单独查一次并给出能照做的提示。
// 退出码 2 = 跳过（run-all.js 会单独统计，不算失败）。
const BUNDLED_INDEX = path.join(H.EXT, "bank", "index.json");
if (!fs.existsSync(BUNDLED_INDEX)) {
  console.error("SKIP: 扩展内置题库还没同步 —— 先运行 python tools/sync_bank.py，再跑本测试。");
  process.exit(2);
}

// 页面结构用本地练习页的 .question/.q-stem/.opt/.opt-text —— 走「题卡结构」这条识别路径
const pageWith = (stem, opts) => `<!doctype html><meta charset="utf-8"><title>真实扩展测试</title><body>
<div class="question"><div class="q-stem">${stem}</div>
${opts.map(t => `<div class="opt"><input type="radio" name="q1"><span class="opt-text">${t}</span></div>`).join("\n")}
</div></body>`;

// 内置题库里的真题（09_primary.json 第一题，答案下标 1）
const BUNDLED_STEM = "3 + 4 =（  ）";
const BUNDLED_OPTS = ["6", "7", "8"];
const BUNDLED_ANSWER = 1;

// 自定义题库里放同一道题干但**答案不同**（下标 2）—— 用勾选下标就能分辨到底用了哪一份
const CUSTOM_STEM = BUNDLED_STEM;
const CUSTOM_OPTS = BUNDLED_OPTS;
const CUSTOM_ANSWER = 2;

const CUSTOM_INDEX = [{ file: "01_custom.json", label: "自定义测试库", count: 1 }];
const CUSTOM_BANK = {
  category: "自定义测试库",
  count: 1,
  questions: [{ question: CUSTOM_STEM, options: CUSTOM_OPTS, answer: [CUSTOM_ANSWER], type: "single" }],
};

// 等日志容器出现「完成：题库命中 N」（#aa-log 是旧 id，.aa-runlog 是现写法）
async function waitDone(page, tries = 16) {
  for (let i = 0; i < tries; i++) {
    await H.sleep(2500);
    const log = await page.evaluate(() => (document.querySelector("#aa-log, .aa-runlog") || {}).innerText || "");
    if (/完成：题库命中\s*\d+/.test(log)) return log;
  }
  return await page.evaluate(() => (document.querySelector("#aa-log, .aa-runlog") || {}).innerText || "");
}

// 让后台给指定 url 的标签页发消息（真实 chrome.tabs.sendMessage）。
// urlPattern 必须唯一到某一个标签页：query 返回的是**全部**匹配标签页，
// 拿到 tabs[0] 会打到上一个已完成的标签页上（实测踩过：场景2 日志全空）。
const sendToTab = (sw, urlPattern, msg) => sw.evaluate(async ({ pattern, m }) => {
  const tabs = await chrome.tabs.query({ url: pattern });
  if (!tabs.length) return { ok: false, error: "没找到标签页" };
  if (tabs.length > 1) return { ok: false, error: `匹配到 ${tabs.length} 个标签页，无法确定目标` };
  try {
    await chrome.tabs.sendMessage(tabs[0].id, m);
    return { ok: true, tabId: tabs[0].id };
  } catch (e) { return { ok: false, error: String(e) }; }
}, { pattern: urlPattern, m: msg });

H.run(async () => {
  const r = H.Reporter();
  // profile 目录不能随便放：Chromium 要在其中创建 ProcessSingleton 锁文件，
  // 本机有两处会失败，报 "Lock file cannot be created: 拒绝访问 (0x5)"，
  // 外层表现为 "Failed to create a ProcessSingleton for your profile directory"：
  //   ① os.tmpdir()，即 C:\Users\<user>\AppData\Local\Temp
  //   ② tools/ 这棵子树（含本文件所在目录）
  // 同一组启动参数放到仓库根目录（或 .pw-deps/、reviews/）下就正常，已实测。
  // 所以这里用仓库根的隐藏目录，并对目录建不出来的情况做降级。
  const REPO_ROOT = path.join(__dirname, "..", "..");
  const PROFILE_ROOTS = [
    path.join(REPO_ROOT, ".ext-test-profiles"),   // 首选：仓库根，实测可建锁
    path.join(REPO_ROOT, ".pw-deps", "profiles"), // 兜底：同样在 D:\ 下且验证过
  ];
  let userDataDir = null;
  for (const root of PROFILE_ROOTS) {
    try {
      fs.mkdirSync(root, { recursive: true });
      userDataDir = fs.mkdtempSync(path.join(root, "aa-realext-"));
      break;
    } catch (_) { /* 换下一个 */ }
  }
  if (!userDataDir) throw new Error("无法创建扩展测试用的 profile 目录（已尝试 " + PROFILE_ROOTS.join(" 和 ") + "）");
  let ctx = null, site = null;
  try {
    site = await H.serve({
      port: PORT,
      routes: {
        // 两个场景用**不同路径**，这样 tabs.query 能唯一命中目标标签页
        "/page1.html": pageWith(BUNDLED_STEM, BUNDLED_OPTS),
        "/page2.html": pageWith(BUNDLED_STEM, BUNDLED_OPTS),
        "/altbank/index.json": CUSTOM_INDEX,
        "/altbank/01_custom.json": CUSTOM_BANK,
      },
    });

    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,                       // 必须：见文件头注释
      args: [
        "--headless=new",
        `--disable-extensions-except=${H.EXT}`,
        `--load-extension=${H.EXT}`,
        "--no-sandbox",
      ],
    });

    // ---- service worker 起来 ----
    let sw = ctx.serviceWorkers()[0];
    for (let i = 0; i < 30 && !sw; i++) { await H.sleep(500); sw = ctx.serviceWorkers()[0]; }
    r.t("扩展 service worker 已启动", !!sw && EXT_ID_RE.test(sw.url()), sw ? sw.url() : "(none)");
    if (!sw) { r.finish(); return; }

    // ---- ① chrome.runtime.getURL + ② web_accessible_resources：后台能不能读到内置题库 ----
    const bg = await sw.evaluate(async () => {
      const out = { url: null, status: null, len: 0, error: null };
      try {
        out.url = chrome.runtime.getURL("bank/index.json");
        const res = await fetch(out.url);
        out.status = res.status;
        out.len = (await res.text()).length;
      } catch (e) { out.error = String(e); }
      return out;
    });
    r.t("chrome.runtime.getURL 指向扩展自身", /^chrome-extension:\/\/[a-p]{32}\/bank\/index\.json$/.test(bg.url || ""), bg.url);
    r.t("内置题库 index.json 可读（web_accessible_resources 生效）", bg.status === 200 && bg.len > 100, bg);

    // ================= 场景 1：不填题库地址 → 用内置题库（来源 ②） =================
    const p1 = await ctx.newPage();
    const errs1 = [];
    p1.on("pageerror", e => errs1.push(e.message));
    await p1.goto(site.url + "/page1.html");
    await p1.waitForSelector(".question", { timeout: 15000 }).catch(() => {});
    await H.sleep(1500);

    const sent1 = await sendToTab(sw, `http://localhost:${PORT}/page1.html`, {
      type: "START",
      // showLog: true —— 产品 run() 是按这条 START 消息里的 settings.showLog 决定
      // 要不要建日志面板的（不是 storage）。本测试的断言全靠读日志（大题库 N/M、
      // 来源标记、完成行），不开就全读不到 —— 而勾选断言仍会通过，很容易误判成产品坏了。
      settings: { mode: "bank", intervalMs: 50, fillHosts: "*", showLog: true },
    });
    r.t("内容脚本已注入且能收到 START", sent1.ok === true, sent1);

    const log1 = await waitDone(p1);
    // 类别数**不能写死**：题库从 9 类扩到 41 类后，硬编码的 9/9 会立刻变红。
    // 直接读内置 index.json 的类别数当期望值，题库增删都不用改测试。
    const bundledCount = H.readBundledIndexCount();
    const bankLoad1 = log1.match(/大题库：(\d+)\/(\d+)/) || [];
    r.t(`内置题库 ${bundledCount}/${bundledCount} 类别加载成功`,
      bankLoad1[1] === String(bundledCount) && bankLoad1[2] === String(bundledCount),
      `${bankLoad1[1]}/${bankLoad1[2]}（期望 ${bundledCount}）`);
    r.t("来源标记为「扩展内置题库」", /来源：扩展内置题库/.test(log1), (log1.match(/来源：[^\n，)]*/) || [""])[0]);
    const total1 = Number((log1.match(/共 (\d+) 题/) || [])[1] || 0);
    // 同理，题量下界也从 index.json 的 count 之和算（留 1% 余量给"题干归一化后为空被跳过"）。
    // 这样题库更新后不用再手工改这个数字。
    const bundledMin = Math.floor(H.readBundledIndexTotal() * 0.99);
    r.t(`题库总数 >= ${bundledMin}（按内置 index.json 计）`, total1 >= bundledMin, total1);
    r.t("命中 1 题且未走 AI", /完成：题库命中 1，AI 作答 0/.test(log1), (log1.match(/完成：[^\n]*/) || [""])[0]);

    const checked1 = await p1.evaluate(() => [...document.querySelectorAll(".opt input")].map(i => i.checked));
    r.t("按内置题库答案勾选（下标 1）", checked1[BUNDLED_ANSWER] === true && checked1.filter(Boolean).length === 1, checked1);
    r.t("场景1 无未捕获异常", errs1.length === 0, errs1);

    // ================= 场景 2：填题库地址 → 自定义题库优先（来源 ①） =================
    // 同一道题干、不同答案，勾选下标能直接证明用的是哪一份
    const p2 = await ctx.newPage();
    const errs2 = [];
    p2.on("pageerror", e => errs2.push(e.message));
    await p2.goto(site.url + "/page2.html");
    await p2.waitForSelector(".question", { timeout: 15000 }).catch(() => {});
    await H.sleep(1500);

    const sent2 = await sendToTab(sw, `http://localhost:${PORT}/page2.html`, {
      type: "START",
      settings: { mode: "bank", intervalMs: 50, fillHosts: "*", bankBaseUrl: site.url + "/altbank/", showLog: true },
    });
    r.t("场景2 内容脚本收到 START", sent2.ok === true, sent2);

    const log2 = await waitDone(p2);
    r.t("自定义地址优先（来源：自定义题库地址）", /来源：自定义题库地址/.test(log2), (log2.match(/来源：[^\n，)]*/) || [""])[0]);
    r.t("自定义题库 1/1 加载成功", /大题库：1\/1 个类别加载成功/.test(log2), (log2.match(/大题库：[^\n]*/) || [""])[0]);
    const checked2 = await p2.evaluate(() => [...document.querySelectorAll(".opt input")].map(i => i.checked));
    r.t("按自定义题库答案勾选（下标 2，证明覆盖了内置库）",
      checked2[CUSTOM_ANSWER] === true && checked2.filter(Boolean).length === 1, checked2);
    r.t("场景2 无未捕获异常", errs2.length === 0, errs2);

    r.finish();
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    if (site) await site.close().catch(() => {});
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) {}
  }
});
