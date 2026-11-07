/**
 * 模糊匹配回归：改了字的题干仍要命中，且选项校验不能把模糊命中拖没。
 * 做法：拿本地练习页，把前 8 题的题干各删掉几个字（模拟 OCR 误差/手抄错字）
 * 再跑题库匹配模式，要求这 8 题全部命中并勾选。
 */
const path = require("path");
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8086;
const QUIZ_DIR = path.join(__dirname, "..", "..", "quiz-app");
const N = 8;

H.run(async () => {
  const site = await H.serve({ port: PORT, staticDir: QUIZ_DIR });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const page = await H.newPage(browser, site.url + "/");

  // 注入后再改题干也可以——content.js 只在收到 START 时才扫描
  const mutated = await page.evaluate(n => {
    const stems = [...document.querySelectorAll(".q-stem")].slice(0, n);
    const out = [];
    stems.forEach((el, i) => {
      const orig = el.textContent.trim();
      // 三种噪声：删中间 3 字 / 去尾 2 字 / 插一个错别字
      let bad;
      if (i % 3 === 0) bad = orig.slice(0, 4) + orig.slice(7);
      else if (i % 3 === 1) bad = orig.slice(0, Math.max(4, orig.length - 2));
      else bad = orig.slice(0, 5) + "啊" + orig.slice(5);
      el.textContent = bad;
      out.push({ orig, bad, changed: bad !== orig });
    });
    return out;
  }, N);

  await H.startAndWait(page, { mode: "bank", intervalMs: 50, fuzzyThreshold: 75, fillHosts: "localhost" });

  const log = await H.readLog(page);
  const answered = await page.evaluate(n =>
    [...document.querySelectorAll(".question")].slice(0, n)
      .filter(q => [...q.querySelectorAll("input")].some(i => i.checked)).length, N);
  const fuzzy = (log.match(/题库·模糊/g) || []).length;

  const R = H.Reporter();
  R.t(`题干都被改动过（${N} 题）`, mutated.every(m => m.changed), mutated.filter(m => m.changed).length);
  R.t(`改字后仍全部命中并勾选（${N}/${N}）`, answered === N, answered);
  R.t("确有走模糊匹配", fuzzy > 0, fuzzy);
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  console.log("改动示例:");
  mutated.slice(0, 3).forEach(m => console.log(`  原: ${m.orig}\n  改: ${m.bad}`));
  R.finish();

  await browser.close();
  await site.close();
});
