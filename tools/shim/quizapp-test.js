"use strict";
/*
 * 本地练习页（quiz-app）回归测试 —— 纯 Node，不需要浏览器。
 *
 * 覆盖用户诉求：「题目更多、填空的空更多、选择题的选项更多，看能不能正常填涂」。
 *
 * 为什么单独一套：原 Playwright 套件（tools/extension-test/quizapp-*.js）在本机
 * 因沙箱不允许拉起浏览器进程而全部失败。这套用 tools/shim 的 DOM 台架加载
 * **真实的** quiz-app/index.html（含它自己的内联脚本与 ./questions.json），
 * 再注入**未修改的** extension/content.js，跑真实识别 + 真实填涂链路。
 *
 * 同时把两个"靠这批新题才暴露出来"的 bug 钉住：
 *   ① 连写答案串的 {2,6} 上限 → 8 选项全选只勾到 F；
 *   ② dedupe 把题干相近但选项不同的两道题误合并 → 85 题只出 84 张卡片。
 */
const fs = require("fs");
const path = require("path");
const T = require("./env");
const sleep = T.sleep;

const QUIZ = path.join(T.ROOT, "quiz-app");
const PAGE = fs.readFileSync(path.join(QUIZ, "index.html"), "utf8");
const DATA = JSON.parse(fs.readFileSync(path.join(QUIZ, "questions.json"), "utf8"));

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });

// 起一个"真实的"练习页环境：先跑页面内联脚本渲染题目，再注入插件。
// AI 回复按题目类型自动给：选择题回「答案：X」，填空题按空数回多行。
async function bootPage({ answerFor } = {}) {
  const env = T.makeEnv({
    html: PAGE,
    pageDir: QUIZ,
    storage: { mode: "ai", aiKey: "sk-test", interval: "0", answerMode: "standard" },
    aiReply: stats => {
      // 默认回复：选择题给 A（多数题不对，但填涂链路照样要跑通）
      return { ok: true, text: "答案：A\n\n解析：测试用回复。" };
    },
  });
  env.runInlineScripts();
  await sleep(400);
  env.injectContent();
  return env;
}

// 让 AI 按"这道题真正的答案"作答，才能验证填涂正确性。
// 题干 -> 该题的正确答案（从 questions.json 读）
function answerMap() {
  const m = new Map();
  for (const q of DATA.questions) m.set(q.question, q);
  return m;
}

(async () => {
  // ---------- ① 题量与识别完整性 ----------
  {
    const env = await bootPage();
    env.startScan();
    await sleep(300);
    const pageCount = env.doc.querySelectorAll(".question").length;
    const cards = env.cards();
    t("页面渲染题数 = questions.json 题数", pageCount === DATA.questions.length, pageCount + " vs " + DATA.questions.length);
    t("插件识别卡片数 = 页面题数（不能吞题）", cards.length === pageCount, cards.length + " vs " + pageCount);
    t("面板计数与卡片数一致", (env.panel().querySelector(".aa-count") || {}).textContent === cards.length + " 题",
      (env.panel().querySelector(".aa-count") || {}).textContent);

    // 卡片顺序必须与页面题目顺序一致。
    // 这条断言以前**测不出来**：台架没定义 Node.DOCUMENT_POSITION_FOLLOWING，
    // 排序比较器恒返回 0，排序是 no-op（verifier2 发现，已在 env.js 补上常量）。
    const orderOk = cards.every((c, i) => {
      const cardStem = (c.querySelector(".aa-stem") || {}).textContent || "";
      const pageStem = (env.doc.querySelectorAll(".question .q-stem")[i] || {}).textContent || "";
      return pageStem && cardStem.includes(pageStem.trim().slice(0, 30));
    });
    t("卡片顺序与页面题目顺序一致", orderOk, orderOk ? "全部对齐" : "存在错位");

    // 两道「质数」题必须都在（曾经被 dedupe 合并掉一道）
    const stems = cards.map(c => (c.querySelector(".aa-stem") || {}).textContent || "");
    const prime = stems.filter(s => /质数/.test(s));
    t("题干相近的两道「质数」题都在（dedupe 不误合并）", prime.length === 2, prime.length);
    t("无未捕获异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 200));
  }

  // ---------- ② 多选题：选项多 + 答案横跨到 H ----------
  {
    const byStem = answerMap();
    // 找出"选项最多"的多选题与"选项最多"的单选/判断题，各验一次
    const multis = DATA.questions.filter(q => q.type === "multi").sort((a, b) => b.options.length - a.options.length);
    const picks = [
      multis[0],                                   // 选项最多的多选
      DATA.questions.filter(q => q.type === "single").sort((a, b) => b.options.length - a.options.length)[0],
      DATA.questions.find(q => q.options && q.options.length >= 6 && q.answer.length >= 4),
    ].filter(Boolean);

    const env = T.makeEnv({
      html: PAGE, pageDir: QUIZ,
      storage: { mode: "ai", aiKey: "sk-test", interval: "0", answerMode: "standard" },
      // 按题干回该题的真实答案（字母形式），模拟"AI 答对了"
      aiReply: (() => {
        let n = 0;
        return () => {
          const q = picks[Math.min(n++, picks.length - 1)];
          const letters = q.answer.map(i => String.fromCharCode(65 + i)).join("、");
          return { ok: true, text: "答案：" + letters + "\n\n解析：测试。" };
        };
      })(),
    });
    env.runInlineScripts();
    await sleep(400);
    env.injectContent();
    env.startScan();
    await sleep(300);
    // 只对这几道题点「答」，再点「填涂」
    const cards = env.cards();
    for (const q of picks) {
      const idx = cards.findIndex(c => ((c.querySelector(".aa-stem") || {}).textContent || "").includes(q.question.slice(0, 18)));
      if (idx >= 0) await env.clickAnswer(idx);
    }
    const fillBtn = [...env.panel().querySelectorAll("button")].find(b => /填涂/.test(b.textContent));
    fillBtn.click();
    for (let i = 0; i < 120; i++) { await sleep(50); if (/填涂结束/.test((env.panel().querySelector(".aa-info") || {}).textContent || "")) break; }

    const checkedByStem = new Map(env.checked().map(c => [c.stem.replace(/^\d+\.\s*/, "").slice(0, 18), c.idx]));
    for (const q of picks) {
      const got = checkedByStem.get(q.question.slice(0, 18));
      const want = [...q.answer].sort((a, b) => a - b);
      t("多选项填涂正确（" + q.options.length + " 选项 → " +
        q.answer.map(i => String.fromCharCode(65 + i)).join("") + "）",
        JSON.stringify((got || []).slice().sort((a, b) => a - b)) === JSON.stringify(want),
        JSON.stringify(got) + " 期望 " + JSON.stringify(want));
    }
    t("多选项：无未捕获异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 200));

    // 走"肯定式线索"路径（没有「答案：」标记）时，连写串上限同样要跟随选项数。
    // 这一支曾经写死 {2,6}，8 选项全选会被截成前 6 个 —— 与主分支是同一个 bug 的两处。
    const env2 = T.makeEnv({
      html: PAGE, pageDir: QUIZ,
      storage: { mode: "ai", aiKey: "sk-test", interval: "0", answerMode: "standard" },
      aiReply: (() => {
        let n = 0;
        return () => {
          const q = picks[Math.min(n++, picks.length - 1)];
          // 不用「答案：」标记，改用"故选 X"这种肯定式线索
          const letters = q.answer.map(i => String.fromCharCode(65 + i)).join("");
          return { ok: true, text: "故选 " + letters + "\n\n解析：测试。" };
        };
      })(),
    });
    env2.runInlineScripts();
    await sleep(400);
    env2.injectContent();
    env2.startScan();
    await sleep(300);
    const cards2 = env2.cards();
    for (const q of picks) {
      const idx = cards2.findIndex(c => ((c.querySelector(".aa-stem") || {}).textContent || "").includes(q.question.slice(0, 18)));
      if (idx >= 0) await env2.clickAnswer(idx);
    }
    const fillBtn2 = [...env2.panel().querySelectorAll("button")].find(b => /填涂/.test(b.textContent));
    fillBtn2.click();
    for (let i = 0; i < 120; i++) { await sleep(50); if (/填涂结束/.test((env2.panel().querySelector(".aa-info") || {}).textContent || "")) break; }
    const checked2 = new Map(env2.checked().map(c => [c.stem.replace(/^\d+\.\s*/, "").slice(0, 18), c.idx]));
    for (const q of picks) {
      const got = checked2.get(q.question.slice(0, 18));
      const want = [...q.answer].sort((a, b) => a - b);
      t("多选项·肯定式线索填涂正确（" + q.options.length + " 选项）",
        JSON.stringify((got || []).slice().sort((a, b) => a - b)) === JSON.stringify(want),
        JSON.stringify(got) + " 期望 " + JSON.stringify(want));
    }
  }

  // ---------- ③ 填空题：多空逐个写对 ----------
  {
    const blanks = DATA.questions.filter(q => q.type === "blank").sort((a, b) => b.answers.length - a.answers.length);
    const picks = [blanks[0], blanks.find(q => q.answers.length === 2)].filter(Boolean);

    const env = T.makeEnv({
      html: PAGE, pageDir: QUIZ,
      storage: { mode: "ai", aiKey: "sk-test", interval: "0", answerMode: "standard" },
      aiReply: (() => {
        let n = 0;
        return () => {
          const q = picks[Math.min(n++, picks.length - 1)];
          const body = q.answers.map((a, i) => (i + 1) + ". " + a).join("\n");
          return { ok: true, text: body + "\n\n解析：测试用解析，不应被写进任何输入框。" };
        };
      })(),
    });
    env.runInlineScripts();
    await sleep(400);
    env.injectContent();
    env.startScan();
    await sleep(300);

    const cards = env.cards();
    for (const q of picks) {
      const idx = cards.findIndex(c => ((c.querySelector(".aa-stem") || {}).textContent || "").includes(q.question.slice(0, 16)));
      if (idx >= 0) await env.clickAnswer(idx);
    }
    const fillBtn = [...env.panel().querySelectorAll("button")].find(b => /填涂/.test(b.textContent));
    fillBtn.click();
    for (let i = 0; i < 120; i++) { await sleep(50); if (/填涂结束/.test((env.panel().querySelector(".aa-info") || {}).textContent || "")) break; }

    // 按题干定位每个空，逐个比对
    for (const q of picks) {
      const div = [...env.doc.querySelectorAll(".question")]
        .find(d => ((d.querySelector(".q-stem") || {}).textContent || "").includes(q.question.slice(0, 16)));
      const got = div ? [...div.querySelectorAll(".blank-input")].map(i => i.value) : [];
      t("多空填涂正确（" + q.answers.length + " 空）",
        JSON.stringify(got) === JSON.stringify(q.answers), JSON.stringify(got) + " 期望 " + JSON.stringify(q.answers));
      t("多空：解析文字没被写进输入框（" + q.answers.length + " 空）",
        !got.some(v => /解析|测试用/.test(v)), JSON.stringify(got));
    }
    t("多空：无未捕获异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 200));
  }

  // ---------- ④ 判分：整卷按真实答案填，应全对 ----------
  {
    const env = T.makeEnv({
      html: PAGE, pageDir: QUIZ,
      storage: { mode: "ai", aiKey: "sk-test", interval: "0", answerMode: "standard" },
      aiReply: { ok: true, text: "答案：A" },
    });
    env.runInlineScripts();
    await sleep(400);

    // 直接用页面 API 把正确答案填进去（绕过插件），验证页面判分本身没被新题型搞坏
    const res = await env.win.eval ? null : null;
    const scored = env.doc.querySelectorAll(".question").length;
    // 逐题填正确答案
    let filled = 0;
    [...env.doc.querySelectorAll(".question")].forEach((div, i) => {
      const q = DATA.questions[i];
      if (!q) return;
      if (q.type === "blank") {
        const ins = [...div.querySelectorAll(".blank-input")];
        q.answers.forEach((a, k) => { if (ins[k]) ins[k].value = a; });
        filled++;
      } else {
        const ins = [...div.querySelectorAll("input")];
        q.answer.forEach(k => { if (ins[k]) ins[k].checked = true; });
        filled++;
      }
    });
    env.doc.getElementById("submitBtn").click();
    await sleep(200);
    const score = env.doc.getElementById("score").textContent;
    const correct = env.doc.querySelectorAll(".question.answered-correct").length;
    t("整卷按正确答案填 → 判分全对", Number(score) === scored && correct === scored,
      "得分 " + score + " / " + scored + "，标对 " + correct);
    t("判分：无未捕获异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 200));
  }

  // ---------- ⑤ 加载失败时必须给出可照做的提示（不能静默白屏） ----------
  // 这条是实战踩出来的：用户双击 index.html（file://）打开，浏览器禁止 file:// fetch
  // 本地文件 → init() 抛错 → 页面停在初始状态（"共 0 题"、"--:--"、空下拉），
  // 看起来就像"练习页没有题"。以前 init() 没有任何错误处理。
  {
    const env = T.makeEnv({ html: PAGE, pageDir: QUIZ, storage: {}, aiReply: { ok: true, text: "A" } });
    env.sandbox.location = new URL("file://" + path.join(QUIZ, "index.html").replace(/\\/g, "/"));
    env.win.location = env.sandbox.location;
    const failFetch = async () => { throw new TypeError("Failed to fetch"); };
    env.win.fetch = failFetch;
    env.sandbox.fetch = failFetch;
    env.runInlineScripts();
    await sleep(400);
    const txt = env.doc.getElementById("questionList").textContent.replace(/\s+/g, " ").trim();
    t("加载失败时页面给出提示（不静默白屏）", txt.length > 50, txt.slice(0, 60));
    t("失败提示说明了 file:// 的限制", /file:\/\//.test(txt), txt.slice(0, 80));
    // 这两条以前断言的是"提示里要教用户起本地服务 + 给 localhost:8080 地址"。
    // 文档按要求去掉了本地练习页的启动说明与声明，页面提示同步改成"请用 http(s) 访问"，
    // 所以断言跟着改成对应新文案（不再要求出现 http.server / localhost:8080）。
    t("失败提示不再教用户起本地服务（已移除本地服务声明）",
      !/python -m http\.server/.test(txt) && !/localhost:8080/.test(txt), txt.slice(0, 90));
    t("失败提示给出了正确的访问方式（http(s) 打开）", /http\(s\):\/\//.test(txt) || /http:\/\//.test(txt), txt.slice(0, 90));
  }

  // ---------- 汇总 ----------
  console.log("----- 断言 -----");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  got=${JSON.stringify(r.got)}`);
  const all = results.every(r => r.ok);
  console.log(`\n===== ${all ? "ALL PASS ✅" : "HAS FAILURES ❌"} (${results.filter(r => r.ok).length}/${results.length}) =====`);
  process.exit(all ? 0 : 1);   // 页面有 setInterval，必须显式退出
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
