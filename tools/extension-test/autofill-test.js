/**
 * 任意网页自动填涂验证：
 *  1) whitelist 里的 "*" 通配符放行全部站点（不再受域名限制）
 *  2) 没有 input 的页面（选项是 <li>A. xxx</li>）也能自动填涂：直接点选项元素
 *  3) 一道可填的题都没有时，自动降级为只读识别面板，而不是报"识别到 0 道题"就结束
 * 全部走 AI 模式 + stub，不加载题库，跑得快。
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8087;

// 页1：标准 radio/checkbox 表单。Q1 题干是选项容器的前兄弟（无共同祖先，走兜底分支），
// Q2 题干与选项在同一个容器里（常规结构），两种都要能识别
const PAGE_FORM = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>表单页</title></head><body>
<h1>radio 表单</h1>
<div class="q">1. 下列哪一个是编程语言？</div>
<div class="opts">
  <label><input type="radio" name="a1" value="0"><span>JavaScript</span></label>
  <label><input type="radio" name="a1" value="1"><span>HTML</span></label>
  <label><input type="radio" name="a1" value="2"><span>CSS</span></label>
</div>
<div class="qbox">
  <div class="q">2. 下列哪一个是数据库？</div>
  <div class="opts">
    <label><input type="checkbox" name="a2" value="0"><span>MySQL</span></label>
    <label><input type="checkbox" name="a2" value="1"><span>Nginx</span></label>
    <label><input type="checkbox" name="a2" value="2"><span>Redis</span></label>
  </div>
</div>
</body></html>`;

// 页2：完全没有 input，选项是 li（纯文本列表）
const PAGE_LIST = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>列表页</title></head><body>
<h1>纯列表选项</h1>
<div class="quiz">
  <h2>1. 下面关于浏览器扩展的说法，哪一项是正确的？</h2>
  <ul id="opts1">
    <li onclick="window.__clicks.push('A')">A. 扩展的 content script 运行在页面里，可以读写页面 DOM</li>
    <li onclick="window.__clicks.push('B')">B. 浏览器扩展无法发起网络请求，只能操作本地存储</li>
    <li onclick="window.__clicks.push('C')">C. MV3 的 service worker 是常驻内存的，永远不会被回收</li>
    <li onclick="window.__clicks.push('D')">D. content script 只能注入到扩展自己的页面里去</li>
  </ul>
</div>
<div class="quiz">
  <h2>2. 关于 CSS 盒模型，下列说法正确的是哪一项？</h2>
  <ul id="opts2">
    <li onclick="window.__clicks.push('A2')">A. 外边距会算进元素自身 width 的实际值里面</li>
    <li onclick="window.__clicks.push('B2')">B. box-sizing 为 border-box 时包含内边距与边框</li>
    <li onclick="window.__clicks.push('C2')">C. 内边距永远会被算进元素设定的宽度里面</li>
    <li onclick="window.__clicks.push('D2')">D. 边框宽度不影响元素在页面上实际占位的尺寸</li>
  </ul>
</div>
</body></html>`;

// 页3：什么题都没有
const PAGE_NONE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>空页</title></head><body>
<h1>这一页没有题目</h1>
<p>只有一些普通说明文字，既没有选项组，也没有可点击的选项列表。</p>
</body></html>`;

const START = { mode: "ai", intervalMs: 50, aiKey: "x", fillHosts: "*" };

H.run(async () => {
  const site = await H.serve({
    port: PORT,
    routes: { "/form.html": PAGE_FORM, "/list.html": PAGE_LIST, "/none.html": PAGE_NONE },
  });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const R = H.Reporter();

  // ---- 用例 1：* 通配符 + radio/checkbox 表单 ----
  const p1 = await H.newPage(browser, site.url + "/form.html", { aiAnswer: "A", waitFor: null });
  await H.startAndWait(p1, START);
  const r1 = await p1.evaluate(() => ({
    checked: [...document.querySelectorAll("input:checked")].map(i => i.name + ":" + i.value),
    warned: /不在自动填涂白名单/.test(document.querySelector(".aa-warn")?.textContent || ""),
  }));
  console.log("用例1 日志:\n" + await H.readLog(p1) + "\n");
  R.t("通配符 * 放行任意站点（未降级）", !r1.warned, r1.warned);
  R.t("radio 组被填涂（name=a1 选中 A）", r1.checked.includes("a1:0"), r1.checked);
  R.t("checkbox 组被填涂（name=a2 选中 A）", r1.checked.includes("a2:0"), r1.checked);
  R.t("无未捕获异常", p1.errors.length === 0, p1.errors.join(" | ") || "(无)");

  // ---- 用例 2：没有 input 的选项列表，靠点元素填涂 ----
  const p2 = await H.newPage(browser, site.url + "/list.html", { aiAnswer: "B", waitFor: null });
  await H.startAndWait(p2, START);
  const log2 = await H.readLog(p2);
  const clicks2 = await p2.evaluate(() => window.__clicks);
  console.log("用例2 日志:\n" + log2 + "\n");
  R.t("识别出 2 道列表题", /页面识别到 2 道题/.test(log2), (log2.match(/页面识别到 \d+ 道题/) || [])[0]);
  R.t("第 1 题的 B 选项被点击", clicks2.includes("B"), clicks2);
  R.t("第 2 题的 B 选项被点击", clicks2.includes("B2"), clicks2);
  R.t("重复运行不重复点（B 只出现 1 次）", clicks2.filter(c => c === "B").length === 1, clicks2.length);
  R.t("无未捕获异常", p2.errors.length === 0, p2.errors.join(" | ") || "(无)");

  // 再跑一次，验证已点过的不再点（否则会来回翻转选中态）
  await p2.evaluate(s => window.__aaListener({ type: "START", settings: s }), START);
  await H.sleep(4000);
  const clicks2b = await p2.evaluate(() => window.__clicks);
  R.t("二次运行不新增点击（不来回翻转）", clicks2b.length === clicks2.length, `${clicks2.length} → ${clicks2b.length}`);

  // ---- 用例 3：没有可填涂的题 → 自动降级只读面板 ----
  // 显式关掉运行日志面板：本用例只验证"没有可填涂的题 → 降级为只读识别面板"，
  // 顺带钉住"关掉 showLog 时不创建日志面板"这条独立语义。
  // （不写 showLog 的话会用到 harness 的默认值 true，断言就会自相矛盾）
  const p3 = await H.newPage(browser, site.url + "/none.html", {
    aiAnswer: "A", waitFor: null, storage: { showLog: false },
  });
  // ⚠ 监听器必须在发 START **之前**挂上：日志是启动瞬间就写出去的，
  // 挂晚了（先 start 后 on）一条都收不到 —— 实测就是这样拿到空数组的。
  const consoleLines = [];
  p3.on("console", m => consoleLines.push(m.text()));
  await p3.evaluate(() => window.__aaListener({
    type: "START", settings: { mode: "bank", intervalMs: 50, fillHosts: "*", showLog: false },
  }));
  await H.sleep(1500);
  const r3 = await p3.evaluate(() => ({
    panel: !!document.querySelector(".aa-panel"),
    warn: document.querySelector(".aa-warn")?.textContent || "",
  }));
  console.log("用例3 提示:", r3.warn, "\n");
  R.t("自动切换为只读识别面板", r3.panel, r3.panel);
  R.t("提示已切换为只读识别", /只读识别/.test(r3.warn), r3.warn.slice(0, 40));
  // ⚠ 这条断言原来写的是"面板里没有 .aa-runlog"，但那是**过期的假设**：
  // 日志区现在并进了统一的题卡面板（.aa-panel 里就带 .aa-runlog），
  // 只要识别面板存在，这个 class 就必然在 —— 与 showLog 开关无关。
  // showLog 真正控制的是「日志往哪写」：关掉时写浏览器控制台。
  R.t("showLog 关掉时日志写进控制台（不是面板）",
    consoleLines.some(l => /QuizLens/.test(l)), consoleLines.slice(0, 2));
  R.t("无未捕获异常", p3.errors.length === 0, p3.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
