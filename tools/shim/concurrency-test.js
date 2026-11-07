"use strict";
/*
 * 「AI 并发作答」回归测试。
 *
 * 背景：原来是一题一题串行 —— 问 AI（几秒~几十秒）→ 写页面 → 歇 intervalMs → 下一题。
 * 148 道题在「仅 AI」模式下要十几分钟，而这期间只是在干等网络。
 *
 * 改造后：**取答案并发、写页面串行且保序**。这个测试钉住三件事：
 *   ① 真的并发了（同时有多于 1 个请求在飞）；
 *   ② 答案**按题序**落地 —— 即使完成顺序与发起顺序完全相反，也不能串题；
 *   ③ 并发数 = 1 时退回串行（不能因为改造把"稳妥"这条路弄丢）。
 */
const fs = require("fs");
const path = require("path");
const T = require("./env");
const sleep = T.sleep;

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });

// 造 6 道选择题：每题 3 个选项，答案互不相同，便于分辨有没有串题。
function makePage(n) {
  let html = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"><title>concurrency</title></head><body>";
  for (let i = 1; i <= n; i++) {
    html += "<div class=\"question\">" +
      "<div class=\"q-stem\">" + i + ". 并发测试题，请选择正确选项？</div>" +
      "<div class=\"opt\"><input type=\"radio\" name=\"q" + i + "\" value=\"0\"><span class=\"opt-text\">选项甲</span></div>" +
      "<div class=\"opt\"><input type=\"radio\" name=\"q" + i + "\" value=\"1\"><span class=\"opt-text\">选项乙</span></div>" +
      "<div class=\"opt\"><input type=\"radio\" name=\"q" + i + "\" value=\"2\"><span class=\"opt-text\">选项丙</span></div>" +
      "</div>";
  }
  return html + "</body></html>";
}

// 期望的第 i 题答案（下标）：0/1/2 轮转，保证每题不同，串题一定能被发现
const expectIdx = i => i % 3;
const letterOf = i => String.fromCharCode(65 + expectIdx(i));

// 起环境。delayMs(i) 决定第 i 个请求多久返回 —— 用它制造"完成顺序与发起顺序相反"。
async function boot({ n = 6, concurrency = 3, concurrentEnabled = true, delayMs = null } = {}) {
  const inflight = { now: 0, max: 0 };
  const order = [];
  const env = T.makeEnv({
    html: makePage(n),
    storage: { mode: "ai", aiKey: "sk-test", interval: "0", concurrency, concurrentEnabled, fillHosts: "*", showLog: true, bankBaseUrl: "" },
    aiReply: (callNo) => {
      const i = callNo - 1;
      inflight.now++;
      if (inflight.now > inflight.max) inflight.max = inflight.now;
      order.push({ i, at: Date.now() });
      // 越靠后的请求返回越快 → 完成顺序与发起顺序相反
      const d = delayMs ? delayMs(i) : 0;
      const reply = { ok: true, text: letterOf(i) };
      if (!d) { inflight.now--; return reply; }
      return new Promise(res => setTimeout(() => { inflight.now--; res(reply); }, d));
    },
  });
  env.runInlineScripts();
  await sleep(60);
  env.injectContent();
  return { env, inflight, order };
}

function finished(env) {
  const box = env.doc.querySelector(".aa-runlog");
  return !!(box && /完成：/.test(box.textContent)) || env.stats.logs.some(l => /完成：/.test(l.text));
}
async function waitFinished(env, steps = 120) {
  for (let i = 0; i < steps; i++) {
    await sleep(100);
    if (finished(env)) return true;
  }
  return false;
}
function checkedIdx(env) {
  return [...env.doc.querySelectorAll(".question")].map(q =>
    [...q.querySelectorAll(".opt input")].findIndex(inp => inp.checked));
}

(async () => {
  // ---------- ① 并发确实发生了，且答案按题序落地 ----------
  {
    const N = 6;
    // 第 i 个请求等 (N-i)*120 ms：第 1 题最慢、最后一题最快 → 完成顺序完全倒过来
    const { env, inflight } = await boot({ n: N, concurrency: 3, delayMs: i => (N - i) * 120 });
    const t0 = Date.now();
    env.start({ intervalMs: 0, concurrency: 3 });
    const done = await waitFinished(env);
    const elapsed = Date.now() - t0;

    t("整轮跑完", done, done ? "约 " + elapsed + "ms" : "超时");
    t("同时有多个请求在飞（真的并发了）", inflight.max > 1, "峰值并发=" + inflight.max);
    t("峰值并发不超过设定值 3", inflight.max <= 3, inflight.max);

    // 关键断言：页面上的勾选必须与题号对应，不能因为完成顺序颠倒而串题
    const got = checkedIdx(env);
    const want = Array.from({ length: N }, (_, i) => expectIdx(i));
    t("答案按题序落地（完成顺序颠倒也不串题）", JSON.stringify(got) === JSON.stringify(want),
      "实际=" + JSON.stringify(got) + " 期望=" + JSON.stringify(want));

    // 并发应当明显快于串行：串行总时长 = Σ delay = 720+600+480+360+240+120 = 2520ms
    t("并发比串行明显更快（< 串行总时长）", elapsed < 2520, elapsed + "ms vs 串行约 2520ms");
    t("无未捕获异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 120));
  }

  // ---------- ② 并发数 = 1 时退回串行 ----------
  {
    const { env, inflight } = await boot({ n: 4, concurrency: 1, delayMs: () => 60 });
    env.start({ intervalMs: 0, concurrency: 1 });
    const done = await waitFinished(env);
    t("并发=1 时整轮仍能跑完", done, done);
    t("并发=1 时同一时刻只有一个请求在飞", inflight.max === 1, "峰值并发=" + inflight.max);
    const got = checkedIdx(env);
    const want = Array.from({ length: 4 }, (_, i) => expectIdx(i));
    t("并发=1 时答案同样正确", JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));
  }

  // ---------- ③ 中途停止：不再发新请求，也不再往页面写 ----------
  {
    const { env } = await boot({ n: 6, concurrency: 3, delayMs: () => 400 });
    env.start({ intervalMs: 0, concurrency: 3 });
    await sleep(150);
    const callsBefore = env.stats.aiCalls.length;
    env.stop();
    await sleep(900);
    t("停止后不再发起新请求", env.stats.aiCalls.length === callsBefore,
      callsBefore + " -> " + env.stats.aiCalls.length);
    // 停止后不应该再有结果被写进页面（填涂不可逆）
    const after = checkedIdx(env).filter(i => i >= 0).length;
    t("停止后不再往页面写答案（不可逆操作）", after === 0, "已勾选 " + after + " 题");
  }

  // ---------- ④ 重复点「开始答题」不能重复问 AI ----------
  //  踩过的坑：跳过"已答过"的检查外面套了一层 `if (q.generic)`，而练习页走的是
  //  getQuestionBlocks() → extractQuestion() 这条路，返回的题目对象没有 generic 标记，
  //  于是整段检查被绕过 —— 同一页连点两次，每道题都会被重新问一遍（白花 token）。
  {
    const N = 6;
    const { env } = await boot({ n: N, concurrency: 3, delayMs: () => 40 });
    env.start({ intervalMs: 0, concurrency: 3 });
    await waitFinished(env);
    const first = env.stats.aiCalls.length;
    t("第一轮请求数 == 题数", first === N, first + "/" + N);
    // 页面此时已全部答好，再点一次「开始答题」
    env.start({ intervalMs: 0, concurrency: 3 });
    await sleep(1200);
    const second = env.stats.aiCalls.length - first;
    t("连点两次：第二次新增请求 == 0（不重复问 AI）", second === 0, "+" + second);
    const still = checkedIdx(env).filter(i => i >= 0).length;
    t("连点两次：已填的答案没有被推翻", still === N, still + "/" + N);
    const logText = (env.doc.querySelector(".aa-runlog") || {}).textContent || "";
    // 收尾那行形如「完成：题库命中 0，AI 作答 0，未答 0，跳过已答 6」
    t("连点两次：日志里如实记了「跳过已答 N」", /跳过已答\s*\d+/.test(logText),
      (logText.match(/完成：[^\n]*/) || [""])[0].slice(0, 60));
  }

  // ---------- ⑤ 并发开关：关掉就是串行 ----------
  {
    const { env, inflight } = await boot({ n: 4, concurrency: 3, concurrentEnabled: false, delayMs: () => 60 });
    env.start({ intervalMs: 0, concurrentEnabled: false });
    await waitFinished(env);
    t("关闭并发：峰值并发 == 1（退回串行）", inflight.max === 1, "峰值=" + inflight.max);
    t("关闭并发：仍全部作答", checkedIdx(env).every(i => i >= 0), JSON.stringify(checkedIdx(env)));
  }

  // ---------- ⑥ 并发数上限锁 5 ----------
  {
    const { env, inflight } = await boot({ n: 6, concurrency: 99, delayMs: () => 60 });
    env.start({ intervalMs: 0, concurrency: 99 });
    await waitFinished(env);
    t("并发数 99 被夹到上限 5", inflight.max <= 5, "峰值=" + inflight.max);
    t("被夹后仍全部作答", checkedIdx(env).every(i => i >= 0), JSON.stringify(checkedIdx(env)));
  }

  console.log("----- 断言 -----");
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "  got=" + JSON.stringify(r.got));
  const all = results.every(r => r.ok);
  console.log("");
  console.log("===== " + (all ? "ALL PASS OK" : "HAS FAILURES") + " (" + results.filter(r => r.ok).length + "/" + results.length + ") =====");
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e && e.stack); process.exit(1); });
