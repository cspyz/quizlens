/**
 * 句子改写 / 改错题（自由文本作答）真实浏览器回归。
 *
 * 页面：tools/extension-test/english-reading-2.html
 *   A/B 阅读选择题 12 道 + C 句子改写 10 道 + D 改错 6 道。
 *   C/D 没有 A/B/C/D 选项，而是 text input.answer-input + 占位符
 *   “Write the full sentence…” / “Corrected sentence…”。
 *
 * 旧行为：只把第一道句改（题干带 ___）识别成填空，其余只当成纯文本题，
 * 向 AI 要选项字母 → “AI 没解析出选项字母（回复格式不符合要求）”。
 *
 * 断言重点：
 *   · C/D 各一张卡，不重复、不丢；卡片标注「改写 / 改错」；
 *   · 点「答」显示完整句子（不是选项字母错误）；
 *   · 「填涂」写进对应 input；
 *   · 失败卡状态是「未匹配」，不是「已作答」。
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();
const path = require("path");

const PORT = 8133;
const SENTENCE = "The bridge was destroyed by the storm.";
const STORAGE = { mode: "ai", aiKey: "sk-test", interval: "0", answerMode: "standard", showLog: true };

H.run(async () => {
  const site = await H.serve({
    port: PORT,
    staticDir: __dirname,
    defaultFile: "english-reading-2.html",
  });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const page = await H.newPage(browser, site.url + "/english-reading-2.html", {
    waitFor: ".drill-item",
    storage: STORAGE,
    aiAnswer: SENTENCE + "\n\n解析：改为被动语态。",
  });
  const R = H.Reporter();

  await page.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
  await H.sleep(1600);

  const scan = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".aa-card")];
    const info = c => ({
      stem: (c.querySelector(".aa-stem") || {}).textContent || "",
      chips: [...c.querySelectorAll(".aa-card-tags .aa-chip")].map(x => x.textContent),
      opts: c.querySelectorAll(".aa-opt").length,
    });
    const all = cards.map(info);
    const first = all.filter(x => /The storm destroyed the bridge/.test(x.stem));
    return {
      total: cards.length,
      drills: all.filter(x => x.chips.some(t => /改写|改错|简答/.test(t))).length,
      rewrites: all.filter(x => x.chips.includes("改写")).length,
      corrections: all.filter(x => x.chips.includes("改错")).length,
      firstC: first,
      answerInputs: document.querySelectorAll(".answer-input").length,
    };
  });
  console.log("扫描:", JSON.stringify(scan, null, 2));

  R.t("页面共 28 道题（12 阅读 + 10 句改 + 6 改错）", scan.total === 28, scan.total);
  R.t("10 道句改卡标注「改写」", scan.rewrites === 10, scan.rewrites);
  R.t("6 道改错卡标注「改错」", scan.corrections === 6, scan.corrections);
  R.t("第一道句改只有一张卡（原句 + 改写要求不再拆成两张）",
    scan.firstC.length === 1 && /改为被动语态/.test(scan.firstC[0].stem), scan.firstC);
  R.t("自由文本题没有 A/B/C/D 选项", scan.firstC[0] && scan.firstC[0].opts === 0, scan.firstC[0] && scan.firstC[0].opts);
  R.t("页面上有 16 个自由文本输入框", scan.answerInputs === 16, scan.answerInputs);

  // 单题「答」：应显示完整句子，而不是选项字母错误
  await page.evaluate(() => {
    const c = [...document.querySelectorAll(".aa-card")].find(x =>
      /The storm destroyed the bridge/.test((x.querySelector(".aa-stem") || {}).textContent || ""));
    const btn = c && [...c.querySelectorAll("button")].find(b => b.textContent.trim() === "答");
    if (btn) btn.click();
  });
  await H.sleep(1600);
  const one = await page.evaluate(() => {
    const c = [...document.querySelectorAll(".aa-card")].find(x =>
      /The storm destroyed the bridge/.test((x.querySelector(".aa-stem") || {}).textContent || ""));
    return c ? {
      answer: (c.querySelector(".aa-answer") || {}).textContent || "",
      state: (c.querySelector(".aa-card-state") || {}).textContent || "",
    } : null;
  });
  console.log("单题:", JSON.stringify(one));
  R.t("单题「答」显示完整改写句", !!one && one.answer.includes("The bridge was destroyed by the storm."), one && one.answer);
  R.t("单题「答」不再报「没解析出选项字母」", !!one && !/没解析出选项字母/.test(one.answer), one && one.answer);
  R.t("单题作答状态为「已作答」", one && one.state === "已作答", one && one.state);

  // 「填涂」：16 个自由文本输入框都应写入（AI stub 对所有题都回同一句）
  await page.evaluate(() => {
    const b = [...document.querySelectorAll(".aa-panel button")].find(x => /填涂/.test(x.textContent));
    if (b) b.click();
  });
  let finished = false;
  for (let i = 0; i < 80 && !finished; i++) {
    await H.sleep(500);
    finished = await page.evaluate(() =>
      /填涂结束/.test((document.querySelector(".aa-panel .aa-info") || {}).textContent || ""));
  }
  const after = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".aa-card")];
    const drill = cards.filter(c => [...c.querySelectorAll(".aa-chip")].some(x => /改写|改错/.test(x.textContent)));
    const choice = cards.filter(c => c.querySelectorAll(".aa-opt").length > 0);
    return {
      msg: (document.querySelector(".aa-panel .aa-info") || {}).textContent || "",
      values: [...document.querySelectorAll(".answer-input")].map(i => i.value),
      drillBad: drill.filter(c => /没解析出选项字母/.test((c.querySelector(".aa-answer") || {}).textContent || "")).length,
      choiceStates: choice.map(c => (c.querySelector(".aa-card-state") || {}).textContent || ""),
      firstCState: (drill[0] && drill[0].querySelector(".aa-card-state") || {}).textContent || "",
    };
  });
  console.log("填涂后:", JSON.stringify(after, null, 2));
  R.t("填涂流程走到结束", finished, after.msg.slice(0, 50));
  R.t("填涂汇总成功 16 道（句改 + 改错）", /成功 16/.test(after.msg), after.msg);
  R.t("16 个自由文本输入框都写入了改写句",
    after.values.length === 16 && after.values.every(v => v.includes("The bridge was destroyed by the storm.")),
    after.values.slice(0, 4));
  R.t("句改/改错卡不再出现「没解析出选项字母」", after.drillBad === 0, after.drillBad);
  R.t("句改卡状态为「已填涂」", after.firstCState === "已填涂", after.firstCState);
  R.t("选择题未命中时状态为「未匹配」而不是「已作答」",
    after.choiceStates.every(s => s === "未匹配"), after.choiceStates);
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  // ---- 自动「开始答题」路径：getQuestionBlocks 只有阅读题，必须补上 C/D 自由文本题 ----
  const page2 = await H.newPage(browser, site.url + "/english-reading-2.html", {
    waitFor: ".drill-item", storage: STORAGE,
    aiAnswer: SENTENCE + "\n\n解析：改为被动语态。",
  });
  await page2.evaluate(s => window.__aaListener({ type: "START", settings: s }), {
    ...STORAGE, intervalMs: 0, concurrency: 1, concurrentEnabled: false,
    fuzzyThreshold: 75, showLog: true,
  });
  const finished2 = await H.waitForFinish(page2, { tries: 20, step: 1000 });
  const runInfo = await page2.evaluate(() => ({
    log: (document.querySelector(".aa-runlog") || {}).textContent || "",
    values: [...document.querySelectorAll(".answer-input")].map(i => i.value),
  }));
  R.t("自动答题跑完", finished2, runInfo.log.match(/完成：[^\n]*/)?.[0] || "");
  R.t("自动答题识别到 28 道题（阅读 + 句改 + 改错）",
    /页面识别到 28 道题（题卡结构 \+ 改写\/简答题）/.test(runInfo.log), runInfo.log.match(/页面识别到[^\n]*/)?.[0] || "");
  R.t("自动答题把 16 个句改/改错输入框写入",
    runInfo.values.length === 16 && runInfo.values.every(v => v.includes("The bridge was destroyed by the storm.")),
    runInfo.values.slice(0, 4));

  R.finish();
  await browser.close();
  await site.close();
});
