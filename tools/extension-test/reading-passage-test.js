/**
 * 英语阅读题组：材料识别（真实浏览器回归）。
 *
 * 过去 findPassage 只认「题干提示词 + 最近的一个 ≥150 字块」：
 *   · 题干没有 the passage / 本文 时，整组都挂不上材料；
 *   · 材料是多段并列的 <p> 时，只拿到最后一段。
 *
 * 本用例覆盖两种常见排版：
 *   ① 整篇材料包在一个 .passage 容器里，后面跟 3 道题（其中一道没有提示词）
 *   ② 材料是三段并列的 <p>，后面跟 2 道题（其中一道没有提示词）
 * 以及 ③ 题干像阅读题但页面没有材料时，题卡要提示「未挂上材料」。
 *
 * 跑法：PLAYWRIGHT_NODE_PATH=... PLAYWRIGHT_BROWSERS_PATH=... node tools/extension-test/reading-passage-test.js
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8107;

const P1 = "Paragraph 1. Many students believe that reading speed is the most important skill in an English exam. In fact, understanding the structure of a passage often matters more than reading every word quickly. A good reader first looks at the title, the first sentence of each paragraph, and the questions before reading the whole text carefully.";
const P2 = "Paragraph 2. When you meet an unfamiliar word, do not stop immediately. Try to guess its meaning from the sentence around it. If the word is not important for the question, you can simply ignore it. This habit keeps your attention on the main idea instead of a single detail.";
const P3 = "Paragraph 3. Finally, practise with a timer. Give yourself a little less time than the real exam allows, and review your wrong answers afterwards. Over several weeks, your speed and accuracy will improve together, and you will feel much more confident in the reading section.";

const OPTIONS = (name) => `
  <div class="opt"><input type="radio" name="${name}"><span class="opt-text">Reading speed is everything</span></div>
  <div class="opt"><input type="radio" name="${name}"><span class="opt-text">Structure and main idea matter</span></div>
  <div class="opt"><input type="radio" name="${name}"><span class="opt-text">Guess every new word</span></div>`;

const WRAPPED_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>阅读-整篇容器</title></head><body>
<div class="reading-set">
  <div class="passage">
    <p>${P1}</p><p>${P2}</p><p>${P3}</p>
  </div>
  <div class="questions">
    <div class="question"><div class="q-stem">1. What is the main idea of the passage?</div>${OPTIONS("q1")}</div>
    <div class="question"><div class="q-stem">2. Why does the author mention guessing unfamiliar words?</div>${OPTIONS("q2")}</div>
    <div class="question"><div class="q-stem">3. Which of the following is true?</div>${OPTIONS("q3")}</div>
  </div>
</div>
</body></html>`;

const SIBLINGS_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>阅读-多段散装</title></head><body>
<div class="reading-set">
  <p>${P1}</p>
  <p>${P2}</p>
  <p>${P3}</p>
  <div class="question"><div class="q-stem">1. What is the main idea of the passage?</div>${OPTIONS("q1")}</div>
  <div class="question"><div class="q-stem">2. Which of the following is true?</div>${OPTIONS("q2")}</div>
</div>
</body></html>`;

const MISSING_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>阅读-无材料</title></head><body>
<div class="question">
  <div class="q-stem">1. What is the main idea of the passage?</div>
  ${OPTIONS("q1")}
</div>
</body></html>`;

const SHORT_PASSAGE = "A short passage about study habits. Reading every day helps you remember new words and understand grammar better. It also makes you more comfortable with long texts. Try to read for twenty minutes each morning, and write down one useful sentence before you stop.";
const SHORT_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>阅读-短材料</title></head><body>
<div class="reading-set">
  <div class="passage"><p>${SHORT_PASSAGE}</p></div>
  <div class="question"><div class="q-stem">1. What is the main idea of the passage?</div>${OPTIONS("q1")}</div>
</div>
</body></html>`;

const STORAGE = { mode: "bank", fillHosts: "*", showLog: true };

async function scan(browser, url) {
  const page = await H.newPage(browser, url, { waitFor: ".question", storage: STORAGE });
  await page.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
  await H.sleep(1500);
  const cards = await page.evaluate(() => [...document.querySelectorAll(".aa-card")].map(c => ({
    stem: (c.querySelector(".aa-stem") || {}).textContent || "",
    passageChip: (c.querySelector(".aa-chip-passage") || {}).textContent || "",
    passage: (c.querySelector(".aa-passage") || {}).textContent || "",
    warn: (c.querySelector(".aa-chip-warn") || {}).textContent || "",
  })));
  const errors = page.errors.slice();
  await page.close();
  return { cards, errors };
}

H.run(async () => {
  const site = await H.serve({
    port: PORT,
    routes: {
      "/wrapped.html": WRAPPED_PAGE,
      "/siblings.html": SIBLINGS_PAGE,
      "/missing.html": MISSING_PAGE,
      "/short.html": SHORT_PAGE,
    },
  });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const R = H.Reporter();

  // ---------- ① 整篇材料包在一个容器里 ----------
  {
    const { cards, errors } = await scan(browser, site.url + "/wrapped.html");
    console.log("① wrapped:", JSON.stringify(cards, null, 2));
    R.t("① 三道题都识别出来", cards.length === 3, cards.length);
    R.t("① 三道题都挂上了材料", cards.filter(c => c.passageChip).length === 3, cards.map(c => c.passageChip));
    R.t("① 没有提示词的 Q3 也拿到了材料", /Which of the following/.test(cards[2] ? cards[2].stem : "") && !!cards[2].passageChip, cards[2] && cards[2].passageChip);
    R.t("① 材料是完整的三段，不只最后一段",
      cards.every(c => /Paragraph 1/.test(c.passage) && /Paragraph 2/.test(c.passage) && /Paragraph 3/.test(c.passage)),
      cards.map(c => c.passage.slice(0, 60)));
    R.t("① 整篇容器里的段落保留换行", /\nParagraph 2/.test(cards[0] ? cards[0].passage : ""),
      cards[0] ? cards[0].passage.slice(0, 220) : "");
    R.t("① 无未捕获异常", errors.length === 0, errors.join(" | ") || "(无)");
  }

  // ---------- ② 材料是三段并列的 <p> ----------
  {
    const { cards, errors } = await scan(browser, site.url + "/siblings.html");
    console.log("② siblings:", JSON.stringify(cards, null, 2));
    R.t("② 两道题都识别出来", cards.length === 2, cards.length);
    R.t("② 两道题都挂上了材料", cards.filter(c => c.passageChip).length === 2, cards.map(c => c.passageChip));
    R.t("② 没有提示词的 Q2 也拿到了材料", /is true/.test(cards[1] ? cards[1].stem : "") && !!cards[1].passageChip, cards[1] && cards[1].passageChip);
    R.t("② 三段都拼进材料，不只最近一段",
      cards.every(c => /Paragraph 1/.test(c.passage) && /Paragraph 2/.test(c.passage) && /Paragraph 3/.test(c.passage)),
      cards.map(c => c.passage.slice(0, 60)));
    R.t("② 材料没有把题目本身吞进去", cards.every(c => !/What is the main idea/.test(c.passage) && !/Which of the following/.test(c.passage)), cards.map(c => c.passage.slice(-60)));
    R.t("② 无未捕获异常", errors.length === 0, errors.join(" | ") || "(无)");
  }

  // ---------- ③ 阅读题但页面没有材料：要提示 ----------
  {
    const { cards, errors } = await scan(browser, site.url + "/missing.html");
    console.log("③ missing:", JSON.stringify(cards, null, 2));
    R.t("③ 题目仍然被识别", cards.length === 1, cards.length);
    R.t("③ 题卡显示「未挂上材料」", /未挂上材料/.test(cards[0] ? cards[0].warn : ""), cards[0] && cards[0].warn);
    R.t("③ 无未捕获异常", errors.length === 0, errors.join(" | ") || "(无)");
  }

  // ---------- ④ 短材料：不显示「材料 N 字」，按普通题样式 ----------
  {
    const { cards, errors } = await scan(browser, site.url + "/short.html");
    console.log("④ short:", JSON.stringify(cards, null, 2));
    R.t("④ 题目仍然被识别", cards.length === 1, cards.length);
    R.t("④ 短材料不显示字数标签", cards[0] && !cards[0].passageChip, cards[0] && cards[0].passageChip);
    R.t("④ 也不误报「未挂上材料」", !/未挂上材料/.test(cards[0] ? cards[0].warn : ""), cards[0] && cards[0].warn);
    R.t("④ 无未捕获异常", errors.length === 0, errors.join(" | ") || "(无)");
  }

  R.finish();
  await browser.close();
  await site.close();
});
