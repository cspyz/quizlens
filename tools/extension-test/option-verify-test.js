/**
 * 选项校验测试：同一题干在题库里存在多个版本（选项顺序不同）时，
 * 插件必须按「页面上的选项文本」重新定位答案，而不是照搬题库里的下标。
 *
 * 用例（题干取自真实题库，同一道题在驾考题库和 CMMLU 里选项顺序不同）：
 *   Q1 选项顺序 = 6/12/16/18 个月  → 正确答案"12个月"在下标 1
 *   Q2 选项顺序 = 18/6/12/16 个月  → 正确答案"12个月"在下标 2
 *   Q3 选项换成一堆无关内容        → 选项对不上，应判「未匹配」，绝不能硬填
 */
const path = require("path");
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8083;
const QUIZ_DIR = path.join(__dirname, "..", "..", "quiz-app");
const STEM = "机动车驾驶人初次申领驾驶证后的实习期是多长时间";

function question(qid, stem, opts) {
  return `<div class="question">
    <div class="q-tag">单选</div>
    <div class="q-stem">${stem}</div>
    ${opts.map((o, i) => `<label class="opt">
      <input type="radio" name="q${qid}" value="${i}">
      <span class="opt-text">${String.fromCharCode(65 + i)}. ${o}</span>
    </label>`).join("")}
  </div>`;
}

const MOCK = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>选项校验</title></head><body>
<h1>选项校验测试</h1>
${question(1, STEM, ["6个月", "12个月", "16个月", "18个月"])}
${question(2, STEM, ["18个月", "6个月", "12个月", "16个月"])}
${question(3, STEM, ["甲方案", "乙方案", "丙方案"])}
</body></html>`;

H.run(async () => {
  // 静态根指向 quiz-app（要能取到 bank/ 下的题库），mock 页用路由注入
  const site = await H.serve({ port: PORT, staticDir: QUIZ_DIR, routes: { "/mock.html": MOCK } });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const page = await H.newPage(browser, site.url + "/mock.html");

  await H.startAndWait(page, { mode: "bank", intervalMs: 50, fuzzyThreshold: 75, fillHosts: "localhost" });

  const log = await H.readLog(page);
  const picked = await page.evaluate(() =>
    [...document.querySelectorAll(".question")].map(q => {
      const c = q.querySelector("input:checked");
      return c ? Number(c.value) : -1;
    }));

  console.log("--- 运行日志 ---\n" + log + "\n");

  const R = H.Reporter();
  R.t("Q1 选项顺序 6/12/16/18：12个月在下标 1", picked[0] === 1, picked[0]);
  R.t("Q2 选项顺序 18/6/12/16：12个月在下标 2", picked[1] === 2, picked[1]);
  R.t("Q3 选项对不上：不填涂（未匹配）", picked[2] === -1, picked[2]);
  R.t("Q1/Q2 走题库精确命中", (log.match(/题库·精确/g) || []).length >= 2, (log.match(/题库·精确/g) || []).length);
  R.t("Q3 记录为未匹配", /未匹配/.test(log), /未匹配/.test(log));
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
