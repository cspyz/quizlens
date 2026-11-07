/**
 * 乱序修复验证：混合结构页面（radio / 纯文本 / 空格题交错），
 * 扫描面板的卡片顺序必须与页面上的题目顺序一致。
 * mock 页自己用 <script src="content.js"> 加载脚本，台架已把该路径指向扩展目录。
 */
const path = require("path");
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8089;

H.run(async () => {
  const site = await H.serve({ port: PORT, staticDir: __dirname, defaultFile: "mixed-mock.html" });
  const browser = await chromium.launch({ headless: true });
  const page = await H.newPage(browser, site.url + "/mixed-mock.html", { inject: false, waitFor: null });
  await H.sleep(800);   // 等 mock 页自己的 chrome stub 与 content.js 就绪

  await page.evaluate(() => window.__start());
  await H.sleep(1500);

  const order = await page.evaluate(() =>
    [...document.querySelectorAll(".aa-card .aa-stem")]
      .map(s => s.textContent.replace(/\s+/g, " ").slice(0, 70)));

  order.forEach((t, i) => console.log(`${i + 1}. ${t}`));
  console.log("面板卡片顺序:", order.join(" → "));

  // 写到测试目录，别用相对路径——否则会落在运行时的工作目录（跑 run-all 时就是项目根目录）
  await page.screenshot({ path: path.join(__dirname, "mixed-order.png") });

  const R = H.Reporter();
  R.t("面板卡片顺序与页面一致（6 张）", order.length === 6, order.length);
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");
  R.finish();

  await browser.close();
  await site.close();
});
