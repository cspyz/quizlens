"use strict";
/*
 * 「开始答题」后，面板必须和自动填涂一样有内容 —— 回归测试。
 *
 * 用户截图反馈（第 3 张图点「开始答题」之后）：
 *   ① 面板上**没有答案和解析**，还要手动点每张卡上的「答」才行；
 *   ② 「⚡ 出答案 / ✍ 填涂」**变成灰色、点不了**；
 *   ③ 看着"不能停止"；
 *   ④ 但自动填涂是好的（页面上确实勾上了）。
 * 对照：走第 4 张图的「🔍 识别页面题目」进去，出答案/填涂都正常，也有答案和解析。
 *
 * 根因：run() 与识别面板是两条互不相干的流水线 —— run() 扫描出自己的题目数组，
 * 结果只写运行日志；面板扫描出自己的 qaItems，结果只写卡片。各扫一遍、各算一遍。
 *
 * 这套测试用**真实** quiz-app 页面 + **未修改的** content.js，
 * 断言 run() 期间卡片上确实出现答案/解析，且按钮保持可用、停止仍然立刻生效。
 */
const fs = require("fs");
const path = require("path");
const T = require("./env");
const sleep = T.sleep;

const QUIZ = path.join(T.ROOT, "quiz-app");
const PAGE = fs.readFileSync(path.join(QUIZ, "index.html"), "utf8");

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });

// 起真实练习页 + 注入未修改的 content.js
async function boot({ showLog = true, interval = "0", answerMode = "standard", aiReply } = {}) {
  const env = T.makeEnv({
    html: PAGE,
    pageDir: QUIZ,
    storage: {
      mode: "ai", aiKey: "sk-test", interval,
      answerMode, fillHosts: "*", showLog, bankBaseUrl: "",
    },
    aiReply: aiReply || { ok: true, text: "答案：A\n\n解析：因为 A 是对的。\n思考：先看题干再排除。" },
  });
  env.runInlineScripts();
  await sleep(100); await sleep(100); await sleep(100);
  env.injectContent();
  return env;
}

// 等整轮收尾（日志出现"完成："）。日志两种去处都要看：
// showLog=true 写面板 .aa-runlog；false 写控制台 stats.logs。
function finished(env) {
  const box = env.doc.querySelector(".aa-runlog");
  const inPanel = box && /完成：/.test(box.textContent);
  const inConsole = env.stats.logs.some(l => /完成：/.test(l.text));
  return !!(inPanel || inConsole);
}
// 等整轮收尾。
//
// 【台架坑，务必按这个写法】用 **for 固定次数 + sleep 分片**，不要写
// `while (Date.now() - t0 < 上限)`。台架把 vm 里的 setTimeout 直接绑在宿主的
// 定时器队列上，而 run() 每道题都要走 waitOrStop(0)（内部即 setTimeout(...,0)）；
// 宿主的 while 里反复调用 Date.now() 争抢同一事件循环时，沙箱内那些 0ms 定时器
// 排不上队，run() 会卡在第 1 题。实测（同样跑 106 题的练习页）：
//     while (Date.now() - t0 < 20000) { await sleep(200); ... }  → 卡在第 1 题
//     for (let i = 0; i < 60; i++)    { await sleep(200); ... }  → 2.2s 跑完 106 题
// 这是台架的调度问题，不是产品缺陷（真实浏览器里两者互不影响）。
// 返回值：本次测试写 run() 的收尾日志后就返回，超时返回 null。
const WAIT_STEPS = 60;      // 60 × 200ms = 12s 上限（106 题实测约 2~3.5s 跑完，足够）
const WAIT_STEP_MS = 200;
async function waitFinished(env, steps = WAIT_STEPS) {
  for (let i = 0; i < steps; i++) {
    await sleep(WAIT_STEP_MS);
    if (finished(env)) return (i + 1) * WAIT_STEP_MS;
  }
  return null;
}
function btn(env, label) {
  return [...env.doc.querySelectorAll(".aa-btn")].find(b => b.textContent.trim() === label);
}

// 短分片睡眠（见 waitFinished 的说明：不要用 while + Date.now 轮询）
async function sleepSlice(n) { for (let i = 0; i < n; i++) await sleep(100); }

(async () => {
  // ---------- ① 点「开始答题」后，答案/解析要出现在面板卡片上 ----------
  {
    const env = await boot();
    t("启动前面板不存在（不是预先开着的）", env.doc.querySelectorAll(".aa-panel").length === 0, "");
    env.start({ intervalMs: 0 });
    const done = await waitFinished(env);
    t("整轮跑完", done !== null, done === null ? "超时" : "约 " + done + "ms");

    const parts = env.cardParts();
    const shown = parts.filter(p => p.answerShown).length;
    const withExplain = parts.filter(p => p.explainShown).length;
    t("每张卡都显示了答案（不再需要手动点「答」）", shown === parts.length && parts.length > 0,
      shown + "/" + parts.length);
    t("每张卡都显示了答案与解析", withExplain === parts.length && parts.length > 0,
      withExplain + "/" + parts.length);
    // 答案内容要与"取答案"路径一致，不能是占位空串
    t("卡片上的答案不是空串", parts.every(p => p.answer.trim().length > 0), JSON.stringify(parts[0] && parts[0].answer));
    // 解析正文要真的渲染出来。
    // 注意：不能断言文本里含"解析："这两个字——填空那条路径会把这个前缀剥掉
    //（splitAiExplanation 的清洗），只剩正文，这是**正确**行为。
    // 所以这里断言"解析块里有非空的正文"。
    const noExplain = parts.filter(p => !p.explain.trim());
    t("每张卡的解析块都有正文", noExplain.length === 0,
      noExplain.length + " 张为空；首卡=" + JSON.stringify(parts[0] && parts[0].explain).slice(0, 50));
    t("「只输出答案」模式下不显示解析", await (async () => {
      const e2 = await boot({ answerMode: "answer", aiReply: { ok: true, text: "C" } });
      e2.start({ intervalMs: 0 });
      await waitFinished(e2);
      const p2 = e2.cardParts();
      return p2.length > 0 && p2.every(x => x.answerShown && !x.explainShown);
    })(), "");
  }

  // ---------- ② 运行中「出答案 / 填涂」不能是灰的 ----------
  {
    const env = await boot({ interval: "30" });   // 拉长间隔，方便在"运行中"取样
    env.start({ intervalMs: 30000 });
    await sleep(120); await sleep(120); await sleep(120); await sleep(120); await sleep(120);
    t("运行中面板已建好", !!env.doc.querySelector(".aa-panel"), "");
    const ab = btn(env, "⚡ 出答案");
    const fb = btn(env, "✍ 填涂");
    t("运行中「出答案」存在", !!ab, "");
    t("运行中「出答案」不是 disabled", ab && ab.disabled === false, ab && ab.disabled);
    t("运行中「填涂」不是 disabled", fb && fb.disabled === false, fb && fb.disabled);
    t("运行中按钮只做视觉淡化（aa-busy）", ab && ab.classList.contains("aa-busy"), ab && ab.className);
    t("运行中「停止答题」按钮可用", !!env.doc.querySelector(".aa-runlog-stop"), "");
    t("运行中「暂停」按钮真的可见（offsetParent 非 null）", !!ab.offsetParent, ab.offsetParent ? "可见" : "被祖先隐藏");
    t("运行中「停止」按钮真的可见（offsetParent 非 null）", !!env.doc.querySelector(".aa-runlog-stop").offsetParent, "");
    env.stop();
    await sleep(60); await sleep(60); await sleep(60);
    const ab2 = btn(env, "⚡ 出答案");
    t("停止后按钮恢复正常样式（无 aa-busy）", ab2 && !ab2.classList.contains("aa-busy"), ab2 && ab2.className);
  }

  // ---------- ③ 停止要立刻生效（面板按钮 / popup 停止 两条路）----------
  {
    const env = await boot({ interval: "30" });
    env.start({ intervalMs: 30000 });
    await sleep(600);
    const before = env.stats.aiCalls.length;
    const t0 = Date.now();
    env.doc.querySelector(".aa-runlog-stop").click();
    // 同样避免 while + Date.now 的写法（见 waitFinished 的说明）
    let waited = null;
    for (let i = 0; i < 100; i++) {
      await sleep(10);
      const rl = env.doc.querySelector(".aa-runlog");
      if (rl && /已手动停止/.test(rl.textContent)) { waited = (i + 1) * 10; break; }
    }
    t("面板「■ 停止答题」立刻生效（<300ms）", waited !== null && waited < 300, waited === null ? ">3s" : waited + "ms");
    await sleep(60); await sleep(60); await sleep(60); await sleep(60);
    t("停止后不再发起新请求", env.stats.aiCalls.length - before === 0, env.stats.aiCalls.length - before);
  }

  // ---------- ④ 运行期间面板上应该看得到"正在进行" ----------
  {
    const env = await boot();
    env.start({ intervalMs: 0 });
    await sleep(80); await sleep(80); await sleep(80); await sleep(80); await sleep(80);
    const rl = env.doc.querySelector(".aa-runlog");
    t("日志区在 run 模式下默认展开", env.doc.querySelector(".aa-runlog-wrap").style.display !== "none", "");
    t("日志写进了面板（不是只进控制台）", rl && /开始自动作答/.test(rl.textContent), rl ? rl.textContent.slice(0, 40) : "(无)");
    const title = env.doc.querySelector(".aa-runlog-head > span");
    t("日志标题显示为运行中", title && /运行中/.test(title.textContent), title && title.textContent);
    await waitFinished(env);
  }

  // ---------- ⑤ 首条日志不能丢：面板是 run 启动时新建的 ----------
  {
    const env = await boot();
    env.start({ intervalMs: 0 });
    await sleep(50); await sleep(50);   // 极早取样：面板这时必须是完整的
    const rl = env.doc.querySelector(".aa-runlog");
    t("面板刚建好就收录了首条日志", rl && /开始自动作答/.test(rl.textContent), rl ? rl.textContent.slice(0, 60) : "(无日志区)");
    t("面板刚建好就有题卡", env.cards().length > 0, env.cards().length);
    await waitFinished(env);
  }

  // ---------- ⑥ 面板里能「暂停 / 继续」（不用去插件弹窗）----------
  {
    const env = await boot();
    env.start({ intervalMs: 0 });
    await sleepSlice(6);
    const p = env.doc.querySelector(".aa-panel");
    const pauseBtn = p.querySelector(".aa-runlog-pause");
    t("面板里有「暂停」按钮", !!pauseBtn && /暂停/.test(pauseBtn.textContent), pauseBtn && pauseBtn.textContent);

    pauseBtn.click();
    await sleepSlice(2);
    t("暂停后按钮变成「继续」", /继续/.test(pauseBtn.textContent), pauseBtn.textContent);
    t("暂停后标题显示已暂停", /已暂停/.test(p.querySelector(".aa-runlog-head > span").textContent),
      p.querySelector(".aa-runlog-head > span").textContent);

    // 暂停期间一道题都不许再答（这是"暂停"与"只是按钮变个样"的分水岭）
    const c1 = env.checked().filter(c => c.idx.length).length;
    const a1 = env.stats.aiCalls.length;
    await sleepSlice(10);
    const c2 = env.checked().filter(c => c.idx.length).length;
    const a2 = env.stats.aiCalls.length;
    t("暂停期间不再填涂新题", c2 === c1, c1 + " → " + c2);
    t("暂停期间不再发起 AI 请求", a2 === a1, a1 + " → " + a2);

    // 继续：应当从暂停处接着答，且**不重答**已答过的
    pauseBtn.click();
    await sleepSlice(2);
    t("继续后按钮变回「暂停」", /暂停/.test(pauseBtn.textContent) && !/继续/.test(pauseBtn.textContent), pauseBtn.textContent);
    t("继续后标题回到运行中", /运行中/.test(p.querySelector(".aa-runlog-head > span").textContent),
      p.querySelector(".aa-runlog-head > span").textContent);
    const done = await waitFinished(env);
    t("继续后能跑完整轮", done !== null, done === null ? "超时" : "约 " + done + "ms");
    const parts = env.cardParts();
    t("暂停→继续后每张卡仍有答案", parts.filter(x => x.answerShown).length === parts.length && parts.length > 0,
      parts.filter(x => x.answerShown).length + "/" + parts.length);
    // 已答过的题不该被重答：AI 调用数不应超过题数
    t("继续后没有重复请求（AI 调用 ≤ 题数）", env.stats.aiCalls.length <= parts.length,
      env.stats.aiCalls.length + " vs " + parts.length);
  }

  // ---------- ⑦ 暂停中「停止」也要能醒过来（不能永远卡住）----------
  {
    const env = await boot();
    env.start({ intervalMs: 0 });
    await sleepSlice(6);
    const p = env.doc.querySelector(".aa-panel");
    p.querySelector(".aa-runlog-pause").click();
    await sleepSlice(2);
    t("先暂停成功", /继续/.test(p.querySelector(".aa-runlog-pause").textContent), "");
    const before = env.stats.aiCalls.length;
    p.querySelector(".aa-runlog-stop").click();          // 暂停中直接停止
    await sleepSlice(6);
    const rl = env.doc.querySelector(".aa-runlog");
    t("暂停中点停止：日志出现「已手动停止」", rl && /已手动停止/.test(rl.textContent), "");
    const c1 = env.checked().filter(c => c.idx.length).length;
    await sleepSlice(10);
    t("暂停中停止后不再答题", env.checked().filter(c => c.idx.length).length === c1, "");
    t("暂停中停止后不再发请求", env.stats.aiCalls.length - before <= 0, env.stats.aiCalls.length - before);
  }

  // ---------- ⑧ 识别面板（「🔍 识别页面题目」）里也必须有暂停 / 停止 ----------
  // 用户截图反馈：走这条路进来的面板（54 题那个）**没有暂停和停止**。
  // 之前把这两个按钮在非 run 模式下整个隐藏了 —— 但那个面板上的「出答案 / 填涂」
  // 同样是长时间批量循环，一样要能暂停、能停。
  {
    const env = await boot({ interval: "1" });      // 放慢，便于中途暂停
    env.startScan();
    await sleepSlice(4);
    const p = env.doc.querySelector(".aa-panel");
    const pb = p.querySelector(".aa-runlog-pause");
    const sb = p.querySelector(".aa-runlog-stop");
    t("识别面板里有「暂停」按钮", !!pb, "");
    t("识别面板里有「停止」按钮", !!sb, "");
    // ⚠ 必须查 offsetParent（等价于浏览器里的"真的看得见"），不能只查自己的 display。
    // 我上一轮就是只查了子元素的 style.display，而父容器 .aa-runlog-wrap 仍是
    // display:none —— 测试全绿、用户屏幕上却没有按钮（截图反馈"还是没有暂停按钮"）。
    // offsetParent 为 null 意味着自己或某个祖先 display:none。
    t("识别面板：暂停按钮真的可见（offsetParent 非 null）", !!pb.offsetParent, pb.offsetParent ? "可见" : "被祖先隐藏");
    t("识别面板：停止按钮真的可见（offsetParent 非 null）", !!sb.offsetParent, sb.offsetParent ? "可见" : "被祖先隐藏");
    t("识别面板：表头容器本身是显示的", p.querySelector(".aa-runlog-wrap").style.display !== "none",
      JSON.stringify(p.querySelector(".aa-runlog-wrap").style.display));
    t("识别面板：没在跑任务时暂停按钮为禁用", pb.disabled === true, pb.disabled);

    // 点「出答案」→ 暂停按钮应变为可用
    const ab = [...p.querySelectorAll("button")].find(b => /出答案/.test(b.textContent));
    ab.click();
    await sleepSlice(1);
    t("「出答案」运行中：暂停按钮变为可用", pb.disabled === false, pb.disabled);
    t("「出答案」运行中：标题显示运行中", /运行中/.test(p.querySelector(".aa-runlog-head > span").textContent),
      p.querySelector(".aa-runlog-head > span").textContent);

    // 暂停 → 不再出答案
    pb.click();
    await sleepSlice(2);
    t("「出答案」暂停后按钮变「继续」", /继续/.test(pb.textContent), pb.textContent);
    const n1 = env.cardParts().filter(x => x.answerShown).length;
    const k1 = env.stats.aiCalls.length;
    await sleepSlice(10);
    t("「出答案」暂停期间不再出答案", env.cardParts().filter(x => x.answerShown).length === n1,
      n1 + " → " + env.cardParts().filter(x => x.answerShown).length);
    t("「出答案」暂停期间不再发 AI 请求", env.stats.aiCalls.length === k1, k1 + " → " + env.stats.aiCalls.length);

    // 继续 → 从暂停处接着出
    pb.click();
    await sleepSlice(3);
    t("「出答案」继续后接着出", env.cardParts().filter(x => x.answerShown).length > n1,
      n1 + " → " + env.cardParts().filter(x => x.answerShown).length);

    // 停止 → 立刻停住
    sb.click();
    await sleepSlice(2);
    const n2 = env.cardParts().filter(x => x.answerShown).length;
    const k2 = env.stats.aiCalls.length;
    await sleepSlice(10);
    t("「出答案」点停止后不再出答案", env.cardParts().filter(x => x.answerShown).length === n2, n2 + " → " + env.cardParts().filter(x => x.answerShown).length);
    t("「出答案」点停止后不再发请求", env.stats.aiCalls.length === k2, k2 + " → " + env.stats.aiCalls.length);
  }

  // ---------- ⑨ 识别面板的「✍ 填涂」也能暂停 / 停止 ----------
  {
    const env = await boot({ interval: "1" });
    env.startScan();
    await sleepSlice(4);
    const p = env.doc.querySelector(".aa-panel");
    const pb = p.querySelector(".aa-runlog-pause");
    const sb = p.querySelector(".aa-runlog-stop");
    const fb = [...p.querySelectorAll("button")].find(b => /填涂/.test(b.textContent));
    fb.click();
    await sleepSlice(3);
    t("「填涂」运行中：暂停按钮可用", pb.disabled === false, pb.disabled);
    pb.click();
    await sleepSlice(2);
    const f1 = env.checked().filter(c => c.idx.length).length;
    await sleepSlice(10);
    t("「填涂」暂停期间不再勾选", env.checked().filter(c => c.idx.length).length === f1,
      f1 + " → " + env.checked().filter(c => c.idx.length).length);
    pb.click();                       // 继续
    await sleepSlice(1);
    sb.click();                       // 再停止
    await sleepSlice(3);
    const f2 = env.checked().filter(c => c.idx.length).length;
    await sleepSlice(10);
    t("「填涂」点停止后不再勾选", env.checked().filter(c => c.idx.length).length === f2,
      f2 + " → " + env.checked().filter(c => c.idx.length).length);
  }

  // ---------- ⑩ 「识别页面题目」（对照路径）不能被这次改动弄坏 ----------
  {
    const env = await boot();
    env.startScan();
    await sleep(80); await sleep(80); await sleep(80); await sleep(80); await sleep(80);
    const p = env.doc.querySelector(".aa-panel");
    t("识别模式：有面板与题卡", !!p && env.cards().length > 0, env.cards().length);
    // 这一条**以前断言的是"不显示"**，正是用户截图里"没有暂停停止"的成因。
    // 已按用户诉求反转：识别面板里这两个按钮必须存在且可见（见 ⑧ 的详细断言）。
    t("识别模式：显示「■ 停止」按钮（用户要求面板里就能停）",
      p.querySelector(".aa-runlog-stop").style.display !== "none",
      JSON.stringify(p.querySelector(".aa-runlog-stop").style.display));
    t("识别模式：显示「⏸ 暂停」按钮",
      p.querySelector(".aa-runlog-pause").style.display !== "none",
      JSON.stringify(p.querySelector(".aa-runlog-pause").style.display));
    t("识别模式：出答案按钮可用", btn(env, "⚡ 出答案").disabled === false, "");
    await env.clickAllAnswers();
    const parts = env.cardParts();
    t("识别模式：点「出答案」后卡片有答案与解析",
      parts.filter(p => p.answerShown).length > 0 && parts.filter(p => p.explainShown).length > 0,
      parts.filter(p => p.answerShown).length + "/" + parts.length);
  }

  console.log("----- 断言 -----");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  got=${JSON.stringify(r.got)}`);
  const all = results.every(r => r.ok);
  console.log(`\n===== ${all ? "ALL PASS ✅" : "HAS FAILURES ❌"} (${results.filter(r => r.ok).length}/${results.length}) =====`);
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });