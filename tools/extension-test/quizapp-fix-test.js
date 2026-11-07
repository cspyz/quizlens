/**
 * quiz-app 页面修复验证：
 *  1) 题干/选项里的 < > 被转义，不再当 HTML 解析（题库里有 1900+ 题含 "<"）
 *  2) 抽题限时按题量算，不再一律 25 分钟
 *  3) 脏数据（缺 answer）不会让判分整体崩掉
 *  4) 题库下拉是从 bank/index.json 动态读的（新增题库会自动出现）
 *
 * 本文件保留自己的 HTTP 服务：第 4 项需要在运行中途替换 /bank/index.json 路由，
 * 台架的 routes 是启动时固定的。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const QUIZ_DIR = path.join(__dirname, "..", "..", "quiz-app");
const PORT = 8085;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".json": "application/json" };
let indexOverride = null;

const server = http.createServer((req, res) => {
  const url = req.url.split("?")[0];
  // 测试 4 用：临时替换题库清单，验证下拉是数据驱动的
  if (url === "/bank/index.json" && indexOverride) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(indexOverride));
    return;
  }
  const file = path.join(QUIZ_DIR, url === "/" ? "index.html" : url);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "text/plain" });
    res.end(data);
  });
});

(async () => {
  await new Promise(r => server.listen(PORT, r));
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(e.message));

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForSelector(".question");

  const R = H.Reporter();
  const t = R.t;

  // ---- 1) 转义 ----
  const esc = await page.evaluate(() => {
    window.renderExam([{
      id: 1, type: "single",
      question: "题干里有 <b>粗体</b> 和 <script>alert(1)</script>",
      options: ["<i>选项一</i>", "a < b 的写法"],
      answer: [0]
    }], "转义测试", 5);
    const stem = document.querySelector(".q-stem");
    const opt = document.querySelector(".opt-text");
    return {
      stemChildren: stem.childElementCount,
      stemText: stem.textContent,
      optChildren: opt.childElementCount,
      optText: opt.textContent,
      scripts: document.querySelectorAll(".question script").length,
      bolds: document.querySelectorAll(".question b").length
    };
  });
  t("题干按纯文本渲染（无子元素）", esc.stemChildren === 0, esc.stemChildren);
  t("题干内容可见", esc.stemText.includes("<b>粗体</b>"), esc.stemText.slice(0, 40));
  t("未注入 script 标签", esc.scripts === 0 && esc.bolds === 0, `${esc.scripts}/${esc.bolds}`);
  t("选项按纯文本渲染", esc.optChildren === 0, esc.optChildren);

  // ---- 2) 限时按题量 ----
  async function draw(file, n) {
    await page.selectOption("#bankSel", file);
    await page.fill("#bankCount", String(n));
    await page.click("#drawBtn");
    await page.waitForFunction(() => {
      const s = document.querySelector("#bankStatus");
      return s && /限时/.test(s.textContent);
    }, { timeout: 30000 });
    return page.evaluate(() => document.querySelector("#bankStatus").textContent);
  }
  const s20 = await draw("09_primary.json", 20);
  const s100 = await draw("09_primary.json", 100);
  t("抽 20 题 → 限时 15 分钟", /限时 15 分钟/.test(s20), s20);
  t("抽 100 题 → 限时 75 分钟", /限时 75 分钟/.test(s100), s100);

  // ---- 3) 脏数据不崩 ----
  const dirty = await page.evaluate(() => {
    window.renderExam([
      { id: 1, type: "single", question: "正常题", options: ["甲", "乙"], answer: [1] },
      { id: 2, type: "single", question: "缺答案的脏数据", options: ["甲", "乙"] }
    ], "脏数据测试", 5);
    document.querySelectorAll(".question input")[0].checked = true;  // 第 1 题选甲（错）
    document.querySelectorAll(".question input")[2].checked = true;  // 第 2 题随便选一个
    try {
      window.submit();
      return { ok: true, detail: document.querySelector("#resultDetail").textContent };
    } catch (e) {
      return { ok: false, err: e.message };
    }
  });
  t("缺 answer 的题不中断判分", dirty.ok, dirty.err || dirty.detail);

  // ---- 4) 题库下拉是数据驱动的（新增题库会自动出现，不再需要改代码）----
  indexOverride = [
    { file: "09_primary.json", label: "小学语数英 1-6 年级", count: 1297 },
    { file: "10_newbank.json", label: "新加的题库", count: 42 }
  ];
  const p2 = await browser.newPage();
  await p2.goto(`http://localhost:${PORT}/`);
  await H.sleep(2500);   // Node 侧纯 sleep，见 headless 下页面 JS 冻结的踩坑
  const opts = await p2.evaluate(() =>
    [...document.querySelectorAll("#bankSel option")].map(o => ({ v: o.value, t: o.textContent }))
  );
  console.log("\n下拉选项:", JSON.stringify(opts));
  t("下拉从 index.json 动态生成", opts.length >= 3, opts.length);
  t("清单里新增的题库自动出现", opts.some(o => o.v === "10_newbank.json"), opts.map(o => o.v));
  t("选项文案带题量", opts.some(o => /新加的题库 · 42 题/.test(o.t)), opts.map(o => o.t));
  await p2.close();
  indexOverride = null;

  t("全程无未捕获异常", pageErrors.length === 0, pageErrors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  server.close();
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
