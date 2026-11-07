/**
 * 扫描面板「✍ 填涂」按钮测试。
 *
 * 场景：先把页面题识别出来（只读面板），再点面板上的「填涂」自动勾选。
 * 页面里放三种题，验证各自的处理：
 *   ① radio 选项组        → 能点，应被勾上
 *   ② <li>A. xxx</li> 列表 → 能点，应被点中
 *   ③ 选项挤在一段文本里   → 没有可点元素，应被跳过并计入"无选项"
 * 另外验证：「出答案」算过的答案会被「填涂」复用，不重复请求 AI。
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8091;

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>面板填涂</title></head><body>

<div class="quiz">
  <div class="qbox">
    <div class="stem">1. 下列哪一个是编程语言？</div>
    <div class="opts">
      <label><input type="radio" name="a1" value="0"><span>JavaScript</span></label>
      <label><input type="radio" name="a1" value="1"><span>HTML</span></label>
      <label><input type="radio" name="a1" value="2"><span>CSS</span></label>
    </div>
  </div>
</div>

<div class="quiz2">
  <h2>2. 下面关于浏览器扩展的说法，哪一项是正确的？</h2>
  <ul id="opts2">
    <li onclick="window.__clicks.push('L-A')">A. 扩展的 content script 运行在页面里，可以读写页面 DOM</li>
    <li onclick="window.__clicks.push('L-B')">B. 浏览器扩展无法发起网络请求，只能操作本地存储</li>
    <li onclick="window.__clicks.push('L-C')">C. MV3 的 service worker 是常驻内存的，永远不会被回收</li>
    <li onclick="window.__clicks.push('L-D')">D. content script 只能注入到扩展自己的页面里去</li>
  </ul>
</div>

<div class="quiz3">
  <p>3. 下列说法哪一个是正确的？ A. 甲的说法是对的 B. 乙的说法是对的 C. 丙的说法是对的</p>
</div>

</body></html>`;

const STORAGE = { mode: "ai", aiKey: "x", fuzzyThreshold: 75, interval: "0" };

H.run(async () => {
  const site = await H.serve({ port: PORT, routes: { "/": PAGE } });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const page = await H.newPage(browser, site.url + "/", { aiAnswer: "A", waitFor: null, storage: STORAGE });
  const R = H.Reporter();

  // 先「识别页面题目」
  await page.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
  await H.sleep(1500);

  const scanned = await page.evaluate(() => ({
    panel: !!document.querySelector(".aa-panel"),
    cards: document.querySelectorAll(".aa-card").length,
    hasFillBtn: [...document.querySelectorAll(".aa-panel button")].some(b => b.textContent.includes("填涂")),
    hasAnswerBtn: [...document.querySelectorAll(".aa-panel button")].some(b => b.textContent.includes("出答案")),
    version: document.querySelector(".aa-panel .aa-ver")?.textContent || "",
  }));
  R.t("识别面板已出现", scanned.panel, scanned.panel);
  R.t("识别到 3 道题", scanned.cards === 3, scanned.cards);
  R.t("面板上有独立的「填涂」按钮", scanned.hasFillBtn, scanned.hasFillBtn);
  R.t("原按钮改名为「出答案」，区分只显示与真填涂", scanned.hasAnswerBtn, scanned.hasAnswerBtn);
  R.t("面板显示扩展版本号（用于识别「没重新加载」）", /^vtest$/.test(scanned.version), scanned.version);

  // 点「✍ 填涂」
  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".aa-panel button")].find(b => b.textContent.includes("填涂"));
    if (!btn) return false;
    btn.click();
    return true;
  });
  R.t("成功点到「填涂」按钮", clicked, clicked);

  // 等填涂结束（Node 侧纯 sleep 轮询，别用 waitForFunction）
  let finished = false;
  for (let i = 0; i < 12 && !finished; i++) {
    await H.sleep(1000);
    finished = await page.evaluate(() =>
      /填涂结束/.test(document.querySelector(".aa-panel .aa-info")?.textContent || ""));
  }
  const after = await page.evaluate(() => ({
    msg: document.querySelector(".aa-panel .aa-info")?.textContent || "",
    radio: [...document.querySelectorAll('input[name="a1"]')].map(i => i.checked),
    clicks: window.__clicks,
    cards: [...document.querySelectorAll(".aa-card .aa-answer")].map(a => a.textContent),
    highlighted: [...document.querySelectorAll(".aa-card")].map(c =>
      [...c.querySelectorAll(".aa-opt.on .aa-opt-mark")].map(m => m.textContent)),
  }));

  console.log("面板状态行:", after.msg);
  console.log("卡片反馈:", JSON.stringify(after.cards));

  R.t("填涂流程走到结束", finished, after.msg.slice(0, 40));
  R.t("① radio 组被勾上（选项 A）", after.radio[0] === true && after.radio[1] === false, after.radio);
  R.t("② 列表题的 A 选项被点中", after.clicks.includes("L-A"), after.clicks);
  R.t("答案在卡片选项上高亮（A）",
    after.highlighted.filter(list => list.includes("A")).length >= 1, after.highlighted);
  R.t("③ 挤在一段文本里的题被跳过", /无选项 1/.test(after.msg), after.msg);
  R.t("状态行汇报了成功数", /成功 2/.test(after.msg), after.msg);
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
