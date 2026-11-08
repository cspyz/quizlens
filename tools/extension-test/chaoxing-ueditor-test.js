/**
 * 学习通作业简答（UEditor）回归。
 *
 * 真实结构（2026-11-08 现场采样）：
 *   .questionLi.singleQuesId > .mark_name + .stem_answer > .edui-editor > iframe#ueditor_N
 *   + 同容器内隐藏 textarea#answerN（display:none）。
 *   UEditor 的正文在**同源 iframe** 的 contenteditable body 里；页面上还会残留一个
 *   0×0 的隐藏 editor iframe（真实页 ueditor_4），不能把答案写进去。
 *
 * 回归点：
 *   ① 两道简答被识别成「简答」，不显示选项、不再降级为“没有可自动填涂的控件”；
 *   ② AI 走文字作答 prompt（不是选项字母 prompt），多段答案不被截成第一行；
 *   ③ 卡片答案不是单独一个 D（“答案：Docker…”曾被字母解析器误读成选项 D）；
 *   ④ 面板「填涂」写入可见 iframe body，并同步隐藏 textarea；隐藏 editor 保持为空；
 *   ⑤ 「开始答题」自动路径同样能写进去，不再降级为只读。
 */
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const PORT = 8206;

const ESSAY = "Docker 容器特点：轻量、启动快、隔离、可移植。\n常用参数：-d 后台运行；-it 交互终端；-p 端口映射。";

const SRCDOC = "<body class='view' contenteditable='true'><p><br></p></body>";

const q = (n, hiddenEditor) => `
<div class="padBom50 questionLi fontLabel singleQuesId" id="question${n}">
  <h3 class="mark_name colorDeep fontLabel workTextWrap">${n}. <span class="colorShallow">(简答题)</span>
    <p>简述 Docker 容器的特点，以及 5 个以上 docker run 参数及其意义。</p>
  </h3>
  <input type="hidden" id="answertype${n}" value="4">
  <div class="stem_answer">
    <div class="eidtDiv">
      <div class="edui-editor">
        <iframe id="ueditor_${n - 1}" srcdoc="${SRCDOC}" style="width:800px;height:150px;border:0;display:block"></iframe>
        ${hiddenEditor ? `<iframe id="ueditor_hidden" srcdoc="${SRCDOC}" style="width:0;height:0;border:0"></iframe>` : ""}
      </div>
    </div>
  </div>
  <textarea id="answer${n}" name="answer${n}" style="display:none"></textarea>
</div>`;

const UEDITOR_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>作业作答</title></head>
<body>
<form id="submitForm">
  <div class="fanyaMarking TiMu" id="fanyaMarking">
    ${q(1, true)}
    ${q(2, false)}
  </div>
</form>
</body></html>`;

const CHOICE_PAGE = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>选择题</title></head>
<body>
<div class="question">
  <div class="q-stem">1. 下列哪个是数据库？</div>
  <div class="opt"><input type="radio" name="c1" value="0"><span class="opt-text">MySQL</span></div>
  <div class="opt"><input type="radio" name="c1" value="1"><span class="opt-text">Nginx</span></div>
  <div class="opt"><input type="radio" name="c1" value="2"><span class="opt-text">Redis</span></div>
  <div class="opt"><input type="radio" name="c1" value="3"><span class="opt-text">Hadoop</span></div>
</div>
</body></html>`;

const STORAGE = { mode: "ai", aiKey: "x", interval: "0", fillHosts: "*" };

async function waitForText(page, selector, re, tries = 24, step = 250) {
  for (let i = 0; i < tries; i++) {
    const text = await page.evaluate(sel => (document.querySelector(sel) || {}).textContent || "", selector);
    if (re.test(text)) return text;
    await H.sleep(step);
  }
  return page.evaluate(sel => (document.querySelector(sel) || {}).textContent || "", selector);
}

function readEditors(page) {
  return page.evaluate(() => {
    const bodyText = id => {
      const f = document.getElementById(id);
      try { return f && f.contentDocument && f.contentDocument.body ? f.contentDocument.body.textContent : ""; } catch (_) { return "__BLOCKED__"; }
    };
    return {
      visible1: bodyText("ueditor_0"),
      visible2: bodyText("ueditor_1"),
      hidden: bodyText("ueditor_hidden"),
      answer1: (document.getElementById("answer1") || {}).value || "",
      answer2: (document.getElementById("answer2") || {}).value || "",
    };
  });
}

H.run(async () => {
  const site = await H.serve({ port: PORT, routes: { "/": UEDITOR_PAGE, "/choice": CHOICE_PAGE } });
  const browser = await chromium.launch({ headless: true });
  const R = H.Reporter();

  // ---------- 面板路径：出答案 → 填涂 ----------
  const page = await H.newPage(browser, site.url + "/", {
    aiAnswer: ESSAY, storage: STORAGE, waitFor: ".questionLi",
  });
  await page.evaluate(answer => {
    window.__aiSystems = [];
    window.__aiUsers = [];
    window.chrome.runtime.sendMessage = async msg => {
      if (msg && msg.type === "AI_CHAT") {
        const msgs = (msg.payload && msg.payload.messages) || [];
        window.__aiSystems.push((msgs.find(m => m.role === "system") || {}).content || "");
        window.__aiUsers.push(([...msgs].reverse().find(m => m.role === "user") || {}).content || "");
        return { ok: true, text: answer };
      }
      return { ok: false, error: "stub" };
    };
  }, ESSAY);

  await page.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
  await H.sleep(1200);

  const scan = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".aa-card")];
    return {
      cards: cards.length,
      chips: cards.map(c => [...c.querySelectorAll(".aa-card-tags .aa-chip")].map(x => x.textContent)),
      opts: cards.map(c => c.querySelectorAll(".aa-opt").length),
      warn: [...document.querySelectorAll(".aa-warn")].map(x => x.textContent).join(" | "),
      info: (document.querySelector(".aa-info") || {}).textContent || "",
      stems: cards.map(c => (c.querySelector(".aa-stem") || {}).textContent || ""),
    };
  });
  console.log("UEditor 扫描:", JSON.stringify(scan, null, 2));

  R.t("两道 UEditor 简答只识别成 2 张卡", scan.cards === 2, scan.cards);
  R.t("两张卡都带「简答」类型标签", scan.chips.every(c => c.includes("简答")), scan.chips);
  R.t("简答卡不渲染任何选项", scan.opts.every(n => n === 0), scan.opts);
  R.t("面板不出现「没有可自动填涂的控件」", !/没有可自动填涂的控件/.test(scan.warn), scan.warn);

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".aa-panel button")].find(b => b.textContent.includes("出答案"));
    if (btn) btn.click();
  });
  await waitForText(page, ".aa-info", /出答案结束/);

  const answers = await page.evaluate(() => [...document.querySelectorAll(".aa-card .aa-answer")].map(x => ({
    text: x.textContent, display: x.style.display,
  })));
  const systems = await page.evaluate(() => window.__aiSystems);
  console.log("出答案:", JSON.stringify(answers, null, 2));
  console.log("AI system prompts:", JSON.stringify(systems.map(s => s.slice(0, 90)), null, 2));

  R.t("简答答案显示完整两段，不是单个 D",
    answers.length === 2 && answers.every(a => /容器特点/.test(a.text) && /常用参数/.test(a.text) && a.text.trim() !== "D"),
    answers);
  R.t("AI 走文字作答 prompt，不是选项字母 prompt",
    systems.length >= 2 && systems.every(s => /文字作答题|简答题/.test(s) && !/大写选项字母/.test(s)),
    systems.map(s => s.slice(0, 60)));

  await page.evaluate(() => {
    const btn = [...document.querySelectorAll(".aa-panel button")].find(b => /填涂/.test(b.textContent));
    if (btn) btn.click();
  });
  const fillMsg = await waitForText(page, ".aa-info", /填涂结束/);
  await H.sleep(500);
  const filled = await readEditors(page);
  console.log("面板填涂:", JSON.stringify({ fillMsg, filled }, null, 2));

  R.t("可见 UEditor 1 写入完整答案", /容器特点/.test(filled.visible1) && /常用参数/.test(filled.visible1), filled.visible1);
  R.t("可见 UEditor 2 写入完整答案", /容器特点/.test(filled.visible2) && /常用参数/.test(filled.visible2), filled.visible2);
  R.t("隐藏的重复 editor 保持为空", !filled.hidden.trim(), filled.hidden);
  R.t("隐藏 textarea 1 同步完整答案", /容器特点/.test(filled.answer1) && /常用参数/.test(filled.answer1), filled.answer1);
  R.t("隐藏 textarea 2 同步完整答案", /容器特点/.test(filled.answer2) && /常用参数/.test(filled.answer2), filled.answer2);
  R.t("填涂汇总成功 2", /成功 2/.test(fillMsg), fillMsg);
  R.t("面板路径无未捕获异常", page.errors.length === 0, page.errors.join(" | ") || "(无)");

  // ---------- 自动路径：START 不再降级只读 ----------
  const autoPage = await H.newPage(browser, site.url + "/", {
    aiAnswer: ESSAY, storage: STORAGE, waitFor: ".questionLi",
  });
  await autoPage.evaluate(() => window.__aaListener({
    type: "START",
    settings: { mode: "ai", aiKey: "x", interval: "0", fillHosts: "*", showLog: true },
  }));
  await H.waitForFinish(autoPage, { tries: 10, step: 500 });
  await H.sleep(500);

  const auto = await autoPage.evaluate(() => ({
    cards: document.querySelectorAll(".aa-card").length,
    warn: [...document.querySelectorAll(".aa-warn")].map(x => x.textContent).join(" | "),
    log: (document.querySelector(".aa-runlog") || {}).textContent || "",
    body1: (() => { try { return document.getElementById("ueditor_0").contentDocument.body.textContent; } catch (_) { return ""; } })(),
    ta1: (document.getElementById("answer1") || {}).value || "",
  }));
  console.log("自动答题:", JSON.stringify(auto, null, 2));

  R.t("自动答题识别到 2 道题", auto.cards === 2, auto.cards);
  R.t("自动答题不再降级只读", !/没有可自动填涂的控件/.test(auto.warn), auto.warn);
  R.t("自动答题把答案写进可见 UEditor", /容器特点/.test(auto.body1) && /常用参数/.test(auto.body1), auto.body1);
  R.t("自动答题同步隐藏 textarea", /容器特点/.test(auto.ta1) && /常用参数/.test(auto.ta1), auto.ta1);
  R.t("自动答题日志报 AI 作答 2", /AI 作答 2/.test(auto.log), auto.log.slice(-120));
  R.t("自动路径无未捕获异常", autoPage.errors.length === 0, autoPage.errors.join(" | ") || "(无)");

  // ---------- 字母解析：英文单词不能被当成选项 ----------
  const choicePage = await H.newPage(browser, site.url + "/choice", {
    aiAnswer: "答案：Docker 容器特点：轻量", storage: STORAGE, waitFor: ".question",
  });
  await choicePage.evaluate(() => window.__aaListener({ type: "START_SCAN" }));
  await H.sleep(900);
  await choicePage.evaluate(() => {
    const btn = [...document.querySelectorAll(".aa-card button")].find(b => b.textContent.trim() === "答");
    if (btn) btn.click();
  });
  await H.sleep(900);

  const choice = await choicePage.evaluate(() => ({
    answer: (document.querySelector(".aa-card .aa-answer") || {}).textContent || "",
    picked: [...document.querySelectorAll(".aa-opt.on")].map(x => x.textContent.trim()),
  }));
  console.log("字母解析:", JSON.stringify(choice, null, 2));

  R.t("「答案：Docker…」不会误勾选项 D", choice.picked.length === 0, choice.picked);
  R.t("取不到字母时如实报错，不显示 D", choice.answer.trim() !== "D" && /没解析出选项字母|未取到答案|❌/.test(choice.answer), choice.answer);
  R.t("字母解析路径无未捕获异常", choicePage.errors.length === 0, choicePage.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
