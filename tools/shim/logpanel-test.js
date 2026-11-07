"use strict";
/*
 * 运行日志面板开关的回归测试。
 * 用户诉求原话："答题的时候会出现这个窗口，我希望我不要这个窗口"
 * → 默认**不显示**面板；需要时可在 popup 里勾选打开。
 *
 * 关键：不能只是"隐藏"，必须**根本不创建 DOM** —— 否则页面上仍会多一个空壳，
 * 或用户手动删掉后又被重建。
 */
const T = require("./env");
const sleep = T.sleep;

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });

function boot({ showLog } = {}) {
  const storage = { mode: "ai", aiKey: "sk-test", interval: "0", answerMode: "standard", fillHosts: "*" };
  if (showLog !== undefined) storage.showLog = showLog;
  const env = T.makeEnv({ storage, aiReply: { ok: true, text: "答案：A" } });
  env.injectContent();
  return env;
}
// 等 run() 真正跑完。判据必须锚定**收尾日志**，不能用"AI 调用够了"——
// 后者会在最后一条汇总日志之前就跳出，导致误报（我自己踩过：
// "完成：题库命中" 明明打了，测试却因为提前 break 而判失败）。
async function waitDone(env) {
  for (let i = 0; i < 200; i++) {
    await sleep(50);
    const done = env.stats.logs.some(l => /完成：题库命中/.test(l.text))
      || /完成：题库命中/.test(env.logText());
    if (done) break;
  }
  await sleep(150);
}

(async () => {
  // ---------- ① 默认（配置里没有 showLog 这个 key）：不出现面板 ----------
  {
    const env = boot({});
    t("默认：未设置时不显示面板", !env.doc.getElementById("aa-run-panel"), "panel=" + !!env.doc.getElementById("aa-run-panel"));
    env.start({ intervalMs: 0 });
    await waitDone(env);
    t("默认：答题结束后仍无面板", !env.doc.getElementById("aa-run-panel"), "panel=" + !!env.doc.getElementById("aa-run-panel"));
    t("默认：页面上没有任何 aa-run-panel 元素", env.doc.querySelectorAll("#aa-run-panel, .aa-panel").length === 0,
      env.doc.querySelectorAll("#aa-run-panel, .aa-panel").length);
    // 日志改走控制台，信息不丢
    const logged = env.stats.logs.filter(l => l.kind === "log" && /\[QuizLens\]/.test(l.text));
    t("默认：日志仍写进控制台（含开始/识别/完成）", logged.length >= 3, logged.length + " 条");
    t("默认：控制台日志里有「开始自动作答」", logged.some(l => /开始自动作答/.test(l.text)), "");
    t("默认：控制台日志里有「完成：题库命中」", logged.some(l => /完成：题库命中/.test(l.text)), "");
    t("默认：无未捕获异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 200));
  }

  // ---------- ② 显式开启：面板出现且能停止 ----------
  // 注：面板已经与「识别题目」面板合二为一（.aa-panel），不再有独立的 #aa-run-panel。
  // 这里断言的是合并后的统一面板。
  {
    const env = boot({ showLog: true });
    env.start({ intervalMs: 0 });
    await sleep(250);
    const p = env.doc.querySelector(".aa-panel");
    t("开启后：面板出现", !!p, "panel=" + !!p);
    t("开启后：没有旧的独立运行窗", !env.doc.getElementById("aa-run-panel"), "");
    if (p) {
      t("开启后：面板里有运行日志区与停止按钮",
        /QuizLens 运行中/.test(p.textContent) && !!p.querySelector(".aa-runlog-stop"), "");
      t("开启后：日志写在面板里（不再只进控制台）",
        /开始自动作答/.test((p.querySelector(".aa-runlog") || {}).textContent || ""), "");
    }
    await waitDone(env);
    t("开启后：无未捕获异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 200));
  }

  // ---------- ③ 显式关闭（false）：与默认一致 ----------
  {
    const env = boot({ showLog: false });
    env.start({ intervalMs: 0 });
    await waitDone(env);
    t("显式 false：同样不显示面板", !env.doc.getElementById("aa-run-panel"), "");
  }

  // ---------- ④ 面板关掉后，「停止」仍然有效 ----------
  // 面板里那个「停止」按钮是移除面板时最大的顾虑。popup 的「停止」走
  // chrome.runtime 的 STOP 消息，与面板无关 —— 这里实测确认。
  {
    const env = T.makeEnv({
      storage: { mode: "ai", aiKey: "sk-test", interval: "0.3", answerMode: "standard", fillHosts: "*" },
      aiReply: { ok: true, text: "答案：A" },
    });
    env.injectContent();
    env.start({ intervalMs: 300 });   // 留一点间隔，才测得出"停止能打断等待"
    await sleep(300);
    const before = env.stats.aiCalls.length;
    env.stop();
    await sleep(900);
    const after = env.stats.aiCalls.length;
    t("无面板时「停止」能中断答题", after <= before + 1, before + " → " + after);
    t("停止后页面无残留运行窗", env.doc.querySelectorAll("#aa-run-panel").length === 0, "");
    t("停止后无未捕获异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 150));
  }

  console.log("----- 断言 -----");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  got=${JSON.stringify(r.got)}`);
  const all = results.every(r => r.ok);
  console.log(`\n===== ${all ? "ALL PASS ✅" : "HAS FAILURES ❌"} (${results.filter(r => r.ok).length}/${results.length}) =====`);
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
