/**
 * 真实英语阅读页：1 篇 4 段材料 + 6 道题（含没有提示词的题干）。
 *
 * 页面：tools/extension-test/english-reading.html
 * 公版材料：Alice's Adventures in Wonderland, Chapter I (Project Gutenberg #11)。
 *
 * 断言重点：
 *   · 6 道题都能识别，选项都配上；
 *   · 每道题都挂上完整材料（4 段），包括 Q2/Q3 这种题干里没有 passage/text 的题；
 *   · 不出现「未挂上材料」。
 *
 * 跑法：PLAYWRIGHT_NODE_PATH=... PLAYWRIGHT_BROWSERS_PATH=... node tools/extension-test/english-reading-test.js
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();
const path = require("path");

const PORT = 8108;
const STORAGE = { mode: "bank", fillHosts: "*", showLog: true };

H.run(async () => {
  const site = await H.serve({ port: PORT, staticDir: __dirname, defaultFile: "english-reading.html" });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const page = await H.newPage(browser, site.url + "/english-reading.html", {
    waitFor: ".question", storage: STORAGE,
  });
  const R = H.Reporter();

  await page.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
  await H.sleep(1800);

  const scan = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".aa-card")];
    return {
      cards: cards.length,
      items: cards.map(c => ({
        stem: (c.querySelector(".aa-stem") || {}).textContent || "",
        opts: c.querySelectorAll(".aa-opt").length,
        passageChip: (c.querySelector(".aa-chip-passage") || {}).textContent || "",
        passage: (c.querySelector(".aa-passage") || {}).textContent || "",
        warn: (c.querySelector(".aa-chip-warn") || {}).textContent || "",
      })),
      info: (document.querySelector(".aa-panel .aa-info") || {}).textContent || "",
    };
  });
  console.log("识别结果:", JSON.stringify(scan.items.map(x => ({
    stem: x.stem.slice(0, 70), passageChip: x.passageChip, warn: x.warn,
  })), null, 2));

  R.t("6 道题全部识别", scan.cards === 6, scan.cards);
  R.t("每道题都渲染了 4 个选项",
    scan.items.every(x => x.opts === 4), scan.items.map(x => x.opts));
  R.t("每道题都挂上了材料",
    scan.items.every(x => /📄 材料/.test(x.passageChip)), scan.items.map(x => x.passageChip));
  R.t("材料包含完整的 4 段",
    scan.items.every(x =>
      /Alice was beginning/.test(x.passage) &&
      /So she was considering/.test(x.passage) &&
      /There was nothing/.test(x.passage) &&
      /In another moment/.test(x.passage)),
    scan.items.map(x => x.passage.slice(0, 40)));
  R.t("没有提示词的 Q2（Why does Alice…）也拿到了材料",
    /Why does Alice/.test(scan.items[1] ? scan.items[1].stem : "") && !!scan.items[1].passageChip,
    scan.items[1] && scan.items[1].passageChip);
  R.t("没有提示词的 Q3（Which of the following…）也拿到了材料",
    /Which of the following is true about the White Rabbit/.test(scan.items[2] ? scan.items[2].stem : "") &&
      !!scan.items[2].passageChip,
    scan.items[2] && scan.items[2].passageChip);
  R.t("没有出现「未挂上材料」", scan.items.every(x => !/未挂上材料/.test(x.warn)), scan.items.map(x => x.warn));
  R.t("材料长度超过 1000 字", /📄 材料 \d{4,} 字/.test(scan.items[0] ? scan.items[0].passageChip : ""),
    scan.items[0] && scan.items[0].passageChip);
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
