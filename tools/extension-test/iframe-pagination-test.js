/**
 * 同源 iframe 内自动翻页（真实浏览器回归）。
 *
 * 学习通考试/作业常见结构：题目和「下一题」按钮都在内容 iframe 里。
 * 修复前 findNextPageButton 只查顶层 document → 点不到 iframe 里的按钮，
 * run() 答完第 1 页就停，汇总也不会出现「共 2 页」。
 *
 * 跑法：PLAYWRIGHT_NODE_PATH=... PLAYWRIGHT_BROWSERS_PATH=... node tools/extension-test/iframe-pagination-test.js
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8106;

const QUIZ_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>翻页练习</title></head>
<body>
<div id="stage"></div>
<script>
window.__pg = { clicks: [], page: 1 };
var stage = document.getElementById("stage");

function qHtml(n, stem) {
  return '<div class="singleQuesId" data="q' + n + '">' +
    '<div class="font-cxsecret">' + n + '.[单选题]' + stem + '</div>' +
    '<div class="stem_answer">' +
      '<div class="answerBg"><span class="num_option" data="A">A</span><span class="answer_p">选项 A</span></div>' +
      '<div class="answerBg"><span class="num_option" data="B">B</span><span class="answer_p">选项 B</span></div>' +
      '<div class="answerBg"><span class="num_option" data="C">C</span><span class="answer_p">选项 C</span></div>' +
      '<div class="answerBg"><span class="num_option" data="D">D</span><span class="answer_p">选项 D</span></div>' +
    '</div>' +
    (n === 1 ? '<button id="nextBtn">下一题</button>' : '') +
  '</div>';
}

function bind() {
  document.querySelectorAll(".answerBg").forEach(function (bg) {
    bg.addEventListener("click", function () {
      var box = bg.closest(".singleQuesId");
      box.querySelectorAll(".answerBg").forEach(function (x) {
        x.classList.remove("choose");
        x.querySelectorAll(".checkanswer").forEach(function (n) { n.remove(); });
      });
      bg.classList.add("choose");
      var mark = document.createElement("span");
      mark.className = "checkanswer";
      mark.textContent = "✓";
      bg.appendChild(mark);
      window.__pg.clicks.push(bg.querySelector(".num_option").textContent.trim());
    });
  });
  var next = document.getElementById("nextBtn");
  if (next) next.addEventListener("click", function () {
    if (window.__pg.page !== 1) return;
    window.__pg.page = 2;
    stage.innerHTML = qHtml(2, "第二页的题目：以下哪个是编程语言？");
    bind();
  });
}

stage.innerHTML = qHtml(1, "第一页的题目：以下哪个是数据库？");
bind();
</script>
</body></html>`;

const TOP_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>考试外壳</title></head>
<body><p>课程外壳</p><iframe id="contentFrame" src="/quiz.html" style="width:900px;height:700px;border:0"></iframe></body></html>`;

const STORAGE = { mode: "ai", aiKey: "sk-test", interval: "0", fillHosts: "*", showLog: true };

H.run(async () => {
  const site = await H.serve({ port: PORT, routes: { "/": TOP_PAGE, "/quiz.html": QUIZ_PAGE } });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const page = await H.newPage(browser, site.url + "/", { aiAnswer: "A", waitFor: "#contentFrame", storage: STORAGE });
  const R = H.Reporter();

  await page.waitForFunction(() => {
    const f = document.querySelector("#contentFrame");
    return !!(f && f.contentDocument && f.contentDocument.querySelector(".singleQuesId"));
  }, { timeout: 15000 }).catch(() => {});

  await page.evaluate(() => window.__aaListener({
    type: "START",
    settings: {
      mode: "ai", aiKey: "sk-test", aiModel: "mock", intervalMs: 0,
      showLog: true, fillHosts: "*", answerMode: "standard",
    },
  }));

  let log = "";
  let finished = false;
  for (let i = 0; i < 80; i++) {
    await H.sleep(250);
    log = await page.evaluate(() =>
      (document.querySelector(".aa-runlog") || document.querySelector("#aa-log") || {}).textContent || "");
    if (/完成：/.test(log)) { finished = true; break; }
  }

  const after = await page.evaluate(() => {
    const w = document.querySelector("#contentFrame").contentWindow;
    return {
      clicks: w.__pg.clicks,
      page: w.__pg.page,
      cards: document.querySelectorAll(".aa-card").length,
      cardStems: [...document.querySelectorAll(".aa-card .aa-stem")].map(e => e.textContent).join(" | "),
      log: (document.querySelector(".aa-runlog") || document.querySelector("#aa-log") || {}).textContent || "",
    };
  });
  console.log("翻页结果:", JSON.stringify(after));

  R.t("run() 完整跑完", finished, finished ? "完成" : "超时");
  R.t("iframe 内第 1 页的题被答上", after.clicks[0] === "A", after.clicks);
  R.t("iframe 内的「下一题」被点到，进入第 2 页", after.page === 2, after.page);
  R.t("iframe 内第 2 页的题也被答上", after.clicks[1] === "A", after.clicks);
  R.t("日志显示自动翻到了第 2 页", /第 1 页完成，自动进入下一页/.test(after.log), after.log.slice(-160));
  R.t("翻页后面板题卡刷新到第 2 页", /第二页/.test(after.cardStems) && !/第一页/.test(after.cardStems), after.cardStems);
  R.t("汇总里是「共 2 页」", /共 2 页/.test(after.log), after.log.slice(-160));
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
