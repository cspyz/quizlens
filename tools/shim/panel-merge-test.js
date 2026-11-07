"use strict";
/*
 * 「面板合并」+「停止要立刻生效」的回归测试。
 *
 * 用户诉求：
 *   ① 能不能把那个面板融合到答题的那个面板  → 只有一个面板：题卡 + 运行日志
 *   ② 停止按键不灵敏，点了不能立马停        → 停止耗时从 3.4s 降到 <100ms，且不再多发请求
 */
const T = require("./env");
const sleep = T.sleep;

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });

// 造一个"慢接口"环境：真 background + 只认 signal.abort 的假 fetch，
// 这样 ABORT_AI 那条链路是真的被走到（不是靠 sleep 假装的）。
function slowSite({ intervalMs, aiDelayMs, showLog }) {
  const bg = T.makeBackground({
    storage: { aiKey: "k", aiBaseUrl: "https://api.example.com", aiModel: "m" },
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      const sig = init && init.signal;
      const ok = () => resolve({ ok: true, status: 200, async text() { return JSON.stringify({ choices: [{ message: { content: "答案：A" } }] }); } });
      const timer = setTimeout(ok, aiDelayMs);
      if (sig) sig.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
      });
    }),
  });
  const storage = { mode: "ai", aiKey: "sk-test", interval: String(intervalMs / 1000), answerMode: "standard", fillHosts: "*" };
  if (showLog !== undefined) storage.showLog = showLog;
  const env = T.makeEnv({ storage, aiReply: { ok: true, text: "答案：A" } });
  const orig = env.sandbox.chrome.runtime.sendMessage;
  env.sandbox.chrome.runtime.sendMessage = async msg => {
    if (msg && msg.type === "ABORT_AI") return bg.send(msg);
    if (msg && msg.type === "AI_CHAT") {
      env.stats.aiCalls.push({ payload: msg.payload, system: "", think: false });
      return bg.send(msg);
    }
    return orig(msg);
  };
  env.injectContent();
  return env;
}
// 等 run() 收尾。注意日志去处有两种：
//   showLog=true  → 写进面板的 .aa-runlog
//   showLog=false → 写控制台（stats.logs）
// 两边都要看，否则会误判成"停止没生效"（我自己踩过）。
function finished(env) {
  const box = env.doc.querySelector(".aa-runlog");
  const inPanel = box && /完成：题库命中/.test(box.textContent);
  const inConsole = env.stats.logs.some(l => /完成：题库命中/.test(l.text));
  return !!(inPanel || inConsole);
}
// 启动自动答题。intervalMs 必须显式传 0：popup 在 collectSettings 里算这个值，
// 测试直接调 start() 不传的话 run() 会用默认 1000ms，看着像"卡住"（实测踩过）。
function startRun(env, extra) {
  return env.start(Object.assign({ intervalMs: 0 }, extra || {}));
}
async function waitFinished(env, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    await sleep(10);
    if (finished(env)) return Date.now() - t0;
  }
  return null;
}

(async () => {
  // ---------- ① 只有一个面板：题卡 + 运行日志在同一个 DOM 里 ----------
  {
    const env = slowSite({ intervalMs: 1000, aiDelayMs: 50, showLog: true });
    startRun(env);
    await sleep(400);
    const panels = env.doc.querySelectorAll(".aa-panel");
    t("只有一个面板（不是两个窗口）", panels.length === 1, panels.length);
    t("旧独立运行窗 #aa-run-panel 不存在", env.doc.querySelectorAll("#aa-run-panel").length === 0, "");
    const p = panels[0];
    t("面板里同时有题卡区与运行日志区", !!p.querySelector(".aa-list") && !!p.querySelector(".aa-runlog"), "");
    t("日志区默认展开（run 模式）", p.querySelector(".aa-runlog-wrap").style.display !== "none", "");
    t("日志确实写进了面板", /开始自动作答/.test(p.querySelector(".aa-runlog").textContent), p.querySelector(".aa-runlog").textContent.slice(0, 50));
    t("面板里有「停止答题」按钮", !!p.querySelector(".aa-runlog-stop"), "");
    await waitFinished(env);
  }

  // ---------- ② 停止：立刻生效、不再多发请求 ----------
  for (const [intervalMs, aiDelayMs] of [[1000, 2000], [30000, 2000], [30000, 8000]]) {
    const env = slowSite({ intervalMs, aiDelayMs, showLog: true });
    startRun(env);
    await sleep(400);                                  // 第 1 题进入"请求中"
    const before = env.stats.aiCalls.length;
    const t0 = Date.now();
    env.stop();                                        // = popup 里的「停止」
    const waited = await waitFinished(env, 3000);
    const after = env.stats.aiCalls.length;
    const label = "间隔 " + (intervalMs / 1000) + "s / 接口 " + (aiDelayMs / 1000) + "s";
    t("停止立刻生效（" + label + "）", waited !== null && waited < 300, waited === null ? ">3s" : waited + "ms");
    t("停止后不再发起新请求（" + label + "）", after - before === 0, after - before);
  }

  // ---------- ③ 面板里的「停止」按钮同样立刻生效 ----------
  {
    const env = slowSite({ intervalMs: 30000, aiDelayMs: 8000, showLog: true });
    startRun(env);
    await sleep(400);
    const before = env.stats.aiCalls.length;
    const p = env.doc.querySelector(".aa-panel");
    const stopBtn = p.querySelector(".aa-runlog-stop");
    t("面板里有可点的停止按钮", !!stopBtn, "");
    const t0 = Date.now();
    stopBtn.click();
    const waited = await waitFinished(env, 3000);
    t("面板按钮停止也立刻生效", waited !== null && waited < 300, waited === null ? ">3s" : waited + "ms");
    t("面板按钮停止后不再发请求", env.stats.aiCalls.length - before === 0, env.stats.aiCalls.length - before);
  }

  // ---------- ④ showLog 关掉时：完全不建面板，日志进控制台 ----------
  {
    const env = slowSite({ intervalMs: 1000, aiDelayMs: 50, showLog: false });
    startRun(env);
    await waitFinished(env);
    t("showLog 关：不建任何面板", env.doc.querySelectorAll(".aa-panel, #aa-run-panel").length === 0,
      env.doc.querySelectorAll(".aa-panel, #aa-run-panel").length);
    t("showLog 关：日志仍进控制台", env.stats.logs.some(l => /\[QuizLens\] 完成：题库命中/.test(l.text)), "");
  }

  console.log("----- 断言 -----");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  got=${JSON.stringify(r.got)}`);
  const all = results.every(r => r.ok);
  console.log(`\n===== ${all ? "ALL PASS ✅" : "HAS FAILURES ❌"} (${results.filter(r => r.ok).length}/${results.length}) =====`);
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
