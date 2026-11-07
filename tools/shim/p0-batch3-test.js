"use strict";
/*
 * 第三批回归：一次抛错不能把标签页弄砖、停止要真的停止
 *
 * 修前（实测/审查得出）：
 *   · run() 没有 try/finally、调用点裸奔：.opt 里没有 input 的页面会让
 *     `q.inputs.some(inp => inp.checked)` 抛 TypeError → running 永远卡在 true →
 *     之后每次「开始答题」都在入口 if (running) return 静默失效，只能刷新页面。
 *   · 重建面板（再点一次「识别页面题目」）不停旧流水线：旧循环的守卫是 !scanPanel，
 *     而新面板马上就位 → 两条流水线并发烧 API、同时改页面。
 *   · popup 的「停止」只停 run()，管不到面板的「出答案 / 填涂」。
 *   · ✕ 用原生 confirm()：浏览器一旦"阻止此页面创建更多对话框"，恒返回 false，
 *     作答中面板再也关不掉。
 *   · ABORT_AI 中断**所有**标签页的在飞请求：A 页点停止，B 页成片失败。
 *
 * 跑法：node tools/shim/p0-batch3-test.js
 */
const T = require("./env");
const sleep = T.sleep;

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });
// 未处理的服务端/客户端 Promise 拒绝：修前的 run() 崩溃就是这个形态（不是同步异常）
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(String((e && e.message) || e)));

const HEAD = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"></head><body>";

// .question + .opt，但选项里**没有 input**（纯文本自绘选项）—— 修前在这里抛错
const NO_INPUT_PAGE = HEAD +
  "<div class=\"question\"><div class=\"q-stem\">1. 下列哪个是数据库？</div>" +
  "<div class=\"opt\">A. MySQL</div><div class=\"opt\">B. Nginx</div><div class=\"opt\">C. Redis</div></div>" +
  "<div class=\"question\"><div class=\"q-stem\">2. 下列哪个是缓存？</div>" +
  "<div class=\"opt\">A. MySQL</div><div class=\"opt\">B. Redis</div><div class=\"opt\">C. Nginx</div></div>" +
  "</body></html>";

const CHOICE_PAGE = HEAD +
  "<div class=\"question\"><div class=\"q-stem\">1. 下列哪个是数据库？</div>" +
  "<div class=\"opt\"><input type=\"radio\" name=\"q1\" value=\"0\"><span class=\"opt-text\">MySQL</span></div>" +
  "<div class=\"opt\"><input type=\"radio\" name=\"q1\" value=\"1\"><span class=\"opt-text\">Nginx</span></div>" +
  "<div class=\"opt\"><input type=\"radio\" name=\"q1\" value=\"2\"><span class=\"opt-text\">Redis</span></div></div>" +
  "<div class=\"question\"><div class=\"q-stem\">2. 下列哪个是缓存？</div>" +
  "<div class=\"opt\"><input type=\"radio\" name=\"q2\" value=\"0\"><span class=\"opt-text\">MySQL</span></div>" +
  "<div class=\"opt\"><input type=\"radio\" name=\"q2\" value=\"1\"><span class=\"opt-text\">Redis</span></div>" +
  "<div class=\"opt\"><input type=\"radio\" name=\"q2\" value=\"2\"><span class=\"opt-text\">Nginx</span></div></div>" +
  "<div class=\"question\"><div class=\"q-stem\">3. 下列哪个是 Web 服务器？</div>" +
  "<div class=\"opt\"><input type=\"radio\" name=\"q3\" value=\"0\"><span class=\"opt-text\">Nginx</span></div>" +
  "<div class=\"opt\"><input type=\"radio\" name=\"q3\" value=\"1\"><span class=\"opt-text\">Redis</span></div>" +
  "<div class=\"opt\"><input type=\"radio\" name=\"q3\" value=\"2\"><span class=\"opt-text\">MySQL</span></div></div>" +
  "</body></html>";

function boot(html, aiReply, extra) {
  const env = T.makeEnv(Object.assign({
    html, aiReply,
    storage: { mode: "ai", aiKey: "sk-test", aiModel: "mock", interval: "0", answerMode: "standard", showLog: true, concurrentEnabled: false, concurrency: 1 },
  }, extra || {}));
  env.runInlineScripts();
  env.injectContent();
  return env;
}

function runLog(env) {
  const el = env.doc.querySelector(".aa-runlog") || env.doc.querySelector("#aa-log");
  return el ? (el.textContent || "") : "";
}
function panel(env) { return env.doc.querySelector(".aa-panel"); }
function btn(env, re) {
  const p = panel(env);
  return p ? [...p.querySelectorAll("button")].find(b => re.test(b.textContent)) : null;
}
async function waitDone(env, tries = 80) {
  for (let i = 0; i < tries; i++) {
    await sleep(100);
    if (/完成：题库命中\s*\d+/.test(runLog(env))) break;
  }
  return runLog(env);
}

(async () => {
  // ============ ① 没有 input 的选项页：抛错不能再把插件弄砖 ============
  {
    const env = boot(NO_INPUT_PAGE, { ok: true, text: "答案：A" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    const firstRuns = (runLog(env).match(/开始自动作答/g) || []).length;
    t("① 第一轮跑完没有未处理的异常", unhandled.length === 0, JSON.stringify(unhandled).slice(0, 120));
    t("① 第一轮正常收尾（有「完成」行）", /完成：题库命中/.test(runLog(env)), (runLog(env).match(/完成：[^\n]*/) || [""])[0].slice(0, 70));

    // 关键：再点一次「开始答题」必须还能跑（修前 running 卡在 true，这里静默失效）
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    const secondRuns = (runLog(env).match(/开始自动作答/g) || []).length;
    t("① 第二轮「开始答题」仍然工作", secondRuns >= 2, `第一轮=${firstRuns} 第二轮=${secondRuns}`);
    t("① 全程没有未处理异常（崩溃会被这里抓到）", unhandled.length === 0, JSON.stringify(unhandled).slice(0, 120));
    t("① 取到答案但没落进页面时计入未答", /未答 [12]/.test(runLog(env)), (runLog(env).match(/完成：[^\n]*/) || [""])[0].slice(0, 70));
  }

  // ============ ② 重建面板必须停掉旧流水线 ============
  {
    let calls = 0;
    const env = boot(CHOICE_PAGE, async () => { calls++; await sleep(250); return { ok: true, text: "答案：A" }; });
    env.startScan();
    await sleep(150);
    const answerBtn = btn(env, /出答案/);
    answerBtn.click();
    await sleep(400);                       // 让旧面板出完 1~2 题
    const before = calls;
    t("② 旧面板已经在问 AI", before >= 1, before);

    env.startScan();                        // 重开面板（修前：旧循环继续跑）
    await sleep(900);
    const after = calls;
    t("② 重开面板后旧流水线不再继续问 AI", after === before, `重建前=${before} 重建后=${after}`);
    t("② 没有未处理异常", unhandled.length === 0, JSON.stringify(unhandled).slice(0, 100));
  }

  // ============ ③ popup「停止」要能叫停面板的填涂 ============
  {
    const env = boot(CHOICE_PAGE, async () => { await sleep(250); return { ok: true, text: "答案：A" }; });
    env.startScan();
    await sleep(150);
    const fillB = btn(env, /填涂/);
    fillB.click();
    await sleep(400);
    const checkedMid = env.checked().filter(q => q.idx.length).length;
    env.stop();                             // popup 的「停止」
    await sleep(700);
    const checkedAfter = env.checked().filter(q => q.idx.length).length;
    t("③ 停止前面板已经在写页面", checkedMid >= 1, `停止前已勾 ${checkedMid} 题`);
    t("③ popup「停止」叫停了面板的填涂", checkedAfter === checkedMid, `停止前=${checkedMid} 停止后=${checkedAfter}`);
  }

  // ============ ④ ✕ 不再依赖原生 confirm：第一次防误触，第二次才关 ============
  {
    const env = boot(CHOICE_PAGE, async () => { await sleep(250); return { ok: true, text: "答案：A" }; });
    env.startScan();
    await sleep(150);
    btn(env, /填涂/).click();
    await sleep(300);
    const closeB = btn(env, /✕/);
    t("④ 找到 ✕ 按钮且任务确实在跑", !!closeB && !!btn(env, /停止/), closeB ? closeB.textContent : "没有 ✕");
    closeB.click();                       // 第一次点击：只布防
    await sleep(50);
    t("④ 第一次点 ✕ 不关面板（改成二次确认，不再用原生 confirm）",
      !!panel(env) && /再点/.test(closeB.textContent), closeB.textContent);
    const before = env.checked().filter(q => q.idx.length).length;
    closeB.click();                       // 第二次：停止并关闭
    await sleep(200);
    t("④ 第二次点 ✕ 关闭面板", !panel(env), panel(env) ? "面板还在" : "已关闭");
    await sleep(700);
    const after = env.checked().filter(q => q.idx.length).length;
    t("④ 关闭同时停住了填涂（不再继续写页面）", after === before, `关闭前=${before} 关闭后=${after}`);
  }

  // ============ ⑤ ESC：焦点在页面输入框里时不抢 ============
  {
    const env = boot(CHOICE_PAGE.replace("</body>", "<input id=\"search\" type=\"text\"></body>"), { ok: true, text: "答案：A" });
    env.startScan();
    await sleep(150);
    t("⑤ 面板已打开", !!panel(env), "存在");

    const search = env.doc.getElementById("search");
    search.dispatchEvent(new T.dom.ShimEvent("keydown", { bubbles: true, key: "Escape" }));
    await sleep(100);
    t("⑤ 在页面输入框里按 ESC 不关面板、不中断作答", !!panel(env), panel(env) ? "面板还在" : "面板被关掉了");

    env.doc.dispatchEvent(new T.dom.ShimEvent("keydown", { bubbles: true, key: "Escape" }));
    await sleep(100);
    t("⑤ 空白处按 ESC 仍然关闭面板（老能力保留）", !panel(env), panel(env) ? "面板还在" : "已关闭");
  }

  // ============ ⑥ ABORT_AI 只掐发起标签页的请求 ============
  {
    const bg = T.makeBackground({
      storage: { aiKey: "sk-test", aiBaseUrl: "https://api.mock", aiModel: "m" },
      fetchImpl: (url, init) => new Promise((resolve, reject) => {
        const signal = init && init.signal;
        const timer = setTimeout(() => resolve({
          ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "答案：A" } }] }); }
        }), 500);
        if (signal) signal.addEventListener("abort", () => { clearTimeout(timer); reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })); });
      }),
    });
    const p1 = bg.send({ type: "AI_CHAT", payload: { baseUrl: "https://api.mock", key: "k", model: "m", messages: [] } }, { tab: { id: 1, windowId: 1 }, frameId: 0 });
    const p2 = bg.send({ type: "AI_CHAT", payload: { baseUrl: "https://api.mock", key: "k", model: "m", messages: [] } }, { tab: { id: 2, windowId: 2 }, frameId: 0 });
    await sleep(80);
    const abortReply = await bg.send({ type: "ABORT_AI" }, { tab: { id: 1, windowId: 1 }, frameId: 0 });
    const [r1, r2] = await Promise.all([p1, p2]);
    t("⑥ 只中断了发起标签页的 1 个请求", abortReply && abortReply.ok && abortReply.aborted === 1, JSON.stringify(abortReply));
    t("⑥ 标签页 1 的请求被中断（报超时/中断）", !!r1 && r1.ok === false && /超时|中断|abort/i.test(r1.error || ""), JSON.stringify(r1).slice(0, 90));
    t("⑥ 标签页 2 的请求不受影响，正常拿到答案", !!r2 && r2.ok === true && /答案：A/.test(r2.text || ""), JSON.stringify(r2).slice(0, 90));
  }

  console.log("----- 断言 -----");
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "  got=" + JSON.stringify(r.got));
  console.log(unhandled.length ? "\n[注意] 捕获到 " + unhandled.length + " 个未处理异常：" + JSON.stringify(unhandled).slice(0, 200) : "");
  const all = results.every(r => r.ok) && unhandled.length === 0;
  console.log("");
  console.log("===== " + (all ? "ALL PASS ✅" : "HAS FAILURES ❌") + " (" + results.filter(r => r.ok).length + "/" + results.length + ") =====");
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
