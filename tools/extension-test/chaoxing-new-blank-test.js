/**
 * 学习通新版考试的填空 / 简答结构：
 *   .question-item > .question-name + .stem_answer > input / textarea / [contenteditable]
 * 回归点：
 *   ① 单个 input 填空能写入；
 *   ② textarea 简答能写入；
 *   ③ contenteditable（UEditor 内核常见形态）能写入；
 *   ④ 两个 input 的多空填空能分别写入，并显示「2 空」。
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8198;

const q = (n, type, body, extra = "") => `
<div class="question-item ${extra}" data-q="${n}">
  <p class="question-name">${n}. <span class="grey-text">[${type}]</span><span class="html-content-box">第 ${n} 题：请填写答案。</span></p>
  <div class="stem_answer">${body}</div>
</div>`;

const PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>新版填空/简答</title></head>
<body><div class="question-box"><div class="left-question-list">
${q(1, "填空题", '<input type="text" class="blank" name="b1">', "fill-blank")}
${q(2, "简答题", '<textarea class="answer-input" name="a2"></textarea>', "short-answer")}
${q(3, "简答题", '<div class="edui-editor" contenteditable="true" style="min-height:80px"></div>', "short-answer")}
</div></div></body></html>`;

const PAGE_MULTI = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>新版多空填空</title></head>
<body><div class="question-box"><div class="left-question-list">
${q(4, "填空题", '<input type="text" class="blank" name="m1"> <input type="text" class="blank" name="m2">', "fill-blank")}
</div></div></body></html>`;

const STORAGE = { mode: "ai", aiKey: "x", interval: "0", fillHosts: "*" };

H.run(async () => {
  const site = await H.serve({ port: PORT, routes: { "/": PAGE, "/multi": PAGE_MULTI } });
  const browser = await chromium.launch({ headless: true });
  const R = H.Reporter();

  async function scanAndFill(page) {
    await page.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
    await H.sleep(1500);
    const scan = await page.evaluate(() => ({
      cards: [...document.querySelectorAll(".aa-card")].map(c => c.textContent.replace(/\s+/g, " ").trim()),
      chips: [...document.querySelectorAll(".aa-card-tags *")].map(x => x.textContent),
    }));
    await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".aa-panel button")].find(b => b.textContent.includes("填涂"));
      if (btn) btn.click();
    });
    let finished = false;
    for (let i = 0; i < 16 && !finished; i++) {
      await H.sleep(500);
      finished = await page.evaluate(() => /填涂结束/.test(document.querySelector(".aa-info")?.textContent || ""));
    }
    const fill = await page.evaluate(() => ({
      msg: document.querySelector(".aa-info")?.textContent || "",
      values: [...document.querySelectorAll(".question-item")].map(q => ({
        input: [...q.querySelectorAll("input")].map(x => x.value),
        textarea: q.querySelector("textarea")?.value,
        editable: q.querySelector("[contenteditable]")?.textContent,
      })),
    }));
    return { scan, fill, finished };
  }

  const page = await H.newPage(browser, site.url + "/", {
    aiAnswer: "北京", storage: STORAGE, waitFor: ".question-item",
  });
  const one = await scanAndFill(page);
  console.log("单空/简答:", JSON.stringify(one, null, 2));

  R.t("识别到 3 道填空/简答", one.scan.cards.length === 3, one.scan.cards.length);
  R.t("填涂流程走到结束", one.finished, one.fill.msg);
  R.t("input 填空写入「北京」", one.fill.values[0].input[0] === "北京", one.fill.values[0]);
  R.t("textarea 简答写入「北京」", one.fill.values[1].textarea === "北京", one.fill.values[1]);
  R.t("contenteditable 简答写入「北京」", one.fill.values[2].editable === "北京", one.fill.values[2]);
  R.t("汇总成功 3", /成功 3/.test(one.fill.msg), one.fill.msg);
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  const multiPage = await H.newPage(browser, site.url + "/multi", {
    aiAnswer: "北京\n上海", storage: STORAGE, waitFor: ".question-item",
  });
  const multi = await scanAndFill(multiPage);
  console.log("多空:", JSON.stringify(multi, null, 2));

  R.t("多空填空识别为 1 道题", multi.scan.cards.length === 1, multi.scan.cards.length);
  R.t("多空卡片显示「2 空」", multi.scan.chips.some(t => t.includes("2 空")), multi.scan.chips);
  R.t("两个空分别写入北京、上海",
    multi.fill.values[0].input.join(",") === "北京,上海", multi.fill.values[0].input);
  R.t("多空汇总成功 1", /成功 1/.test(multi.fill.msg), multi.fill.msg);
  R.t("多空路径无未捕获异常", multiPage.errors.length === 0, multiPage.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
