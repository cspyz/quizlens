"use strict";
/*
 * 「AI 第一次拒答、第二次才有答案」的回归测试。
 *
 * 用户反馈：第一次点「答」卡片显示"无法判断 / 无法判断"+ 一句
 * "题目未提供题干与备选词库…"，**再点一下右边的「答」就出答案了**。
 *
 * 真因：模型偶尔会拒答（回一句"无法判断/请补充题干"），而我们把这段套话
 * 当成了最终答案缓存下来 —— 更糟的是 cleanFillTexts 把它当成"第 1、2 个空的答案"
 * 写进 answer 字段，所以卡片上看到的是"无法判断 / 无法判断"。
 * 现在：识别到拒答就自动重问一次（把拒答作为反面示例），仍失败才如实报错。
 */
const fs = require("fs");
const path = require("path");
const T = require("./env");
const sleep = T.sleep;

const QUIZ = path.join(T.ROOT, "quiz-app");
const PAGE = fs.readFileSync(path.join(QUIZ, "index.html"), "utf8");

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });

// 起真实练习页 + 「🔍 识别页面题目」面板（用户截图就是这条路）
async function bootScan(aiReply) {
  const env = T.makeEnv({
    html: PAGE, pageDir: QUIZ,
    storage: { mode: "ai", aiKey: "sk-test", interval: "0", answerMode: "standard",
               fillHosts: "*", showLog: true, bankBaseUrl: "" },
    aiReply,
  });
  env.runInlineScripts();
  await sleep(100); await sleep(100); await sleep(100);
  env.injectContent();
  env.startScan();
  await sleep(100); await sleep(100); await sleep(100); await sleep(100);
  return env;
}
function firstBlankCard(env) {
  return env.cards().findIndex(c => /等差数列/.test(c.textContent));
}

(async () => {
  // ① 模型第一次拒答、第二次正常 → 第一次点击就该出答案（以前要手动点第二次）
  {
    let call = 0;
    const env = await bootScan(() => {
      call++;
      return call === 1
        ? { ok: true, text: "无法判断 / 无法判断\n\n题目未提供题干与备选词库，无法确定两个空应填内容；请补充完整题目后我再作答。" }
        : { ok: true, text: "1. 3\n2. 17\n\n解析：公差 3，第 5 项 17。" };
    });
    const i = firstBlankCard(env);
    t("找到目标填空卡", i >= 0, i);
    await env.clickAnswer(i);
    const got = env.cardParts()[i].answer;
    t("第一次点击就拿到答案（不再需要手动点第二次）", /3.*17/.test(got), got);
    t("第一次点击就有解析", /公差/.test(env.cardParts()[i].explain), env.cardParts()[i].explain.slice(0, 40));
    t("没有把「无法判断」当成答案", !/无法判断/.test(got), got);
    t("拒答时自动重问了一次（共 2 次请求）", env.stats.aiCalls.length === 2, env.stats.aiCalls.length);
    // 重试那一次要把"不要再说无法判断"带进去
    const last = env.stats.aiCalls[env.stats.aiCalls.length - 1];
    const msgs = (last.payload && last.payload.messages) || [];
    t("重试请求里带了直接作答的指令", msgs.some(m => /直接作答|不要再要求补充/.test(String(m.content))), msgs.length);
  }

  // ② 一直拒答 → 如实报错，不能把套话当答案
  {
    const env = await bootScan(() => ({ ok: true, text: "无法判断\n\n题目未提供题干与备选词库，请补充完整题目。" }));
    const i = firstBlankCard(env);
    await env.clickAnswer(i);
    const got = env.cardParts()[i].answer;
    t("一直拒答：卡片显示错误提示", /^❌/.test(got), got.slice(0, 50));
    t("一直拒答：提示里说明了重试过", /重试/.test(got), got.slice(0, 60));
    t("一直拒答：不抛异常（曾因 texts=null 报 Cannot read properties）", !/Cannot read/.test(got), got.slice(0, 40));
    t("一直拒答：共 2 次请求，不无限重试", env.stats.aiCalls.length === 2, env.stats.aiCalls.length);
    t("一直拒答：不产生未捕获异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 80));
  }

  // ③ 正常回复不能被误判成拒答（否则每次都要多问一遍，白花 token）
  {
    const env = await bootScan(() => ({ ok: true, text: "1. 3\n2. 17\n\n解析：公差 3。" }));
    const i = firstBlankCard(env);
    await env.clickAnswer(i);
    t("正常回复：答案正确", /3.*17/.test(env.cardParts()[i].answer), env.cardParts()[i].answer);
    t("正常回复：只请求 1 次（没有多余重试）", env.stats.aiCalls.length === 1, env.stats.aiCalls.length);
  }

  // ④ 普通文本答案（不含"无法"）也要只请求 1 次
  {
    const env = await bootScan(() => ({ ok: true, text: "北京\n\n解析：中国的首都。" }));
    const j = env.cards().findIndex(c => /____/.test(c.textContent));
    await env.clickAnswer(j);
    t("普通答案：正常显示", env.cardParts()[j].answer.trim().length > 0, env.cardParts()[j].answer);
    t("普通答案：只请求 1 次", env.stats.aiCalls.length === 1, env.stats.aiCalls.length);
  }

  // ⑤ "无法"是合法答案内容时不该被误判（例如英文填空填 "unable"）
  {
    const env = await bootScan(() => ({ ok: true, text: "unable\n\n解析：hot 的反义词。", }));
    const j = env.cards().findIndex(c => /____/.test(c.textContent));
    await env.clickAnswer(j);
    t("英文答案 unaffected", env.cardParts()[j].answer.trim().length > 0, env.cardParts()[j].answer);
  }

  console.log("----- 断言 -----");
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "  got=" + JSON.stringify(r.got));
  const all = results.every(r => r.ok);
  console.log("");
  console.log("===== " + (all ? "ALL PASS OK" : "HAS FAILURES") + " (" + results.filter(r => r.ok).length + "/" + results.length + ") =====");
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });