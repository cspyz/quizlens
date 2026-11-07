/**
 * 同源 iframe + 学习通随堂练习识别（真实浏览器回归）。
 *
 * 用户实测：学习通课程页的题目在内容 iframe 里，插件面板注入在顶层，
 * 扫描器只查顶层 document → 面板显示「没有识别到题目」。
 *
 * 本用例覆盖：
 *   ① 同源 iframe 里的题能被识别（选择题 + 填空题）
 *   ② 学习通新版选项（.answerBg + span.num_option，没有 radio、字母与文字分处两个 span）
 *      能配上选项，并且「填涂」真的点中 iframe 里的选项
 *   ③ 同源 iframe 里的填空能写进去（原生 setter / Event 必须用子文档 realm）
 *   ④ 跨域 iframe 读不到时，空态要给出可操作的提示，而不是一句「可能没加载完」
 *
 * 跑法：PLAYWRIGHT_NODE_PATH=... PLAYWRIGHT_BROWSERS_PATH=... node tools/extension-test/iframe-chaoxing-test.js
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8104;

const IMG_1PX = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nL8AAAAASUVORK5CYII=";

const CHAOXING_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>随堂练习</title></head>
<body>
<div class="singleQuesId" data="q1">
  <div class="question-title"><span class="mark_name">1.[单选题](选择题)查询 xs 数据表中的所有数据，并按成绩降序排列（ ）<img alt="材料图" src="${IMG_1PX}" style="width:200px;height:100px"></span></div>
  <div class="stem_answer">
    <div class="answerBg"><span class="num_option" data="A">A</span><span class="answer_p">select * from xs order by MySQL成绩 desc;</span></div>
    <div class="answerBg"><span class="num_option" data="B">B</span><span class="answer_p">select * from xs order by MySQL成绩 asc;</span></div>
    <div class="answerBg"><span class="num_option" data="C">C</span><span class="answer_p">select * from xs group by MySQL成绩 desc;</span></div>
    <div class="answerBg"><span class="num_option" data="D">D</span><span class="answer_p">select * from xs MySQL成绩 order by;</span></div>
  </div>
</div>
<div class="question-item" data="q2">
  <div class="question-title">2.[单选题](选择题)按照年龄降序排列（ ）<img alt="题型图标" src="${IMG_1PX}" style="width:24px;height:24px"></div>
  <div class="stem_answer">
    <div class="answerBg"><span class="num_option" data="A">A</span><span class="answer_p">ORDER BY DESC age</span></div>
    <div class="answerBg"><span class="num_option" data="B">B</span><span class="answer_p">ORDER BY age DESC</span></div>
    <div class="answerBg"><span class="num_option" data="C">C</span><span class="answer_p">ORDER BY age ASC</span></div>
    <div class="answerBg"><span class="num_option" data="D">D</span><span class="answer_p">ASC 是降序排列</span></div>
  </div>
</div>
<div class="singleQuesId" data="q3">
  <div class="question-title"><span class="mark_name">3.[填空题]ORDER BY 子句在 SELECT 语句中所起的作用是 ____ 。</span></div>
  <div class="stem_answer"><textarea class="blank" name="answer3"></textarea></div>
</div>
<script>
window.__cx = { clicks: [] };
document.querySelectorAll(".answerBg").forEach(function (bg) {
  bg.addEventListener("click", function () {
    var box = bg.closest(".singleQuesId, .question-item, .top-question") || bg.parentElement;
    box.querySelectorAll(".answerBg").forEach(function (x) {
      x.classList.remove("choose");
      x.querySelectorAll(".checkanswer").forEach(function (n) { n.remove(); });
    });
    bg.classList.add("choose");
    var mark = document.createElement("span");
    mark.className = "checkanswer";
    mark.textContent = "✓";
    bg.appendChild(mark);
    window.__cx.clicks.push(bg.querySelector(".num_option").textContent.trim());
  });
});
</script>
</body></html>`;

const TOP_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>课程</title></head>
<body>
<div class="shell">
  <aside>课程门户 数据库技术与应用 任务 章节 讨论 作业 考试</aside>
  <main><iframe id="contentFrame" src="/chaoxing.html" style="width:900px;height:700px;border:0"></iframe></main>
</div>
</body></html>`;

const CROSS_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>跨域</title></head>
<body>
<p>课程外壳</p>
<iframe id="crossFrame" src="http://127.0.0.1:${PORT}/chaoxing.html" style="width:900px;height:700px;border:0"></iframe>
</body></html>`;

const STORAGE = { mode: "ai", aiKey: "sk-test", interval: "0", fillHosts: "*" };

H.run(async () => {
  const site = await H.serve({
    port: PORT,
    routes: { "/": TOP_PAGE, "/chaoxing.html": CHAOXING_PAGE, "/cross.html": CROSS_PAGE },
  });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const R = H.Reporter();

  // ---------- ① ~ ③ 同源 iframe ----------
  {
    const page = await H.newPage(browser, site.url + "/", { aiAnswer: "A", waitFor: "#contentFrame", storage: STORAGE });
    await page.waitForFunction(() => {
      const f = document.querySelector("#contentFrame");
      return !!(f && f.contentDocument && f.contentDocument.querySelector(".singleQuesId"));
    }, { timeout: 15000 }).catch(() => {});
    await page.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
    await H.sleep(1800);

    // 记录发给 AI 的 payload：用来验证 .answer_p 的正文没有被剥掉首字母
    await page.evaluate(() => {
      const orig = window.chrome.runtime.sendMessage;
      window.__aiPayloads = [];
      window.chrome.runtime.sendMessage = async msg => {
        if (msg && (msg.type === "AI_CHAT" || msg.type === "TEXT_CHAT")) window.__aiPayloads.push(msg.payload);
        return orig(msg);
      };
    });

    const scan = await page.evaluate(() => {
      const panel = document.querySelector(".aa-panel");
      const cards = [...document.querySelectorAll(".aa-card")];
      return {
        panel: !!panel,
        cards: cards.length,
        stems: cards.map(c => (c.querySelector(".aa-stem") || {}).textContent || ""),
        opts: cards.map(c => c.querySelectorAll(".aa-opt").length),
        chips: cards.map(c => [...c.querySelectorAll(".aa-chip")].map(x => x.textContent)),
        warns: cards.map(c => {
          const w = c.querySelector(".aa-chip-warn");
          return w ? { text: w.textContent || "", title: w.title || "" } : null;
        }).filter(Boolean),
        info: (document.querySelector(".aa-panel .aa-info") || {}).textContent || "",
        empty: (document.querySelector(".aa-panel .aa-empty") || {}).textContent || "",
      };
    });
    console.log("扫描结果:", JSON.stringify(scan));

    R.t("① 同源 iframe 内的题被识别（3 道）", scan.cards === 3, scan.cards);
    R.t("① 两道选择题都渲染了 4 个选项", scan.opts.filter(n => n === 4).length === 2, scan.opts);
    R.t("① 填空题被识别为「填空」", scan.chips.some(list => list.includes("填空")), scan.chips);
    R.t("① 不再显示「没有识别到题目」", !/没有识别到题目/.test(scan.empty), scan.empty.slice(0, 40));
    R.t("① 含图片材料的题卡显示警告", scan.warns.length === 1 && /含图片材料/.test(scan.warns[0].text), scan.warns);
    R.t("① 24×24 的题型小图标不触发图片警告", scan.warns.length === 1, scan.warns);
    R.t("① 警告提示用截图解题", /截图/.test((scan.warns[0] && scan.warns[0].title) || ""),
      scan.warns[0] && scan.warns[0].title);

    // 「填涂」把答案真正点到 iframe 里
    const clicked = await page.evaluate(() => {
      const btn = [...document.querySelectorAll(".aa-panel button")].find(b => b.textContent.includes("填涂"));
      if (!btn) return false;
      btn.click();
      return true;
    });
    R.t("② 找到并点击「填涂」", clicked, clicked);

    let finished = false;
    for (let i = 0; i < 15 && !finished; i++) {
      await H.sleep(1000);
      finished = await page.evaluate(() =>
        /填涂结束/.test((document.querySelector(".aa-panel .aa-info") || {}).textContent || ""));
    }
    const after = await page.evaluate(() => {
      const w = document.querySelector("#contentFrame").contentWindow;
      return {
        msg: (document.querySelector(".aa-panel .aa-info") || {}).textContent || "",
        clicks: (w.__cx && w.__cx.clicks) || [],
        selected: w.document.querySelectorAll(".answerBg.choose").length,
        blank: (w.document.querySelector("textarea.blank") || {}).value || "",
        cards: [...document.querySelectorAll(".aa-card .aa-answer")].map(a => a.textContent),
        payloads: window.__aiPayloads || [],
      };
    });
    console.log("填涂状态:", JSON.stringify(after));

    R.t("② 填涂流程走到结束", finished, after.msg.slice(0, 50));
    R.t("② iframe 里的两个 A 选项都被点中", JSON.stringify(after.clicks) === '["A","A"]', after.clicks);
    R.t("② iframe 里能看到选中态（.checkanswer）", after.selected === 2, after.selected);
    R.t("③ iframe 里的填空写入了答案", after.blank === "A", after.blank);
    R.t("②③ 汇总按成功计数，没报「人工核对」", /成功 3/.test(after.msg) && !/人工核对/.test(after.msg), after.msg);
    const payloadText = JSON.stringify(after.payloads);
    const q2Prompt = (payloadText.match(/"content":"2\.\[单选题\][^"]*/) || [""])[0];
    R.t("② .answer_p 的正文没有被剥掉首字母（ASC 仍是 ASC）",
      /D\. ASC 是降序排列/.test(payloadText) && !/(?:^|[^A-Za-z])SC 是降序排列/.test(payloadText),
      q2Prompt.slice(0, 160));
    R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");
    await page.close();
  }

  // ---------- ④ 跨域 iframe：读不到要给可操作提示 ----------
  {
    const page = await H.newPage(browser, site.url + "/cross.html", { aiAnswer: "A", waitFor: "#crossFrame", storage: STORAGE });
    await H.sleep(800);
    await page.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
    await H.sleep(1500);
    const scan = await page.evaluate(() => ({
      cards: document.querySelectorAll(".aa-card").length,
      empty: (document.querySelector(".aa-panel .aa-empty") || {}).textContent || "",
    }));
    console.log("跨域扫描:", JSON.stringify(scan));
    R.t("④ 跨域 iframe 不冒充成题目", scan.cards === 0, scan.cards);
    R.t("④ 空态明确说明「跨域 iframe」并给出打开方式",
      /跨域 iframe/.test(scan.empty) && /在新标签页中打开|此框架/.test(scan.empty),
      scan.empty.slice(0, 80));
    await page.close();
  }

  R.finish();
  await browser.close();
  await site.close();
});
