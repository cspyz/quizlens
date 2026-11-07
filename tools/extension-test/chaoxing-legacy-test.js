/**
 * 学习通旧版作业/章节测验结构（真实浏览器回归）。
 *
 * 覆盖旧版两套常见 DOM：
 *   · .questionLi + .mark_name + .Zy_ulTop（作业，选项带 radio）
 *   · .TiMu + .Zy_TItle + .Zy_ulTop（章节测验，选项没有 input，字母在 <i>、文字在 <a>）
 * 以及新版随堂练习里也会出现的 .numoption/.numoptiondx + .answer_content、多选题、多空填空。
 *
 * 跑法：PLAYWRIGHT_NODE_PATH=... PLAYWRIGHT_BROWSERS_PATH=... node tools/extension-test/chaoxing-legacy-test.js
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8105;

const LEGACY_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>旧版作业</title></head>
<body>
<div class="questionLi">
  <h3 class="mark_name colorDeep">1.<span class="colorShallow">[单选题]</span>下列哪个是数据库？</h3>
  <ul class="Zy_ulTop">
    <li class="clearfix"><label><input type="radio" name="a1" value="A"><span class="num_option">A</span><div class="answer_p">MySQL</div></label></li>
    <li class="clearfix"><label><input type="radio" name="a1" value="B"><span class="num_option">B</span><div class="answer_p">Nginx</div></label></li>
    <li class="clearfix"><label><input type="radio" name="a1" value="C"><span class="num_option">C</span><div class="answer_p">Redis</div></label></li>
    <li class="clearfix"><label><input type="radio" name="a1" value="D"><span class="num_option">D</span><div class="answer_p">Hadoop</div></label></li>
  </ul>
</div>

<div class="TiMu">
  <div class="Zy_TItle clearfix"><div class="clearfix"><i>2</i><div class="fl">[单选题]按照年龄降序排列（ ）</div></div></div>
  <ul class="Zy_ulTop">
    <li><i class="fl">A</i><a class="fl">ORDER BY age DESC</a></li>
    <li><i class="fl">B</i><a class="fl">ORDER BY DESC age</a></li>
    <li><i class="fl">C</i><a class="fl">ORDER BY age ASC</a></li>
    <li><i class="fl">D</i><a class="fl">ASC 是降序排列</a></li>
  </ul>
</div>

<div class="TiMu">
  <div class="Zy_TItle">3.[多选题]以下哪些是关系型数据库？</div>
  <div class="stem_answer">
    <div class="answerBg"><span class="numoption" data="A">A</span><span class="answer_content">MySQL</span></div>
    <div class="answerBg"><span class="numoptiondx" data="B">B</span><span class="answer_content">Redis</span></div>
    <div class="answerBg"><span class="numoption" data="C">C</span><span class="answer_content">PostgreSQL</span></div>
    <div class="answerBg"><span class="numoption" data="D">D</span><span class="answer_content">MongoDB</span></div>
  </div>
</div>

<div class="questionLi">
  <h3 class="mark_name">4.[填空题]中国的首都是 ____ ，最大的城市是 ____ 。</h3>
  <div class="stem_answer">
    <textarea class="blank" name="b1"></textarea>
    <textarea class="blank" name="b2"></textarea>
  </div>
</div>

<script>
window.__cx = { clicks: [], multi: [] };
document.querySelectorAll(".TiMu .Zy_ulTop li").forEach(function (li) {
  li.addEventListener("click", function () {
    li.parentElement.querySelectorAll(".checkanswer").forEach(function (n) { n.remove(); });
    var mark = document.createElement("span");
    mark.className = "checkanswer";
    mark.textContent = "✓";
    li.appendChild(mark);
    window.__cx.clicks.push(li.textContent.trim().charAt(0));
  });
});
document.querySelectorAll(".TiMu .answerBg").forEach(function (bg) {
  bg.addEventListener("click", function () {
    var mark = bg.querySelector(".checkanswerdx");
    if (mark) { mark.remove(); return; }
    mark = document.createElement("span");
    mark.className = "checkanswerdx";
    mark.textContent = "✓";
    bg.appendChild(mark);
    window.__cx.multi.push(bg.querySelector(".numoption, .numoptiondx").textContent.trim());
  });
});
</script>
</body></html>`;

const TOP_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>作业外壳</title></head>
<body><p>课程外壳</p><iframe id="contentFrame" src="/legacy.html" style="width:900px;height:700px;border:0"></iframe></body></html>`;

const STORAGE = { mode: "ai", aiKey: "sk-test", interval: "0", fillHosts: "*" };

H.run(async () => {
  const site = await H.serve({ port: PORT, routes: { "/": TOP_PAGE, "/legacy.html": LEGACY_PAGE } });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const page = await H.newPage(browser, site.url + "/", { aiAnswer: "A", waitFor: "#contentFrame", storage: STORAGE });
  const R = H.Reporter();

  await page.waitForFunction(() => {
    const f = document.querySelector("#contentFrame");
    return !!(f && f.contentDocument && f.contentDocument.querySelector(".questionLi"));
  }, { timeout: 15000 }).catch(() => {});

  // 按题干分流回答：两空填空返回两行，多选题返回 A、C，其余 A
  await page.evaluate(() => {
    const orig = window.chrome.runtime.sendMessage;
    window.chrome.runtime.sendMessage = async msg => {
      if (msg && msg.type === "AI_CHAT") {
        const msgs = (msg.payload && msg.payload.messages) || [];
        const user = [...msgs].reverse().find(m => m.role === "user");
        const p = (user && user.content) || "";
        if (/多选题|以下哪些/.test(p)) return { ok: true, text: "答案：A、C" };
        if (/两个空|最大的城市/.test(p)) return { ok: true, text: "北京\n上海" };
        return { ok: true, text: "答案：A" };
      }
      return orig(msg);
    };
  });

  await page.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
  await H.sleep(1800);

  const scan = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".aa-card")];
    return {
      cards: cards.length,
      stems: cards.map(c => (c.querySelector(".aa-stem") || {}).textContent || ""),
      opts: cards.map(c => c.querySelectorAll(".aa-opt").length),
      chips: cards.map(c => [...c.querySelectorAll(".aa-chip")].map(x => x.textContent)),
      info: (document.querySelector(".aa-panel .aa-info") || {}).textContent || "",
    };
  });
  console.log("旧版扫描:", JSON.stringify(scan));

  R.t("旧版 .questionLi / .TiMu 认出 4 道题", scan.cards === 4, scan.cards);
  R.t("前三道选择题都渲染了 4 个选项", scan.opts.filter(n => n === 4).length === 3, scan.opts);
  R.t("多空填空题显示「2 空」", scan.chips.some(list => list.includes("2 空")), scan.chips);

  const clicked = await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".aa-panel button")].find(b => b.textContent.includes("填涂"));
    if (!btn) return false;
    btn.click();
    return true;
  });
  R.t("找到并点击「填涂」", clicked, clicked);

  let finished = false;
  for (let i = 0; i < 15 && !finished; i++) {
    await H.sleep(1000);
    finished = await page.evaluate(() =>
      /填涂结束/.test((document.querySelector(".aa-panel .aa-info") || {}).textContent || ""));
  }

  const after = await page.evaluate(() => {
    const w = document.querySelector("#contentFrame").contentWindow;
    const d = w.document;
    return {
      msg: (document.querySelector(".aa-panel .aa-info") || {}).textContent || "",
      radio: [...d.querySelectorAll('input[name="a1"]')].map(i => i.checked),
      liMarked: [...d.querySelectorAll(".TiMu .Zy_ulTop li")].map(li => !!li.querySelector(".checkanswer")),
      multiMarked: [...d.querySelectorAll(".TiMu .answerBg")].map(bg => !!bg.querySelector(".checkanswerdx")),
      blanks: [...d.querySelectorAll("textarea.blank")].map(t => t.value),
      clicks: w.__cx,
    };
  });
  console.log("旧版填涂:", JSON.stringify(after));

  R.t("填涂流程走到结束", finished, after.msg.slice(0, 60));
  R.t("① .questionLi 的 radio 勾上 A", after.radio[0] === true && after.radio.slice(1).every(x => !x), after.radio);
  R.t("② .TiMu 无 input 选项点中 A", after.liMarked[0] === true && after.liMarked.slice(1).every(x => !x), after.liMarked);
  R.t("③ 多选题点中 A、C（.numoption/.numoptiondx）",
    after.multiMarked[0] === true && after.multiMarked[2] === true &&
    after.multiMarked[1] === false && after.multiMarked[3] === false, after.multiMarked);
  R.t("④ 两个空分别写入", JSON.stringify(after.blanks) === '["北京","上海"]', after.blanks);
  R.t("汇总按成功计数，没报「人工核对」", /成功 4/.test(after.msg) && !/人工核对/.test(after.msg), after.msg);
  R.t("无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
