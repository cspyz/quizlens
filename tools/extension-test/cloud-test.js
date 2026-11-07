/**
 * 已部署站点验证：在真实（线上）页面上跑题库匹配模式，验证三件事：
 *   1) 线上 HTTPS 能不能正常拉到 bank/ 下全部题库（十几 MB，跨网络）
 *   2) 父域白名单能覆盖子域（只填父域时，子域应被放行）
 *   3) 默认卷的题目是否全部命中并勾选
 *
 * 用法：node cloud-test.js <URL> [父域]
 *   例：node cloud-test.js https://example.com/ example.com
 * 需联网，且目标站点已按仓库内容部署。
 */
const fs = require("fs");
const path = require("path");
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const URL = process.argv[2];
if (!URL) {
  console.error("用法：node cloud-test.js <URL> [父域]\n  例：node cloud-test.js https://example.com/ example.com");
  process.exit(1);
}
const PARENT_DOMAIN = process.argv[3] || new URL(URL).hostname;
// 默认卷题数**不写死**：从 quiz-app/questions.json 读实际题数（当前 148）。
// 写死 54 时，卷子一扩充这个测试就红，而那是卷子变大、不是云端坏了。
const EXPECT = (() => {
  try {
    const p = path.join(__dirname, "..", "..", "quiz-app", "questions.json");
    return (JSON.parse(fs.readFileSync(p, "utf8")).questions || []).length || 54;
  } catch (_) { return 54; }
})();

H.run(async () => {
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });

  console.log("目标:", URL);
  const t0 = Date.now();
  const page = await H.newPage(browser, URL);
  console.log(`页面加载完成 ${Date.now() - t0}ms`);

  const t1 = Date.now();
  await H.startAndWait(page, {
    mode: "bank", intervalMs: 80, fuzzyThreshold: 75, fillHosts: PARENT_DOMAIN,
  });
  const elapsed = ((Date.now() - t1) / 1000).toFixed(1);

  const log = await H.readLog(page);
  const answered = await page.evaluate(n =>
    [...document.querySelectorAll(".question")].slice(0, n)
      .filter(q => [...q.querySelectorAll("input")].some(i => i.checked)).length, EXPECT);
  const autoFill = await page.evaluate(() => ({
    logPanel: !!document.querySelector("#aa-log, .aa-runlog"),
    warned: /不在自动填涂白名单/.test(document.querySelector(".aa-warn")?.textContent || ""),
  }));

  console.log("\n--- 云端运行日志 ---\n" + log + "\n");

  const bankLoad = log.match(/大题库：(\d+)\/(\d+)/) || [];
  const total = (log.match(/共 (\d+) 题/) || [])[1];

  const R = H.Reporter();
  // 类别数从**内置** index.json 读（部署的题库应与仓库一致），不再写死 9。
  const expectCats = H.readBundledIndexCount();
  R.t(`云端能拉到全部 ${expectCats} 个题库`,
    bankLoad[1] === String(expectCats) && bankLoad[2] === String(expectCats),
    `${bankLoad[1]}/${bankLoad[2]}（期望 ${expectCats}）`);
  // 总数 = 全部题库 + 页面自带练习卷里"带选项"的题。
  // 下界同样按 index.json 的 count 之和算（留 1% 余量给"题干归一化后为空被跳过"），
  // 这样题库更新后不必回来手工改数字；仍能抓住"只加载了部分类别"这类真故障。
  const minTotal = Math.floor(H.readBundledIndexTotal() * 0.99);
  R.t(`题库总数 ≥ ${minTotal}（按内置 index.json 计）`, Number(total) >= minTotal, total);
  R.t("父域白名单覆盖子域，自动作答已启用",
      autoFill.logPanel && !autoFill.warned, { logPanel: autoFill.logPanel, warned: autoFill.warned });
  R.t(`默认卷 ${EXPECT}/${EXPECT} 命中并勾选`, answered === EXPECT, answered);
  R.t("全程无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  console.log(`（云端跑完耗时 ${elapsed}s）`);
  R.finish();

  await browser.close();
});
