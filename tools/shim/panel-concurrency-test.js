"use strict";
/*
 * 「面板上的并发」回归测试。
 *
 * 背景：并发设置一开始只接到了「开始答题」(run) 上，面板上的
 * 「⚡ 出答案」「✍ 填涂」两个循环照旧无条件串行 —— 用户从面板走的时候，
 * 开关和数字怎么调都毫无效果，看起来就像"并发是写死的"。
 * 根因是同一个设置项被两处代码各解析了一遍（一处读了、一处没读）。
 * 现在三条流水线共用 resolveConcurrency()，这个测试钉住"面板也生效"。
 */
const T = require("./env");
const sleep = T.sleep;

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });

// 页面形状要与 env.pageHtml 一致（题干含"下列哪个…"这类措辞），
// 否则通用识别不会把它当成题 —— 踩过：自己随手写的 <div class="question"> 只识别出 1 张卡。
function makePage(n) {
  let h = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"><title>panel-conc</title></head><body>";
  for (let i = 1; i <= n; i++) {
    h += "<div class=\"question\">" +
      "<div class=\"q-stem\">" + i + ". 下列哪个是第" + i + "个选项？</div>" +
      "<div class=\"opt\"><input type=\"radio\" name=\"q" + i + "\" value=\"0\"><span class=\"opt-text\">选项一</span></div>" +
      "<div class=\"opt\"><input type=\"radio\" name=\"q" + i + "\" value=\"1\"><span class=\"opt-text\">选项二</span></div>" +
      "<div class=\"opt\"><input type=\"radio\" name=\"q" + i + "\" value=\"2\"><span class=\"opt-text\">选项三</span></div>" +
      "</div>";
  }
  return h + "</body></html>";
}

async function boot(opts) {
  const o = opts || {};
  const n = o.n || 6;
  const concurrency = o.concurrency || 4;
  const concurrentEnabled = o.concurrentEnabled !== false;
  const delay = o.delay || 80;
  const inflight = { now: 0, max: 0 };
  const env = T.makeEnv({
    html: makePage(n),
    storage: { mode: "ai", aiKey: "sk-test", interval: "0", concurrency, concurrentEnabled, showLog: true, fillHosts: "*", bankBaseUrl: "" },
    aiReply: () => {
      inflight.now++;
      if (inflight.now > inflight.max) inflight.max = inflight.now;
      return new Promise(res => setTimeout(() => { inflight.now--; res({ ok: true, text: "A" }); }, delay));
    },
  });
  env.runInlineScripts();
  await sleep(60);
  env.injectContent();
  env.startScan();          // 打开「识别页面题目」面板
  await sleep(400);
  return { env, inflight };
}

const btn = (env, text) => [...env.doc.querySelectorAll(".aa-panel button")].find(b => b.textContent.trim() === text);
function checkedCount(env) {
  return [...env.doc.querySelectorAll(".question")].filter(q => [...q.querySelectorAll("input")].some(x => x.checked)).length;
}
// 点按钮并等它真的结束。
// ⚠ 不能只等"按钮文字里没有『停止』"——按钮要等 async 函数跑到第一条 await 之后
//    才会变成「■ 停止 N/M」，一开始点下去它还是原文字，循环会立刻退出、结果被低估。
//    正确做法：先等它进入运行态（出现「停止」），再等它退出运行态。
async function runBtn(env, text, steps) {
  const b = btn(env, text);
  b.click();
  const total = (steps || 400);
  let sawRunning = false;
  for (let i = 0; i < total; i++) {
    await sleep(50);
    const running = /停止/.test(b.textContent);
    if (running) sawRunning = true;
    else if (sawRunning) break;      // 进入过运行态、现在退出了 = 真结束
  }
  await sleep(200);
  return b;
}

(async () => {
  const N = 6;

  // ---------- ① 面板「⚡ 出答案」：并发开 ----------
  {
    const { env, inflight } = await boot({ n: N, concurrency: 4, concurrentEnabled: true });
    t("面板能识别出全部题卡", env.doc.querySelectorAll(".aa-card").length === N,
      env.doc.querySelectorAll(".aa-card").length + "/" + N);
    await runBtn(env, "⚡ 出答案");
    t("出答案·并发开：峰值并发 > 1（设置对面板也生效）", inflight.max > 1, "峰值=" + inflight.max);
    t("出答案·并发开：峰值不超过设定值 4", inflight.max <= 4, "峰值=" + inflight.max);
    t("出答案·并发开：请求数 == 卡片数", env.stats.aiCalls.length === N, env.stats.aiCalls.length + "/" + N);
    const shown = [...env.doc.querySelectorAll(".aa-card .aa-answer")].filter(a => a.style.display === "block").length;
    t("出答案·并发开：每张卡都显示了答案", shown === N, shown + "/" + N);
  }

  // ---------- ② 面板「⚡ 出答案」：并发关 ----------
  {
    const { env, inflight } = await boot({ n: N, concurrency: 4, concurrentEnabled: false });
    await runBtn(env, "⚡ 出答案");
    t("出答案·并发关：峰值并发 == 1（真的串行）", inflight.max === 1, "峰值=" + inflight.max);
    t("出答案·并发关：仍然全部出答案", env.stats.aiCalls.length === N, env.stats.aiCalls.length + "/" + N);
  }

  // ---------- ③ 面板「✍ 填涂」：并发开 ----------
  {
    const { env, inflight } = await boot({ n: N, concurrency: 4, concurrentEnabled: true });
    await runBtn(env, "✍ 填涂");
    t("填涂·并发开：峰值并发 > 1（设置对面板也生效）", inflight.max > 1, "峰值=" + inflight.max);
    t("填涂·并发开：峰值不超过设定值 4", inflight.max <= 4, "峰值=" + inflight.max);
    t("填涂·并发开：每道题都填上了", checkedCount(env) === N, checkedCount(env) + "/" + N);
  }

  // ---------- ④ 面板「✍ 填涂」：并发关 ----------
  {
    const { env, inflight } = await boot({ n: N, concurrency: 4, concurrentEnabled: false });
    await runBtn(env, "✍ 填涂");
    t("填涂·并发关：峰值并发 == 1（真的串行）", inflight.max === 1, "峰值=" + inflight.max);
    t("填涂·并发关：每道题都填上了", checkedCount(env) === N, checkedCount(env) + "/" + N);
  }

  // ---------- ⑤ 上限：面板也夹到 5 ----------
  {
    const { env, inflight } = await boot({ n: N, concurrency: 99, concurrentEnabled: true });
    await runBtn(env, "⚡ 出答案");
    t("面板·并发数 99 被夹到上限 5", inflight.max <= 5, "峰值=" + inflight.max);
  }

  console.log("----- 断言 -----");
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "  got=" + JSON.stringify(r.got));
  const all = results.every(r => r.ok);
  console.log("");
  console.log("===== " + (all ? "ALL PASS OK" : "HAS FAILURES") + " (" + results.filter(r => r.ok).length + "/" + results.length + ") =====");
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e && e.stack); process.exit(1); });
