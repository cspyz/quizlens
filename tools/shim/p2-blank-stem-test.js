"use strict";
/*
 * P2 回归：填空题题干必须真的发给 AI（.q-stem 结构）
 *
 * 背景：extractQuestion() 只写 stemText、没写 stem，而 askAIFill() 用的是 question.stem，
 * 于是 .q-stem 结构页面上发给模型的题干是空字符串 —— 模型对着空题目瞎猜，
 * 答案照样写进输入框、日志还报「完成：AI 作答 1，未答 0」，用户完全看不出异常。
 *
 * 本测试用 tools/shim 台架（不依赖浏览器）跑真实 content.js，断言：
 *   ① .q-stem 结构下填空题请求体的 user 内容包含题干；
 *   ② 模型收到的题干里带着空格标记，能看出是填空题；
 *   ③ 题干为空时（人为构造）**不发请求**，且如实报错；
 *   ④ 选择题路径不受影响（回归）。
 */
const fs = require("fs");
const path = require("path");
const T = require("./env");
const sleep = T.sleep;

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });

// 只保留填空题的页面（.q-stem 结构，与练习页/真实考试系统一致）
const BLANK_PAGE = [
  "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"><title>p2</title></head><body>",
  "<div class=\"question\"><div class=\"q-stem\">1. 中华人民共和国的首都是 ____ 。</div>",
  "<input class=\"blank-input\" type=\"text\"></div>",
  "</body></html>",
].join("");

// 多空 + 材料之外的对照组：题干和输入框在同一个 div、没有 .q-stem
const NO_QSTEM_PAGE = [
  "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"></head><body>",
  "<div class=\"question\"><div>2. 水的化学式是 ____ 。</div>",
  "<input class=\"blank-input\" type=\"text\"></div>",
  "</body></html>",
].join("");

function boot(html, aiReply) {
  const env = T.makeEnv({
    html,
    storage: { mode: "ai", aiKey: "sk-test", aiModel: "mock", interval: "0", answerMode: "standard", showLog: true },
    aiReply,
  });
  env.runInlineScripts();
  env.injectContent();
  return env;
}

// 读运行日志。
// 注意：台架 env.js 自带的 logText() 查的是旧选择器 #aa-log，而产品早就把日志
// 并进面板、改成 class="aa-runlog"（id 去掉），于是 runLog(env) 恒为空。
// 这里自己查，不依赖那个过期 helper。
function runLog(env) {
  const el = env.doc.querySelector(".aa-runlog") || env.doc.querySelector("#aa-log");
  return el ? (el.textContent || "") : "";
}

// 等 run() 跑完（日志出现收尾行）
async function waitDone(env, tries = 80) {
  for (let i = 0; i < tries; i++) {
    await sleep(100);
    if (/完成：题库命中\s*\d+/.test(runLog(env))) return runLog(env);
  }
  return runLog(env);
}

(async () => {
  // ---------- ① .q-stem 结构：题干必须发给 AI ----------
  {
    const env = boot(BLANK_PAGE, (stats) => {
      // 只有看到题干才答对；看不到就回一个明显是瞎猜的答案
      const payload = stats && stats.aiCalls && stats.aiCalls[stats.aiCalls.length - 1];
      const user = payload ? "" : "";
      return { ok: true, text: "北京" };
    });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    const calls = env.stats.aiCalls.map(c => c.payload.messages.find(m => m.role === "user").content);
    t("① 填空题发出了 AI 请求", calls.length === 1, calls.length);
    t("① 请求体里的题干不是空字符串", calls.length === 1 && String(calls[0]).trim().length > 0, JSON.stringify(calls[0]));
    t("① 请求体里包含题干正文「中华人民共和国的首都」", calls.length === 1 && /中华人民共和国的首都/.test(calls[0]), JSON.stringify(calls[0]).slice(0, 80));
    t("① 请求体里带着空格标记（能看出是填空题）", calls.length === 1 && /_{2,}/.test(calls[0]), JSON.stringify(calls[0]).slice(0, 80));
    t("① 答案写进了输入框", env.blanks()[0] === "北京", env.blanks());
    t("① 无未捕获异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 120));
  }

  // ---------- ② 没有 .q-stem 的同容器结构：兜底也要拿到题干 ----------
  {
    const env = boot(NO_QSTEM_PAGE, { ok: true, text: "H2O" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    const calls = env.stats.aiCalls.map(c => c.payload.messages.find(m => m.role === "user").content);
    t("② 无 .q-stem 结构也发出了请求", calls.length === 1, calls.length);
    t("② 兜底题干里有「水的化学式」", calls.length === 1 && /水的化学式/.test(String(calls[0] || "")), JSON.stringify(calls));
    if (calls.length !== 1) console.log("[DIAG ②] log=", JSON.stringify(runLog(env).slice(-400)), " blanks=", JSON.stringify(env.blanks()));
    t("② 答案写进了输入框", env.blanks()[0] === "H2O", env.blanks());
  }

  // ---------- ③ 题干为空：必须不发请求 + 如实报错 ----------
  {
    // 页面里只有一个空壳题干（题干元素存在但文本为空）
    const EMPTY_STEM_PAGE = [
      "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"></head><body>",
      "<div class=\"question\"><div class=\"q-stem\"></div>",
      "<input class=\"blank-input\" type=\"text\"></div>",
      "</body></html>",
    ].join("");
    const env = boot(EMPTY_STEM_PAGE, { ok: true, text: "瞎猜的答案" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    const calls = env.stats.aiCalls.length;
    const log = runLog(env);
    t("③ 题干为空时**不发** AI 请求（不拿空题目问模型）", calls === 0, calls);
    t("③ 题干为空时不往输入框里塞瞎猜的答案", env.blanks()[0] === "" || env.blanks()[0] === undefined, env.blanks());
    t("③ 如实报出「没识别到题干」", /没识别到.*题干/.test(log), (log.match(/[^\n]*没识别到[^\n]*/) || [""])[0].slice(0, 90));
  }

  // ---------- ④ 选择题路径回归：不能因为改动把选择题弄坏 ----------
  {
    const CHOICE_PAGE = [
      "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"></head><body>",
      "<div class=\"question\"><div class=\"q-stem\">1. 下列哪个是数据库？</div>",
      "<div class=\"opt\"><input type=\"radio\" name=\"q1\" value=\"0\"><span class=\"opt-text\">MySQL</span></div>",
      "<div class=\"opt\"><input type=\"radio\" name=\"q1\" value=\"1\"><span class=\"opt-text\">Nginx</span></div>",
      "</div></body></html>",
    ].join("");
    const env = boot(CHOICE_PAGE, { ok: true, text: "答案：A" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    const calls = env.stats.aiCalls.map(c => c.payload.messages.find(m => m.role === "user").content);
    t("④ 选择题仍然正常发请求", calls.length === 1, calls.length);
    t("④ 选择题请求里带题干", calls.length === 1 && /下列哪个是数据库/.test(calls[0]), JSON.stringify(calls[0]).slice(0, 80));
    t("④ 选择题填涂正确", JSON.stringify(env.checked()[0].idx) === "[0]", JSON.stringify(env.checked()));
  }

  console.log("----- 断言 -----");
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "  got=" + JSON.stringify(r.got));
  const all = results.every(r => r.ok);
  console.log("");
  console.log("===== " + (all ? "ALL PASS ✅" : "HAS FAILURES ❌") + " (" + results.filter(r => r.ok).length + "/" + results.length + ") =====");
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
