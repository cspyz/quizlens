"use strict";
/*
 * 第一批 P0 回归：答案被解析劫持 / 单选多字母 / 白名单收口 / 填空清洗
 *
 * 这四条在修之前都是"落进页面就不可逆"或"唯一安全防线被绕过"，而既有的
 * 16 个台架用例对它们全部是瞎的（解析里没有「参考答案为 X」、白名单桩恒放行、
 * 填空回复永远是干净的一行）。所以本文件每一条都要能同时说明：
 *   修之前会取到什么（写在注释里，实测得出）与现在必须得到什么。
 *
 * 跑法：node tools/shim/p0-batch1-test.js
 *
 * 修前实测（把 content.js:647-826 原样抽出来执行得出）：
 *   "答案：C\n\n解析：…参考答案为 B。"        → B   （解析抢走答案行）
 *   "无法确定，A、B 都不对"                   → [A,B]（单选勾了两个）
 *   cleanFillTexts("3.14", 1)                 → "14" （编号剥离吃掉小数）
 *   cleanFillTexts("我的思路是：\n北京", 1)    → "我的思路是："（无条件取第一行）
 *   cleanFillTexts("答案：北京", 1)            → "答案：北京"（前缀没剥）
 *   面板「✍ 填涂」在白名单外照写不误           → 全文件 hostAllowed 只有 run() 一个调用点
 */
const T = require("./env");
const sleep = T.sleep;

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });

const HEAD = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"></head><body>";

// 三选项单选（radio）
const RADIO_PAGE = HEAD +
  "<div class=\"question\"><div class=\"q-stem\">1. 下列哪个是数据库？</div>" +
  "<div class=\"opt\"><input type=\"radio\" name=\"q1\" value=\"0\"><span class=\"opt-text\">MySQL</span></div>" +
  "<div class=\"opt\"><input type=\"radio\" name=\"q1\" value=\"1\"><span class=\"opt-text\">Nginx</span></div>" +
  "<div class=\"opt\"><input type=\"radio\" name=\"q1\" value=\"2\"><span class=\"opt-text\">Redis</span></div>" +
  "</div></body></html>";

// 三选项多选（checkbox）：单选的判据不能把它一起管了
const CHECKBOX_PAGE = RADIO_PAGE
  .replace(/type="radio"/g, "type=\"checkbox\"");

// 单空 / 两空填空
const BLANK1_PAGE = HEAD +
  "<div class=\"question\"><div class=\"q-stem\">1. 中华人民共和国的首都是 ____ 。</div>" +
  "<input class=\"blank-input\" type=\"text\"></div></body></html>";
const BLANK2_PAGE = HEAD +
  "<div class=\"question\"><div class=\"q-stem\">2. 已知圆半径 r= ____ ，面积 S= ____ 。</div>" +
  "<input class=\"blank-input\" type=\"text\"><input class=\"blank-input\" type=\"text\"></div></body></html>";

function boot(html, aiReply, extra) {
  const env = T.makeEnv(Object.assign({
    html,
    aiReply,
    storage: { mode: "ai", aiKey: "sk-test", aiModel: "mock", interval: "0", answerMode: "standard", showLog: true },
  }, extra || {}));
  env.runInlineScripts();
  env.injectContent();
  return env;
}

function runLog(env) {
  const el = env.doc.querySelector(".aa-runlog") || env.doc.querySelector("#aa-log");
  return el ? (el.textContent || "") : "";
}
// 面板底部那行状态文字（填涂的结果/拒绝原因写在这里）
function fillMsg(env) {
  const el = env.doc.querySelector(".aa-info");
  return el ? (el.textContent || "") : "";
}

async function waitDone(env, tries = 80) {
  for (let i = 0; i < tries; i++) {
    await sleep(100);
    if (/完成：题库命中\s*\d+/.test(runLog(env))) return runLog(env);
  }
  return runLog(env);
}

function fillBtn(env) {
  const panel = env.panel();
  return panel ? [...panel.querySelectorAll("button")].find(b => /填涂/.test(b.textContent)) : null;
}

// 点面板上的「✍ 填涂」并等它跑完
async function clickFill(env) {
  const btn = fillBtn(env);
  if (!btn) return null;
  btn.click();
  for (let i = 0; i < 60; i++) {
    await sleep(50);
    if (!/停止/.test(btn.textContent)) break;
  }
  await sleep(150);
  return btn;
}

(async () => {
  // ============ ① 解析段不得参与取字母 ============
  {
    const env = boot(RADIO_PAGE, {
      ok: true,
      text: "答案：C\n\n解析：A 项 MySQL 是数据库没错，但题目问的是「哪个是」，" +
            "B 项 Nginx 是服务器，参考答案为 B。",
    });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    const idx = env.checked()[0].idx;
    t("① 解析里的「参考答案为 B」不得劫持答案行", JSON.stringify(idx) === "[2]", JSON.stringify(idx));
    t("① 日志按 C 落进页面（不是 B）", /\[AI\].*→\s*C/.test(runLog(env)), (runLog(env).match(/\[AI\][^\n]*/) || [""])[0].slice(0, 60));
    t("① 无未捕获异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 140));
  }

  // 对照组：模型在**答案段内**自我纠正时，"取最后一个标记"这个既有行为必须保留
  {
    const env = boot(RADIO_PAGE, {
      ok: true,
      text: "答案：A、B\n再检查一下题目要求\n答案：C",
    });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    t("①b 答案段内的自我纠正仍取最后一个（→ C）", JSON.stringify(env.checked()[0].idx) === "[2]", JSON.stringify(env.checked()));
  }

  // 同行写法（"C 解析：…"）也必须能切开
  {
    const env = boot(RADIO_PAGE, { ok: true, text: "C 解析：参考答案为 B。" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    t("①c 答案与解析同行时仍取 C", JSON.stringify(env.checked()[0].idx) === "[2]", JSON.stringify(env.checked()));
  }

  // ============ ② 单选/判断题：多于一律不勾 ============
  {
    const env = boot(RADIO_PAGE, { ok: true, text: "答案：A、B" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    const idx = env.checked()[0].idx;
    t("② 单选收到两个字母时一个都不勾", idx.length === 0, JSON.stringify(idx));
    t("② 如实报出失败原因（卡片/日志可见）", /单选题只该有一个答案/.test(runLog(env)), (runLog(env).match(/[^\n]*单选题只该有一个答案[^\n]*/) || [""])[0].slice(0, 80));
    t("② 这道题计入未答（不是「已答」）", /未答 1/.test(runLog(env)), (runLog(env).match(/完成：[^\n]*/) || [""])[0].slice(0, 80));
  }

  // 拒答式回复（"A、B 都不对"）以前会把 A、B 都勾上 → 单选同样必须拒绝
  {
    const env = boot(RADIO_PAGE, { ok: true, text: "无法确定，A、B 都不对" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    t("②b 拒答文本不得勾进单选", env.checked()[0].idx.length === 0, JSON.stringify(env.checked()));
  }

  // 反面对照：checkbox 多选题拿到两个字母必须照勾，判据不能过界
  {
    const env = boot(CHECKBOX_PAGE, { ok: true, text: "答案：A、C" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    t("②c 多选（checkbox）两个字母照勾", JSON.stringify(env.checked()[0].idx) === "[0,2]", JSON.stringify(env.checked()));
  }

  // ============ ③ 白名单收到"写页面"这一层 ============
  const BLOCK = ["example.org"];   // 台架的 location 是 localhost → 不含它

  // ③a 面板直开（START_SCAN 不经过 run()）：填涂不可用，且真的点下去也不写
  {
    const env = boot(RADIO_PAGE, { ok: true, text: "答案：A" }, { whitelist: BLOCK });
    env.startScan();
    await sleep(200);
    const btn = fillBtn(env);
    t("③a 白名单外面板的「✍ 填涂」是禁用态", !!btn && btn.disabled === true, btn ? String(btn.disabled) : "no button");
    t("③a 禁用原因写在按钮提示里", !!btn && /不在自动填涂白名单内/.test(btn.title || ""), JSON.stringify((btn || {}).title || "").slice(0, 70));
    if (btn) btn.click();          // 台架的 click 不看 disabled，正好用来验证收口本身
    await sleep(400);
    t("③a 强行点填涂也不写页面", env.checked()[0].idx.length === 0, JSON.stringify(env.checked()));
    t("③a 并给出一句能照做的说明", /不在自动填涂白名单内/.test(fillMsg(env)), fillMsg(env).slice(0, 80));
    t("③a 白名单外一次 AI 请求都不发", env.stats.aiCalls.length === 0, env.stats.aiCalls.length);
  }

  // ③b 开始答题在白名单外降级成的那块面板，同样不能有可用的填涂
  {
    const env = boot(RADIO_PAGE, { ok: true, text: "答案：A" }, { whitelist: BLOCK });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await sleep(300);
    t("③b 白名单外「开始答题」不写页面", env.checked()[0].idx.length === 0, JSON.stringify(env.checked()));
    const btn = fillBtn(env);
    t("③b 降级面板的填涂同样禁用", !!btn && btn.disabled === true, btn ? String(btn.disabled) : "no button");
  }

  // ③c 对照：放行时面板填涂必须照常能用（收口不能把功能关掉）
  {
    const env = boot(RADIO_PAGE, { ok: true, text: "答案：A" }, { whitelist: ["*"] });
    env.startScan();
    await sleep(200);
    const btn = fillBtn(env);
    t("③c 白名单内「✍ 填涂」可用", !!btn && btn.disabled === false, btn ? String(btn.disabled) : "no button");
    await clickFill(env);
    t("③c 白名单内面板填涂正常写进页面", JSON.stringify(env.checked()[0].idx) === "[0]", JSON.stringify(env.checked()));
  }

  // ============ ④ 填空清洗：数字/前缀/前言 ============
  {
    const env = boot(BLANK1_PAGE, { ok: true, text: "3.14" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    t("④ 小数答案不被当成行号剥掉（3.14 不是 14）", env.blanks()[0] === "3.14", JSON.stringify(env.blanks()));
  }
  {
    const env = boot(BLANK1_PAGE, { ok: true, text: "0.5" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    t("④ 0.5 不被剥成 5", env.blanks()[0] === "0.5", JSON.stringify(env.blanks()));
  }
  {
    const env = boot(BLANK1_PAGE, { ok: true, text: "答案：北京" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    t("④ 「答案：」前缀不写进输入框", env.blanks()[0] === "北京", JSON.stringify(env.blanks()));
  }
  {
    const env = boot(BLANK1_PAGE, { ok: true, text: "我的思路是：\n北京" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    t("④ 冒号收尾的前言不当成答案（取「北京」）", env.blanks()[0] === "北京", JSON.stringify(env.blanks()));
  }
  {
    // 正常写法必须照旧：答案在前、解析在后
    const env = boot(BLANK1_PAGE, { ok: true, text: "北京\n\n解析：北京是首都。" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    t("④b 正常回复（答案行在前）仍取北京", env.blanks()[0] === "北京", JSON.stringify(env.blanks()));
  }
  {
    const env = boot(BLANK2_PAGE, { ok: true, text: "1. 3.14\n2. 0.5" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    t("④c 多空：剥行号但保住小数", JSON.stringify(env.blanks()) === "[\"3.14\",\"0.5\"]", JSON.stringify(env.blanks()));
  }

  console.log("----- 断言 -----");
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "  got=" + JSON.stringify(r.got));
  const all = results.every(r => r.ok);
  console.log("");
  console.log("===== " + (all ? "ALL PASS ✅" : "HAS FAILURES ❌") + " (" + results.filter(r => r.ok).length + "/" + results.length + ") =====");
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
