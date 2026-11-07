"use strict";
/*
 * 第六批回归：半题不说成功 / 结果窗不复活不串台 / 汇总不说谎 / 复制不谎报 / 429 退避重试
 *
 * 修前（本轮逐条核实过）：
 *   · 2 个空模型只回 1 行 → 也算「✓ 已填涂」、计入「已填 N 题」，第二个空是空的
 *   · mixed（弹窗默认推荐档）在题库没加载成功时**直接返回**，一次 AI 都不问
 *   · 收尾 toast「点这里看清单」调的是闭包里的 fillList → ReferenceError 被吞，点了没反应
 *   · 关掉的结果窗会被迟到回复/看门狗重新建出来；两次框选的回复互相覆盖（不带编号）
 *   · answerAll 先复位 stopFlag 再读它 → 中途停止也报绿色「出答案结束：共 N 道」
 *   · 复制按钮不 await 不 catch，无条件改「已复制」；非安全上下文里 navigator.clipboard 是
 *     undefined，点一下只抛异常（看着像按钮坏了）
 *   · 后台对 429/5xx 一次都不重试 → 限流时段成片漏答
 *
 * 跑法：node tools/shim/p0-batch6-test.js
 */
const fs = require("fs");
const path = require("path");
const T = require("./env");
const sleep = T.sleep;
const CJ = fs.readFileSync(path.join(T.EXT, "content.js"), "utf8");

// 判据只看「代码 + 用户可见文案」：整行注释里复述这段文字，是在解释「为什么要改」，
// 不是违规。原先直接对全文做 regex，结果一条"已修复"的说明把测试永久钉红。
const CJ_CODE = CJ.replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n").filter(l => !/^\s*\/\//.test(l)).join("\n");

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(String((e && e.message) || e)));

const HEAD = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"></head><body>";
const blankQ = (stem, n) => `<div class="question"><div class="q-stem">${stem}</div>` +
  Array.from({ length: n }, (_, i) => `<input class="blank-input" id="b${i}" type="text">`).join("") + "</div>";
const radioQ = (stem) => `<div class="question"><div class="q-stem">${stem}</div>` +
  ["MySQL", "Nginx", "Redis"].map((tx, i) =>
    `<div class="opt"><input type="radio" name="${stem}" value="${i}"><span class="opt-text">${tx}</span></div>`).join("") + "</div>";

const TWO_BLANKS = HEAD + blankQ("1. 中国的首都是 ____，人口约 ____ 万。", 2) + "</body></html>";
const ONE_BLANK = HEAD + blankQ("1. 中国的首都是 ____ 。", 1) + "</body></html>";
const CHOICE = HEAD + radioQ("1. 下列哪个是数据库？") + radioQ("2. 下列哪个是缓存？") + radioQ("3. 下列哪个是 Web 服务器？") + "</body></html>";

function boot(html, aiReply, extra) {
  const env = T.makeEnv(Object.assign({
    html, aiReply,
    storage: { mode: "ai", aiKey: "sk-test", aiModel: "mock", interval: "0", answerMode: "standard", showLog: true, concurrentEnabled: false, concurrency: 1 },
  }, extra || {}));
  env.runInlineScripts();
  env.injectContent();
  return env;
}
const runLog = env => ((env.doc.querySelector(".aa-runlog") || {}).textContent) || "";
const info = env => ((env.doc.querySelector(".aa-info") || {}).textContent) || "";
const cardText = env => {
  const c = env.cards()[0];
  const box = c && c.querySelector(".aa-answer");
  return box ? (box.textContent || "") : "";
};
async function waitDone(env, tries = 90) {
  for (let i = 0; i < tries; i++) {
    await sleep(200);
    if (/完成：题库命中\s*\d+/.test(runLog(env))) break;
  }
  return runLog(env);
}
function panelBtn(env, re) {
  const p = env.panel();
  return p ? [...p.querySelectorAll("button")].find(b => re.test(b.textContent)) : null;
}

(async () => {
  // ============ ① 半题：写进去的答案留着，但不算答完 ============
  {
    const env = boot(TWO_BLANKS, { ok: true, text: "北京" });     // 2 个空，模型只回 1 行
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    const vals = env.blanks();
    const log = runLog(env);
    t("① 第一空仍写上了（不把可用的答案丢掉）", vals[0] === "北京", JSON.stringify(vals));
    t("① 第二空留白（没被瞎猜填满）", vals[1] === "", JSON.stringify(vals));
    t("① 这一题不算答完：计入未答", /未答 1/.test(log), (log.match(/完成：[^\n]*/) || [""])[0].slice(0, 90));
    t("① 收尾不说「已填 1 题」", !/已填 1 题/.test((( env.doc.querySelector(".aa-toast-text") || {}).textContent) || ""),
      ((env.doc.querySelector(".aa-toast-text") || {}).textContent || "").slice(0, 40));
    t("① 说清楚还差几个空", /只填上 1 个空，还差 1 个/.test(log), (log.match(/[^\n]*只填上[^\n]*/) || ["(没有这行)"])[0].slice(0, 70));
  }
  {
    const env = boot(ONE_BLANK, { ok: true, text: "北京" });       // 1 个空、回 1 行 = 完整
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    t("①b 单空回一行仍算答完（没被误判成半题）", /未答 0/.test(runLog(env)), (runLog(env).match(/完成：[^\n]*/) || [""])[0].slice(0, 90));
  }
  {
    // 面板「✍ 填涂」这条路径同样要说半题
    const env = boot(TWO_BLANKS, { ok: true, text: "北京" });
    env.startScan();
    await sleep(250);
    panelBtn(env, /填涂/).click();
    await sleep(2500);
    t("①c 面板填涂也把半题单列出来", /半题 1/.test(info(env)), info(env).slice(0, 90));
    t("①d 卡片不说「✓ 已填涂」", !/✓ 已填涂/.test(cardText(env)), cardText(env).slice(0, 70));
  }

  // ============ ② mixed 不再被"题库没加载成功"早退挡死 ============
  {
    const guarded = /if \(!bankIndex && !q\.fillText && settings\.mode === "bank"\)/.test(CJ);
    t("② 早退只在纯题库模式生效（mixed 继续走 AI 兜底）", guarded, "源码判据");
    t("② 提示不再自相矛盾（不再叫用户「改用题库 + AI 兜底」）",
      !/改用「题库 \+ AI 兜底」/.test(CJ_CODE), "源码（已剔除注释）");
    // 行为面：mixed 下题库命中不了的题仍然要问 AI
    const env = boot(CHOICE, { ok: true, text: "答案：A" }, { storage: { mode: "mixed", aiKey: "sk-test", interval: "0", showLog: true, bankBaseUrl: "http://127.0.0.1:9/none/" } });
    env.start({ mode: "mixed", aiKey: "sk-test", intervalMs: 0, showLog: true, bankBaseUrl: "http://127.0.0.1:9/none/" });
    await waitDone(env);
    t("②b mixed 下确实发出了 AI 请求并答上", env.stats.aiCalls.length >= 1 && /AI 作答 [123]/.test(runLog(env)),
      { ai: env.stats.aiCalls.length, 尾行: (runLog(env).match(/完成：[^\n]*/) || [""])[0].slice(0, 60) });
  }

  // ============ ③ 收尾 toast 的「点这里看清单」真的会刷新列表 ============
  {
    const env = boot(CHOICE, { ok: true, text: "答案：A" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    const old = env.cards()[0];
    const toastText = env.doc.querySelector(".aa-toast-text");
    t("③ 收尾 toast 存在", !!toastText, "ok");
    toastText.click();
    await sleep(400);
    const rebuilt = env.cards()[0] !== old;
    t("③ 点一下确实重建了题卡（修前抛 ReferenceError、什么都不会发生）", rebuilt,
      rebuilt ? "列表已刷新" : "卡片没变（死链）");
    t("③ 无未处理异常", unhandled.length === 0, JSON.stringify(unhandled).slice(0, 100));
  }

  // ============ ④ 结果窗：关掉不复活、旧框选的回复不覆盖新的 ============
  async function shoot(env) {
    const p = env.panel();
    const shot = [...p.querySelectorAll("button")].find(b => b.textContent.trim() === "📷");
    shot.click();
    const ov = env.doc.querySelector(".aa-overlay");
    ov.dispatchEvent(new T.dom.ShimEvent("mousedown", { bubbles: true, button: 0, clientX: 10, clientY: 10 }));
    ov.dispatchEvent(new T.dom.ShimEvent("mouseup", { bubbles: true, clientX: 120, clientY: 90 }));
    await sleep(60);
  }
  {
    const env = boot(CHOICE, { ok: true, text: "答案：A" });
    env.startScan();
    await sleep(250);
    await shoot(env);
    t("④ 结果窗已出现", !!env.doc.querySelector(".aa-result"), "ok");
    const close = [...env.doc.querySelector(".aa-result").querySelectorAll("button")].find(b => /关闭/.test(b.textContent));
    close.click();
    await sleep(60);
    t("④ 关闭后窗不见了", !env.doc.querySelector(".aa-result"), "ok");
    // 模拟后台迟到的回复（带着刚被关掉那次的编号）
    env.sandbox.chrome.__fire({ type: "ANSWER", shotId: 1, ok: true, text: "迟到的旧答案" });
    await sleep(80);
    t("④ 迟到的回复不会把窗重新建出来", !env.doc.querySelector(".aa-result"), "复活了" );
    // 两次框选：第二次的结果不能被第一次的迟到回复盖掉
    await shoot(env);
    env.sandbox.chrome.__fire({ type: "ANSWER", shotId: 2, ok: true, text: "第二次的答案" });
    await sleep(60);
    env.sandbox.chrome.__fire({ type: "ANSWER", shotId: 1, ok: true, text: "第一次的迟到答案" });
    await sleep(60);
    const body = (env.doc.querySelector(".aa-result-body") || {}).textContent || "";
    t("④ 旧框选的回复不覆盖当前这次的答案", body === "第二次的答案", JSON.stringify(body));
  }

  // ============ ⑤ 出答案中途停止：汇总要说"已停止"，不能一律绿色 ============
  {
    const env = boot(CHOICE, async () => { await sleep(700); return { ok: true, text: "答案：A" }; });
    env.startScan();
    await sleep(250);
    panelBtn(env, /出答案/).click();
    await sleep(400);
    const stop = panelBtn(env, /停止/);
    t("⑤ 批量中能看到「■ 停止」", !!stop, stop && stop.textContent);
    stop.click();
    await sleep(2500);
    const msg = info(env);
    t("⑤ 停止后汇总说「已停止」（修前是绿色的「出答案结束」）", /已停止「出答案」/.test(msg), msg.slice(0, 70));
    t("⑤ 不再出现「出答案结束：共 N 道」那种报喜说法", !/出答案结束/.test(msg), msg.slice(0, 70));
  }

  // ============ ⑥ 复制：不支持/失败都不谎报成功 ============
  {
    const env = boot(CHOICE, { ok: true, text: "答案：A" });
    env.startScan();
    await sleep(250);
    await shoot(env);
    env.sandbox.chrome.__fire({ type: "ANSWER", shotId: 1, ok: true, text: "1. B 因为…" });
    await sleep(80);
    const rp = env.doc.querySelector(".aa-result");
    const copy = [...rp.querySelectorAll("button")].find(b => /复制/.test(b.textContent));
    t("⑥ 台架里没有 navigator.clipboard（等同 http 页面的真实情况）",
      !(env.sandbox.navigator && env.sandbox.navigator.clipboard), JSON.stringify(Object.keys(env.sandbox.navigator || {})));
    copy.click();
    await sleep(150);
    t("⑥ 不写「已复制」，改说失败并教用户怎么办", /复制失败|手动选中/.test(copy.textContent) && !/已复制/.test(copy.textContent), copy.textContent);
    t("⑥ 点了不抛未处理异常", unhandled.length === 0, JSON.stringify(unhandled).slice(0, 100));
  }

  // ============ ⑦ 429/5xx 退避重试（跑真实 background.js） ============
  {
    let calls = 0;
    const bg = T.makeBackground({
      storage: { aiKey: "sk-test", aiBaseUrl: "https://api.mock", aiModel: "m" },
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return { ok: false, status: 429, headers: { get: () => null }, async text() { return "rate limited"; } };
        return { ok: true, status: 200, headers: { get: () => null }, async text() { return JSON.stringify({ choices: [{ message: { content: "答案：C" } }] }); } };
      },
    });
    const r = await bg.send({ type: "AI_CHAT", payload: { baseUrl: "https://api.mock", key: "k", model: "m", messages: [] } });
    t("⑦ 429 之后会重试并最终成功", calls === 2 && r && r.ok === true, { calls, ok: r && r.ok });

    let calls400 = 0;
    const bg2 = T.makeBackground({
      storage: {},
      fetchImpl: async () => { calls400++; return { ok: false, status: 400, headers: { get: () => null }, async text() { return "bad model"; } } },
    });
    await bg2.send({ type: "AI_CHAT", payload: { baseUrl: "https://api.mock", key: "k", model: "m", messages: [] } });
    t("⑦b 400（配置问题）不重试，不白等一轮", calls400 === 1, calls400);

    let calls503 = 0;
    const bg3 = T.makeBackground({
      storage: {},
      fetchImpl: async () => { calls503++; return { ok: false, status: 503, headers: { get: () => null }, async text() { return "down" } }; },
    });
    await bg3.send({ type: "AI_CHAT", payload: { baseUrl: "https://api.mock", key: "k", model: "m", messages: [] } });
    t("⑦c 持续 503 时最多重试 2 次就止损", calls503 === 3, calls503);

    let callsRA = 0;
    const t0 = Date.now();
    const bg4 = T.makeBackground({
      storage: {},
      fetchImpl: async () => {
        callsRA++;
        if (callsRA === 1) return { ok: false, status: 429, headers: { get: h => "retry-after" === h ? "0" : null }, async text() { return "" } };
        return { ok: true, status: 200, headers: { get: () => null }, async text() { return JSON.stringify({ choices: [{ message: { content: "答案：A" } }] }); } };
      },
    });
    await bg4.send({ type: "AI_CHAT", payload: { baseUrl: "https://api.mock", key: "k", model: "m", messages: [] } });
    t("⑦d 尊重 Retry-After（给 0 秒就别硬等 800ms）", callsRA === 2 && Date.now() - t0 < 600, { calls: callsRA, ms: Date.now() - t0 });
  }

  console.log("----- 断言 -----");
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "  got=" + JSON.stringify(r.got));
  const all = results.every(r => r.ok) && unhandled.length === 0;
  console.log("");
  console.log("===== " + (all ? "ALL PASS ✅" : "HAS FAILURES ❌") + " (" + results.filter(r => r.ok).length + "/" + results.length + ") =====");
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
