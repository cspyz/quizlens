/**
 * 一次性「使用边界」确认流程校验（替代旧的 20 秒计时门禁）。
 *
 * 旧门禁在测试套件里**零断言**，所以它的 ReferenceError 与"只挡 UI 不挡功能"
 * 长期没人发现。本文件给新流程补上断言：
 *   1 弹窗里常驻边界行可见（方案 B）
 *   2 未确认时点「开始答题」→ 弹确认框，且不向内容脚本发 START
 *   3 未勾选时「确认并开始」禁用；勾选后解禁（无计时器，不存在等待）
 *   4 点「取消」→ 关闭且不写入标志
 *   5 勾选并确认 → 写入 boundaryAckAt，遮罩消失
 *   6 重开弹窗不再打扰
 *   7 作答结束的 toast 含使用边界一句
 *
 * 用法：node tools/extension-test/boundary-ack-test.js
 */
const H = require("./harness");
const path = require("path");
const fs = require("fs");

const ROOT = path.join(__dirname, "..", "..");
const PORT = 8098;
const { chromium } = H.ensurePlaywright();

const STEM = "3 + 4 =（  ）";
const OPTS = ["6", "7", "8"];
const PAGE = `<!doctype html><meta charset="utf-8"><title>ack</title><body>
<div class="question"><div class="q-stem">${STEM}</div>
${OPTS.map(t => `<div class="opt"><input type="radio" name="q1"><span class="opt-text">${t}</span></div>`).join("\n")}
</div></body>`;

const r = H.Reporter();
const REPO_ROOT = path.join(__dirname, "..", "..");

(async () => {
  const profileRoot = path.join(REPO_ROOT, ".ext-test-profiles");
  fs.mkdirSync(profileRoot, { recursive: true });
  const userDataDir = fs.mkdtempSync(path.join(profileRoot, "aa-ack-"));

  const site = await H.serve({ port: PORT, routes: { "/page.html": PAGE } });
  let ctx = null;
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        "--headless=new",
        `--disable-extensions-except=${H.EXT}`,
        `--load-extension=${H.EXT}`,
        "--no-sandbox",
      ],
    });
    let sw = ctx.serviceWorkers()[0];
    for (let i = 0; i < 30 && !sw; i++) { await H.sleep(500); sw = ctx.serviceWorkers()[0]; }
    r.t("扩展已加载", !!sw, sw ? sw.url() : "(none)");
    if (!sw) { r.finish(); return; }
    const extId = sw.url().split("/")[2];
    const popupUrl = `chrome-extension://${extId}/popup.html`;

    // ---- 1 常驻边界行 ----
    const p1 = await ctx.newPage();
    await p1.goto(popupUrl, { waitUntil: "domcontentloaded" });
    await H.sleep(500);
    const bound = await p1.evaluate(() => {
      const el = document.querySelector(".aa-bound");
      return el ? { shown: getComputedStyle(el).display !== "none", text: el.innerText } : null;
    });
    r.t("1 答题页常驻边界行可见", !!bound && bound.shown && /正式考试/.test(bound.text), bound && bound.text.slice(0, 40));
    r.t("1 旧的 20 秒门禁 DOM 已移除", await p1.evaluate(() => !document.getElementById("docGate")), "");

    // ---- 2 未确认时点「开始答题」→ 弹确认框，不发 START ----
    const p2 = await ctx.newPage();
    await p2.goto(site.url + "/page.html");
    await p2.waitForSelector(".question", { timeout: 10000 }).catch(() => {});
    await p2.close();

    const p3 = await ctx.newPage();
    await p3.goto(popupUrl, { waitUntil: "domcontentloaded" });
    await H.sleep(500);
    await p3.evaluate(() => {
      // 让 tabs.query 命中刚关掉的那页不方便，这里直接拦截 sendToActiveTab 的副作用
      window.__startClicked = false;
    });
    await p3.click("#start");
    await H.sleep(600);
    const ackShown = await p3.evaluate(() => {
      const el = document.getElementById("ackGate");
      return el ? getComputedStyle(el).display : "(missing)";
    });
    r.t("2 未确认时点「开始答题」弹出确认框", ackShown === "flex", ackShown);
    r.t("2 确认框无倒计时元素（不是计时门禁）",
      await p3.evaluate(() => !document.getElementById("docGateCount")), "");

    // ---- 3 勾选门控 ----
    r.t("3 未勾选时「确认并开始」禁用", await p3.evaluate(() => document.getElementById("ackYes").disabled), "");
    await p3.evaluate(() => document.getElementById("ackChk").click());
    await H.sleep(200);
    r.t("3 勾选后立即解禁（无 20 秒等待）", await p3.evaluate(() => !document.getElementById("ackYes").disabled), "");

    // ---- 4 取消不写入 ----
    await p3.click("#ackNo");
    await H.sleep(300);
    r.t("4 点「取消」遮罩关闭", await p3.evaluate(() =>
      getComputedStyle(document.getElementById("ackGate")).display) === "none", "");
    const afterCancel = await p3.evaluate(() => new Promise(res =>
      chrome.storage.local.get(["boundaryAckAt"], st => res(st.boundaryAckAt || null))));
    r.t("4 取消后未写入 boundaryAckAt", afterCancel === null, afterCancel);

    // ---- 5 确认写入 ----
    await p3.click("#start");
    await H.sleep(400);
    const reopened = await p3.evaluate(() => ({
      shown: getComputedStyle(document.getElementById("ackGate")).display,
      chk: document.getElementById("ackChk").checked,
      yes: document.getElementById("ackYes").disabled,
    }));
    r.t("5 重开时复选框已复位且按钮保持锁定",
      reopened.shown === "flex" && reopened.chk === false && reopened.yes === true, reopened);
    await p3.evaluate(() => document.getElementById("ackChk").click());
    await H.sleep(150);
    await p3.click("#ackYes");
    await H.sleep(900);
    // 确认后会真的发起 START 并 window.close()，所以标志要从另一个页面读
    const probe = await ctx.newPage();
    await probe.goto(popupUrl, { waitUntil: "domcontentloaded" });
    await H.sleep(500);
    const acked = await probe.evaluate(() => new Promise(res =>
      chrome.storage.local.get(["boundaryAckAt"], st => res(st.boundaryAckAt || null))));
    r.t("5 确认后写入 boundaryAckAt 时间戳", typeof acked === "number" && acked > 0, acked);
    r.t("5 确认后不再被遮罩挡住", await probe.evaluate(() =>
      getComputedStyle(document.getElementById("ackGate")).display) === "none", "");

    // ---- 6 重开不打扰 ----
    const p4 = await ctx.newPage();
    await p4.goto(popupUrl, { waitUntil: "domcontentloaded" });
    await H.sleep(500);
    r.t("6 重开弹窗不再弹确认", await p4.evaluate(() =>
      getComputedStyle(document.getElementById("ackGate")).display) === "none", "");

    // ---- 7 结束提示含边界 ----
    const src = fs.readFileSync(path.join(H.EXT, "content.js"), "utf-8");
    r.t("7 作答结束 toast 文案含使用边界",
      /已填 \$\{filled\} 题[\s\S]{0,160}正式考试/.test(src), "源码扫描 content.js 的收尾 toast");

    // ---- 8 随包免责声明页与仓库 DISCLAIMER.md 不漂移 ----
    const md = fs.readFileSync(path.join(REPO_ROOT, "DISCLAIMER.md"), "utf-8");
    const html = fs.readFileSync(path.join(H.EXT, "docs", "disclaimer.html"), "utf-8");
    const mdTitles = [...md.matchAll(/^## ([一二三四五六七八九十]+、.+)$/gm)].map(m => m[1].trim());
    const dp = await ctx.newPage();
    await dp.goto(`chrome-extension://${extId}/docs/disclaimer.html`, { waitUntil: "domcontentloaded" });
    const htmlTitles = await dp.evaluate(() =>
      [...document.querySelectorAll("h2")].map(h => h.innerText.trim()));
    r.t(`8 disclaimer.html 覆盖 DISCLAIMER.md 的全部 ${mdTitles.length} 节标题`,
      mdTitles.length === 14 && mdTitles.every(t => htmlTitles.includes(t)),
      mdTitles.filter(t => !htmlTitles.includes(t)));
    r.t("8 免责声明页已登记进 web_accessible_resources",
      /docs\/disclaimer\.html/.test(fs.readFileSync(path.join(H.EXT, "manifest.json"), "utf-8")), "");
    r.t("8 popup 与 user-guide 都有可点入口",
      /disclaimer\.html/.test(fs.readFileSync(path.join(H.EXT, "popup.js"), "utf-8")) &&
      /href="disclaimer\.html"/.test(fs.readFileSync(path.join(H.EXT, "docs", "user-guide.html"), "utf-8")), "");
    await dp.close();
  } finally {
    if (ctx) await ctx.close().catch(() => {});
    await site.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 5 });
  }
  r.finish();
})();
