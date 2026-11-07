"use strict";
/*
 * 第二批回归：写入必须回读，计数与文案必须说实话
 *
 * 症状（修前）：bankHit/aiHit 在写页面**之前**就自增，写失败只留一行日志，
 * 于是整轮一题都没落进页面也能报「已填 8 题」、未答永远 0；面板还把失败的写入
 * 记成「↷ 已经填过，跳过」，用户连重试的机会都没有。
 *
 * 台架怎么模拟"页面没接住"：对真实元素实例覆盖 checked / value 访问器 ——
 *   · checked 恒为 false 且 set 无效 = 框架把直改属性改回去（React 受控组件）
 *   · checked 只在真实 click 后才为 true = 必须走事件路径的站点
 *   · value 恒为 "" 且 set 无效 = type=number 静默拒绝非法值（实测 F10）
 * 这三种都是真实页面会有的行为，不是台架臆造的场景。
 *
 * 跑法：node tools/shim/p0-batch2-test.js
 */
const T = require("./env");
const sleep = T.sleep;

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });

const HEAD = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"></head><body>";

const CHOICE_PAGE = (type) => HEAD +
  "<div class=\"question\"><div class=\"q-stem\">1. 下列哪个是数据库？</div>" +
  "<div class=\"opt\"><input type=\"" + type + "\" name=\"q1\" value=\"0\"><span class=\"opt-text\">MySQL</span></div>" +
  "<div class=\"opt\"><input type=\"" + type + "\" name=\"q1\" value=\"1\"><span class=\"opt-text\">Nginx</span></div>" +
  "<div class=\"opt\"><input type=\"" + type + "\" name=\"q1\" value=\"2\"><span class=\"opt-text\">Redis</span></div>" +
  "</div></body></html>";

const BLANK_PAGE = HEAD +
  "<div class=\"question\"><div class=\"q-stem\">1. 中华人民共和国的首都是 ____ 。</div>" +
  "<input class=\"blank-input\" type=\"number\"></div></body></html>";

function boot(html, aiReply, extra) {
  const env = T.makeEnv(Object.assign({
    html,
    aiReply,
    storage: { mode: "ai", aiKey: "sk-test", aiModel: "mock", interval: "0", answerMode: "standard", showLog: true },
  }, extra || {}));
  env.runInlineScripts();
  return env;
}

// 元素已经在文档里了才能取：先注入 content.js 之前把页面脚本跑完
function run(env, settings) {
  env.injectContent();
  env.start(Object.assign({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true }, settings || {}));
}

function runLog(env) {
  const el = env.doc.querySelector(".aa-runlog") || env.doc.querySelector("#aa-log");
  return el ? (el.textContent || "") : "";
}
function fillMsg(env) {
  const el = env.doc.querySelector(".aa-info");
  return el ? (el.textContent || "") : "";
}
function toastText(env) {
  const el = env.doc.querySelector(".aa-toast-text");
  return el ? (el.textContent || "") : "";
}
function cardText(env) {
  const c = env.cards()[0];
  if (!c) return "";
  const box = c.querySelector(".aa-answer");
  return box ? (box.textContent || "") : "";
}

async function waitDone(env, tries = 80) {
  for (let i = 0; i < tries; i++) {
    await sleep(100);
    if (/完成：题库命中\s*\d+/.test(runLog(env))) break;
  }
  return runLog(env);
}

async function clickFill(env) {
  const panel = env.panel();
  const btn = panel ? [...panel.querySelectorAll("button")].find(b => /填涂/.test(b.textContent)) : null;
  if (!btn) return null;
  btn.click();
  for (let i = 0; i < 60; i++) {
    await sleep(50);
    if (!/停止/.test(btn.textContent)) break;
  }
  await sleep(150);
  return btn;
}

// 让"直接赋值"失效，模拟框架把值改回去
function rejectAssignment(el, prop) {
  Object.defineProperty(el, prop, {
    get() { return prop === "checked" ? false : ""; },
    set() { /* 页面不认这次写入 */ },
    configurable: true,
  });
}
// 只有真实点击才生效，模拟"状态绑在 click 事件上"的站点
function clickOnlySelection(el) {
  let viaClick = false;
  el.addEventListener("click", () => { viaClick = true; });
  Object.defineProperty(el, "checked", {
    get() { return viaClick; },
    set() { /* 直改属性被受控组件吞掉 */ },
    configurable: true,
  });
}

(async () => {
  // ============ ① 写入被页面拒绝 → 必须报未答，不许报"已填 1 题" ============
  {
    const env = boot(CHOICE_PAGE("radio"), { ok: true, text: "答案：A" });
    run(env);
    const inp = env.doc.querySelector("input[type=radio]");
    rejectAssignment(inp, "checked");
    await waitDone(env);
    const log = runLog(env);
    t("① 写入被拒绝时计数是「题库命中 0，AI 作答 0」", /题库命中 0，AI 作答 0/.test(log), (log.match(/完成：[^\n]*/) || [""])[0].slice(0, 70));
    t("① 这道题进了未答", /未答 1/.test(log), (log.match(/完成：[^\n]*/) || [""])[0].slice(0, 90));
    t("① 收尾行不再绿色报喜", /一题都没能写进页面/.test(log), (log.match(/[^\n]*没能写进页面[^\n]*/) || [""])[0].slice(0, 60));
    t("① toast 说「已填 0 题」", /已填 0 题，还有 1 道没答上/.test(toastText(env)), toastText(env).slice(0, 60));
    t("① 卡片给出这一题的手动补答提示", /没能写进页面/.test(cardText(env)), cardText(env).slice(0, 80));
    t("① 无未捕获异常", env.errors().length === 0, JSON.stringify(env.errors()).slice(0, 140));
  }

  // ============ ② 直改属性无效但点击有效 → 走点击兜底，仍算成功 ============
  {
    const env = boot(CHOICE_PAGE("radio"), { ok: true, text: "答案：A" });
    run(env);
    const inp = env.doc.querySelector("input[type=radio]");
    clickOnlySelection(inp);
    await waitDone(env);
    const log = runLog(env);
    t("② 受控组件改走真实点击后落进页面", JSON.stringify(env.checked()[0].idx) === "[0]", JSON.stringify(env.checked()));
    t("② 这种情况按已答计数", /AI 作答 1，未答 0/.test(log), (log.match(/完成：[^\n]*/) || [""])[0].slice(0, 90));
    t("② toast 报「已填 1 题」", /已填 1 题/.test(toastText(env)), toastText(env).slice(0, 40));
  }

  // ============ ③ 填空被 type=number 拒绝：不许记成功、更不许锁成"已填过" ============
  {
    const env = boot(BLANK_PAGE, { ok: true, text: "北京" });
    run(env);
    const blank = env.doc.querySelector("input.blank-input");
    rejectAssignment(blank, "value");
    await waitDone(env);
    t("③ 写入被拒绝的填空不算已答", /未答 1/.test(runLog(env)), (runLog(env).match(/完成：[^\n]*/) || [""])[0].slice(0, 90));

    // 第二轮从面板走「填涂」：以前这里会说「↷ 已经填过，跳过」
    await clickFill(env);
    const card = cardText(env);
    t("③ 失败的写入不被说成「已经填过」", !/已经填过/.test(card), card.slice(0, 90));
    t("③ 如实说「页面没接住，请手动填」", /页面没接住/.test(card), card.slice(0, 90));
    t("③ 不重复向 AI 要这一题（token 不白花）", env.stats.aiCalls.length === 1, env.stats.aiCalls.length);
    t("③ 汇总不是「成功 1」", /成功 0/.test(fillMsg(env)), fillMsg(env).slice(0, 90));
  }

  // ============ ④ 多选组：勾选失败就是失败，不被旁边的动作掩盖 ============
  {
    // A 要勾但勾不上 → 整题必须报"没能写进页面"（不能因为别的动作返回过 true 就算成功）
    const env = boot(CHOICE_PAGE("checkbox"), { ok: true, text: "答案：A" }, { whitelist: ["*"] });
    env.injectContent();
    const inputs = env.doc.querySelectorAll("input[type=checkbox]");
    rejectAssignment(inputs[0], "checked");
    env.startScan();
    await sleep(200);
    await clickFill(env);
    t("④ 勾选失败时不报「✓ 已填涂」", !/✓ 已填涂/.test(cardText(env)), cardText(env).slice(0, 80));
    t("④ 这一题报成没能写进页面", /没能写进页面/.test(cardText(env)), cardText(env).slice(0, 80));
    t("④ 汇总里能看到点击无效", /点击无效 1/.test(fillMsg(env)), fillMsg(env).slice(0, 90));
    t("④ 汇总不是绿色报喜（成功 0）", /成功 0/.test(fillMsg(env)), fillMsg(env).slice(0, 60));
  }

  // ============ ④b 〔已知局限，非本批修复〕默认勾选会被当成"已经填过" ============
  // 判据只看 DOM 现状（有没有 input 是勾着的），分不清"我们填的"和"页面预设的"。
  // 后果：带默认勾选的问卷会整题跳过。改它要先定产品行为（要不要把默认值改成答案），
  // 所以这条断言**故意钉住现状** —— 将来动这个逻辑时必须显式更新这里，不能顺手改错。
  {
    const env = boot(CHOICE_PAGE("checkbox"), { ok: true, text: "答案：A" }, { whitelist: ["*"] });
    env.injectContent();
    const inputs = env.doc.querySelectorAll("input[type=checkbox]");
    inputs[1].checked = true;               // 页面自己默认勾了 B
    env.startScan();
    await sleep(200);
    await clickFill(env);
    t("④b 默认勾选的题目前会被跳过（已知局限）", /已经填过，跳过/.test(cardText(env)), cardText(env).slice(0, 60));
    t("④b 跳过时一次 AI 都不发（现状）", env.stats.aiCalls.length === 0, env.stats.aiCalls.length);
  }

  // ============ ⑤ 对照：正常页面不能被这套回读弄坏 ============
  {
    const env = boot(CHOICE_PAGE("radio"), { ok: true, text: "答案：A" });
    run(env);
    await waitDone(env);
    t("⑤ 普通单选页面照旧一题不落空", /AI 作答 1，未答 0/.test(runLog(env)), (runLog(env).match(/完成：[^\n]*/) || [""])[0].slice(0, 90));
    t("⑤ 勾选真的落进页面", JSON.stringify(env.checked()[0].idx) === "[0]", JSON.stringify(env.checked()));
  }

  console.log("----- 断言 -----");
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "  got=" + JSON.stringify(r.got));
  const all = results.every(r => r.ok);
  console.log("");
  console.log("===== " + (all ? "ALL PASS ✅" : "HAS FAILURES ❌") + " (" + results.filter(r => r.ok).length + "/" + results.length + ") =====");
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
