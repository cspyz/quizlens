/**
 * 回归测试：
 * 1) 本地练习页（quiz-app，.question 结构）题库匹配模式不受改造影响
 * 2) 白名单外页面正确降级为「只显示答案」扫描面板
 */
const path = require("path");
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8082;
const QUIZ_DIR = path.join(__dirname, "..", "..", "quiz-app");

H.run(async () => {
  const site = await H.serve({ port: PORT, staticDir: QUIZ_DIR });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const page = await H.newPage(browser, site.url + "/");
  const R = H.Reporter();

  // ============ 测试 1：本地页 + 题库匹配 ============
  await H.startAndWait(page, { mode: "bank", intervalMs: 100, fuzzyThreshold: 75, fillHosts: "localhost" });

  const log = await H.readLog(page);
  const r1 = await page.evaluate(() => ({
    questions: document.querySelectorAll(".question").length,
    checked: [...document.querySelectorAll(".question input")].filter(i => i.checked).length,
    // 带选项的题（选择题/判断题/多选题）——题库里这类题必须全部命中
    choiceCount: [...document.querySelectorAll(".question")].filter(d => d.querySelector(".opt input")).length,
    // 填空题（有 .blank-input，没有选项）
    blankCount: [...document.querySelectorAll(".question")].filter(d => d.querySelector(".blank-input")).length,
    // 多选题一题会勾多个选项，所以看"每题至少一个选中"
    perQ: [...document.querySelectorAll(".question")]
      .filter(q => [...q.querySelectorAll("input")].some(i => i.checked)).length,
  }));
  const bankHit = Number((log.match(/题库命中 (\d+)/) || [])[1]);

  console.log("--- 测试1：本地页题库匹配 ---");
  console.log("完整日志：\n" + log);
  console.log(`总题数: ${r1.questions}, 带选项的题: ${r1.choiceCount}, 填空题: ${r1.blankCount}, 题库命中: ${bankHit}, 已勾选: ${r1.checked}`);
  // 口径说明：题库命中数现在包含**填空题**（题库已支持存填空题，命中后直接写文本）。
  // 所以不能再拿 bankHit 和 choiceCount 直接比大小 —— 命中数会等于
  // 「带选项的题 + 题库里收录了的填空题」。这里改成：
  //   ① 带选项的题必须全部勾上（这是原来的核心保证）
  //   ② 题库命中数不得少于带选项的题数（多出来的只能是填空题命中）
  R.t(`本地页带选项的题全部命中并勾选（${r1.choiceCount}/${r1.choiceCount}）`,
      bankHit >= r1.choiceCount && r1.perQ >= r1.choiceCount && r1.choiceCount > 0,
      { bankHit, perQ: r1.perQ, choiceCount: r1.choiceCount, blankCount: r1.blankCount });

  // ============ 测试 2：白名单外降级 ============
  await page.evaluate(() => window.__aaListener({
    type: "START",
    settings: { mode: "bank", intervalMs: 100, fuzzyThreshold: 75, fillHosts: "not-this-host.example" },
  }));
  await H.sleep(1000);
  const r2 = await page.evaluate(() => ({
    scanPanel: !!document.querySelector(".aa-panel"),
    warn: document.querySelector(".aa-warn")?.textContent || "",
    scanCards: document.querySelectorAll(".aa-card").length,
  }));
  console.log("\n--- 测试2：白名单外降级 ---");
  console.log(`扫描面板: ${r2.scanPanel}, 识别卡片: ${r2.scanCards}`);
  console.log(`提示文案: ${r2.warn}`);
  R.t("白名单外正确降级并提示加白名单",
      r2.scanPanel && /白名单/.test(r2.warn) && /localhost/.test(r2.warn), r2.warn.slice(0, 50));
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
