/**
 * P0 修复验证：
 *  1) content.js 被重复注入（扩展页点「重新加载」的真实场景）时只生效一份，不会双份监听器
 *  2) 注入的是**不同版本**时要能"接管"：清掉旧版遗留的面板、注册自己的监听器，
 *     且旧版实例不再响应消息（否则重载扩展后页面跑的还是旧代码，或者新旧同时动作）
 *  3) 按 ESC 能关掉面板，且不再抛 ReferenceError（此前 cleanupAll 未定义）
 */
const path = require("path");
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8084;
const QUIZ_DIR = path.join(__dirname, "..", "..", "quiz-app");
const CONTENT = path.join(H.EXT, "content.js");

H.run(async () => {
  const site = await H.serve({ port: PORT, staticDir: QUIZ_DIR });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const page = await H.newPage(browser, site.url + "/");
  const R = H.Reporter();

  // ---- 1) 同版本重复注入 ----
  const afterFirst = await page.evaluate(() => ({
    marker: window.__aaContentLoaded,
    listeners: window.__listenerCount,
  }));
  await page.addScriptTag({ path: CONTENT });     // 再注入一次，版本相同
  const afterSame = await page.evaluate(() => window.__listenerCount);
  R.t("首次注入注册了监听器", afterFirst.listeners === 1, afterFirst);
  R.t("同版本重复注入不再注册（只生效一份）", afterSame === afterFirst.listeners,
      { before: afterFirst.listeners, after: afterSame });

  // ---- 2) 不同版本注入 → 接管 ----
  // 造出"页面上已有一个旧版实例"的现场：旧版本标记 + 一个旧面板 + 旧版监听器
  await page.evaluate(() => {
    const stale = document.createElement("div");
    stale.className = "aa-panel";
    stale.id = "stalePanel";
    document.documentElement.appendChild(stale);
    // 让下一次注入读到更高的版本号（模拟"升级后重载扩展"）
    window.chrome.runtime.getManifest = () => ({ version: "2.0" });
  });
  const beforeTakeover = await page.evaluate(() => window.__listenerCount);
  await page.addScriptTag({ path: CONTENT });

  const takeover = await page.evaluate(() => ({
    marker: window.__aaContentLoaded,
    listeners: window.__listenerCount,
    staleRemoved: !document.getElementById("stalePanel"),
  }));
  R.t("不同版本会接管：版本标记更新为当前版本", takeover.marker === "2.0", takeover.marker);
  R.t("接管时清掉旧版遗留的面板", takeover.staleRemoved, takeover.staleRemoved);
  R.t("接管版本注册了自己的监听器", takeover.listeners === beforeTakeover + 1,
      { before: beforeTakeover, after: takeover.listeners });

  // 旧实例虽然监听器还在，但版本比对会让它不再响应 —— 表现是只出现一个面板而不是两个
  await page.evaluate(() => window.__aaListener?.({
    type: "START",
    settings: { mode: "bank", fillHosts: "not-allowed.example" },
  }));
  await H.sleep(1200);
  const panels = await page.evaluate(() => ({
    count: document.querySelectorAll(".aa-panel").length,
    version: document.querySelector(".aa-panel .aa-ver")?.textContent || "",
    chips: !!document.querySelector(".aa-panel"),
  }));
  R.t("旧版实例不再响应（只出现一个面板，不是两个）", panels.count === 1, panels.count);
  R.t("面板显示的是接管后的版本号", panels.version === "v2.0", panels.version);

  // ---- 3) ESC 关面板 ----
  const beforeEsc = await page.evaluate(() => document.querySelectorAll(".aa-panel").length);
  await page.keyboard.press("Escape");
  await H.sleep(400);
  const afterEsc = await page.evaluate(() => document.querySelectorAll(".aa-panel").length);
  R.t("扫描面板已创建", beforeEsc === 1, beforeEsc);
  R.t("ESC 后面板被关闭", afterEsc === 0, afterEsc);
  R.t("ESC 未抛 ReferenceError", !page.errors.some(m => /cleanupAll/.test(m)), page.errors.join(" | ") || "(无)");
  R.t("全程无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
