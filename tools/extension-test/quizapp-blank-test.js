/**
 * 练习页填空题测试（端到端）。
 *
 * 两件事：
 *   A. 页面自己：填空题渲染出输入框、多空题有多个框、判分正确
 *      —— 含归一化判分：英文不分大小写、全角数字按数值算、多空必须全对
 *   B. 插件：能识别本地练习页的填空题并真的写进输入框，多空按顺序对应
 */
const path = require("path");
const H = require("./harness");
const { chromium } = H.ensurePlaywright();

const fs = require("fs");
const PORT = 8095;
const QUIZ_DIR = path.join(__dirname, "..", "..", "quiz-app");

// 期望值从**练习卷本身**算，不写死数字。
//
// 踩过的坑：这些断言原本硬编码 "15 道填空题 / 总题数 85"，而练习卷后来扩充成了
// 41 道填空 / 148 题 —— 于是测试全线飘红，看起来像产品坏了，其实只是卷子长大了。
// 现在按 questions.json 现场推导：卷子再改，这些断言自动跟着走。
const PAPER = (() => {
  const q = JSON.parse(fs.readFileSync(path.join(QUIZ_DIR, "questions.json"), "utf8")).questions || [];
  const isBlank = x => !Array.isArray(x.options) || x.options.length === 0;
  const blanks = q.filter(isBlank);
  // 一题多空：题干里出现两处及以上下划线/空括号（与页面渲染的判定保持一致）
  const multiBlank = blanks.filter(b => ((b.question || "").match(/_{2,}|（\s*）|\(\s*\)/g) || []).length > 1);
  const byType = { single: 0, multi: 0, judge: 0, blank: 0 };
  q.forEach(x => { const t = x.type || (isBlank(x) ? "blank" : "single"); if (t in byType) byType[t]++; });
  return { total: q.length, blankCount: blanks.length, multiBlank: multiBlank.length, byType };
})();
console.log("练习卷实况:", JSON.stringify(PAPER));

H.run(async () => {
  const site = await H.serve({ port: PORT, staticDir: QUIZ_DIR });
  const browser = await chromium.launch({ headless: true, args: ["--disable-background-timer-throttling"] });
  const R = H.Reporter();

  // ================= A. 页面渲染与判分 =================
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", e => pageErrors.push(e.message));
  await page.goto(site.url + "/");
  await page.waitForSelector(".question");

  const render = await page.evaluate(() => {
    const blanks = [...document.querySelectorAll(".question")].filter(d => d.querySelector(".blank-input"));
    return {
      total: document.querySelectorAll(".question").length,
      blankCount: blanks.length,
      multi: blanks.filter(d => d.querySelectorAll(".blank-input").length > 1).length,
      multiSizes: blanks.map(d => d.querySelectorAll(".blank-input").length).filter(n => n > 1),
      tagged: document.querySelectorAll(".q-tag.blank").length,
    };
  });
  console.log("渲染:", JSON.stringify(render));
  R.t(`练习页渲染出 ${PAPER.blankCount} 道填空题`, render.blankCount === PAPER.blankCount, render.blankCount);
  R.t("卡片标注为「填空」", render.tagged === PAPER.blankCount, render.tagged);
  R.t(`有 ${PAPER.multiBlank} 道一题多空`, render.multi === PAPER.multiBlank,
    { multi: render.multi, 期望: PAPER.multiBlank, sizes: render.multiSizes });
  // 多空题的每个框都要渲染出来：数量 > 1 且不超过卷面声明的最大空数（当前 8）
  R.t("多空题都渲染出多个输入框（2~8 个）",
    render.multiSizes.length > 0 && render.multiSizes.every(n => n >= 2 && n <= 8), render.multiSizes);
  R.t(`总题数 ${PAPER.total}`, render.total === PAPER.total, render.total);

  // 按题干关键字定位「填空题」并填值，然后交卷看判分。
  // 注意：必须限定在带 .blank-input 的题里找 —— 纸面上可能有另一道含同样文字的**选择题**
  // （例如 "12 × 8 = ？" 是单选，"计算：12 × 8 = ____" 才是填空），不限定就会填到错的那道。
  const scored = await page.evaluate(() => {
    const findQ = (kw, needBlank) => [...document.querySelectorAll(".question")].find(d =>
      d.querySelector(".q-stem").textContent.includes(kw) &&
      (!needBlank || d.querySelector(".blank-input")));
    const fill = (kw, values) => {
      const d = findQ(kw, true);
      if (!d) return false;
      [...d.querySelectorAll(".blank-input")].forEach((inp, i) => { if (values[i] != null) inp.value = values[i]; });
      return true;
    };
    const ok = {
      "12 × 8": fill("12 × 8 =", ["９６"]),                 // 全角数字，应按数值判对
      "opposite": fill("The opposite", ["Cold"]),            // 英文，应大小写不敏感
      "岳阳楼记": fill("岳阳楼记", ["范仲淹"]),                // 中文
      "内角和": fill("三角形的内角和", ["190"]),               // 故意填错
      "等差数列": fill("等差数列", ["3"]),                    // 多空只填一个 → 应判错
    };
    // 对照组：一道选择题，验证选择题判分没被这次改动影响
    const choice = findQ("世界上面积最大的海洋", false);
    if (choice) choice.querySelectorAll('input[type="radio"]')[1].checked = true;

    document.getElementById("submitBtn").click();
    const cls = kw => {
      const d = findQ(kw, true);
      if (!d) return "notfound";
      return d.classList.contains("answered-correct") ? "correct"
           : d.classList.contains("answered-wrong") ? "wrong" : "none";
    };
    return {
      filled: ok,
      fullWidth: cls("12 × 8 ="),
      caseInsensitive: cls("The opposite"),
      chinese: cls("岳阳楼记"),
      wrongOne: cls("三角形的内角和"),
      partialMulti: cls("等差数列"),
      choice: choice ? (choice.classList.contains("answered-correct") ? "correct" : "wrong") : "notfound",
      score: document.getElementById("score").textContent,
      correctCount: document.querySelectorAll(".question.answered-correct").length,
    };
  });
  console.log("判分:", JSON.stringify(scored));
  R.t("定位到全部 5 道测试题", Object.values(scored.filled).every(Boolean), scored.filled);
  R.t("全角数字 ９６ 判对（按数值归一化）", scored.fullWidth === "correct", scored.fullWidth);
  R.t("英文 Cold 判对（不分大小写）", scored.caseInsensitive === "correct", scored.caseInsensitive);
  R.t("中文「范仲淹」判对", scored.chinese === "correct", scored.chinese);
  R.t("填错的判错", scored.wrongOne === "wrong", scored.wrongOne);
  R.t("多空只填一个判错（必须全对）", scored.partialMulti === "wrong", scored.partialMulti);
  R.t("选择题判分未受影响", scored.choice === "correct", scored.choice);
  R.t("总分等于答对数（3 道填空 + 1 道选择 = 4）", scored.score === "4" && scored.correctCount === 4,
      { score: scored.score, correct: scored.correctCount });
  R.t("页面无未捕获异常", pageErrors.length === 0, pageErrors.join(" | ") || "(无)");

  // ================= C. 题型筛选（填空题排在第 55 题往后，没筛选容易以为"没有填空题"）=================
  const p3 = await browser.newPage();
  const errors3 = [];
  p3.on("pageerror", e => errors3.push(e.message));
  await p3.goto(site.url + "/");
  await p3.waitForSelector(".question");

  const bar = await p3.evaluate(() => {
    const btns = [...document.querySelectorAll("#filterBar .fbtn")];
    return {
      labels: btns.map(b => b.textContent),
      counts: btns.map(b => b.dataset.type + "=" + (b.textContent.match(/\d+/) || [])[0]),
      noFilter: [...document.querySelectorAll("#filterBar .fbtn.active")].map(b => b.dataset.type),
    };
  });
  console.log("筛选条:", JSON.stringify(bar));
  // 期望值同样从卷面推导（见文件顶部的 PAPER）：五个分类的题数之和必须等于总题数，
  // 且"填空"类要与 PAPER.blankCount 一致。这样卷子扩充后不必回来改数字。
  const wantCounts = [
    "all=" + PAPER.total,
    "single=" + PAPER.byType.single,
    "multi=" + PAPER.byType.multi,
    "judge=" + PAPER.byType.judge,
    "blank=" + PAPER.byType.blank,
  ];
  R.t("筛选条列出 5 类且题数正确", JSON.stringify(bar.counts) === JSON.stringify(wantCounts),
      { got: bar.counts, want: wantCounts });
  R.t("默认选中「全部」", bar.noFilter.join() === "all", bar.noFilter);

  const onlyBlank = await p3.evaluate(() => {
    [...document.querySelectorAll("#filterBar .fbtn")].find(b => b.dataset.type === "blank").click();
    const shown = [...document.querySelectorAll(".question")].filter(d => d.style.display !== "none");
    return {
      shown: shown.length,
      allBlanks: shown.every(d => d.querySelector(".blank-input")),
      progress: document.getElementById("progress").textContent,
      active: [...document.querySelectorAll("#filterBar .fbtn.active")].map(b => b.dataset.type),
    };
  });
  console.log("筛到填空:", JSON.stringify(onlyBlank));
  R.t(`点「填空」只剩 ${PAPER.blankCount} 道题`, onlyBlank.shown === PAPER.blankCount, onlyBlank.shown);
  R.t("剩下的全是填空题", onlyBlank.allBlanks, onlyBlank.allBlanks);
  R.t("进度条标出当前显示范围", new RegExp("当前显示 " + PAPER.blankCount + " 题").test(onlyBlank.progress), onlyBlank.progress);
  R.t("筛选按钮高亮跟随", onlyBlank.active.join() === "blank", onlyBlank.active);

  const scoped = await p3.evaluate(() => {
    // 筛到填空后填对 3 道、空着其余，交卷应只判这 15 道
    const shown = [...document.querySelectorAll(".question")].filter(d => d.style.display !== "none");
    const put = (kw, v) => {
      const d = shown.find(x => x.querySelector(".q-stem").textContent.includes(kw));
      if (d) d.querySelector(".blank-input").value = v;
    };
    put("12 × 8 =", "96");
    put("岳阳楼记", "范仲淹");
    put("三角形的内角和", "180");
    document.getElementById("submitBtn").click();
    return {
      detail: document.getElementById("resultDetail").textContent,
      score: document.getElementById("score").textContent,
      wrongHidden: [...document.querySelectorAll(".question")]
        .filter(d => d.style.display === "none" && d.classList.contains("answered-correct")).length,
    };
  });
  console.log("筛选后交卷:", JSON.stringify(scoped));
  R.t("只判筛选出的填空题（答对 3）",
    scoped.score === "3" && new RegExp("共 " + PAPER.blankCount + " 题").test(scoped.detail), scoped.detail);
  R.t("结果里注明只判了填空题", /只判了「填空」/.test(scoped.detail), scoped.detail);
  R.t("隐藏的选择题没被判分", scoped.wrongHidden === 0, scoped.wrongHidden);
  R.t("筛选页无未捕获异常", errors3.length === 0, errors3.join(" | ") || "(无)");

  // ================= D. 插件填本地页的填空题 =================
  // AI 桩返回两行：单空题只取第一行；两空题按顺序各取一行 → 验证多空对应关系
  const p2 = await H.newPage(browser, site.url + "/", {
    aiAnswer: "甲\n乙", storage: { mode: "ai", aiKey: "x" },
  });
  await H.startAndWait(p2, { mode: "ai", intervalMs: 10, aiKey: "x", fillHosts: "localhost" });

  const filled = await p2.evaluate(() => {
    const blanks = [...document.querySelectorAll(".question")].filter(d => d.querySelector(".blank-input"));
    const one = blanks.find(d => d.querySelectorAll(".blank-input").length === 1);
    const two = blanks.find(d => d.querySelectorAll(".blank-input").length === 2);
    return {
      singleStem: one.querySelector(".q-stem").textContent.slice(0, 20),
      singleValue: one.querySelector(".blank-input").value,
      multiStem: two.querySelector(".q-stem").textContent.slice(0, 20),
      multiValues: [...two.querySelectorAll(".blank-input")].map(i => i.value),
      filledBlanks: blanks.filter(d =>
        [...d.querySelectorAll(".blank-input")].some(i => i.value !== "")).length,
    };
  });
  console.log("插件写入:", JSON.stringify(filled));
  R.t("插件认出了本地页的填空题并写入", filled.filledBlanks === PAPER.blankCount, filled.filledBlanks);
  R.t("单空题写入第一行「甲」", filled.singleValue === "甲", filled.singleValue);
  R.t("两空题按顺序写入「甲」「乙」",
      filled.multiValues[0] === "甲" && filled.multiValues[1] === "乙", filled.multiValues);
  R.t("插件运行无未捕获异常", p2.errors.length === 0, p2.errors.join(" | ") || "(无)");

  R.finish();
  await browser.close();
  await site.close();
});
