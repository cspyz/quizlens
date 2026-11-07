"use strict";
/*
 * 第四批回归：识别正确性（不吞题 / 不错位 / 不盲勾 / 翻页不停摆）
 *
 * 修前实测（真浏览器 + 本台架都撞到过）：
 *   · 四道各自独立的 .question，题干选项相同时被 dedupe 合成一张卡
 *     （真浏览器里 4 题只剩 1 张，因为题干把选项文字吞了进去，
 *      相似度被共同的选项撑到 0.9+，而"选项集相同才许合"的闸门反而成了合并的理由）
 *   · 合并时只搬 options/stem，不搬 inputs/optEls/el → 卡片显示 A 的选项、点 B 的控件
 *   · 页面选项文字读不出来时，题库下标按位置硬勾 / 模型回的字母盲勾
 *   · 页头挂着「提交」+ 页尾「下一题」的自建问卷：一撞上提交按钮就整轮停在第 1 页
 *   · 用户点停止之后，还会点一次「下一题」（翻页会触发页面自己的保存/跳转）
 *
 * 跑法：node tools/shim/p0-batch4-test.js
 */
const T = require("./env");
const sleep = T.sleep;

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });
const unhandled = [];
process.on("unhandledRejection", (e) => unhandled.push(String((e && e.message) || e)));

const HEAD = "<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"></head><body>";

const opt = (name, i, tx) => tx == null
  ? `<div class="opt"><input type="radio" name="${name}" value="${i}"></div>`              // 没有 .opt-text
  : `<div class="opt"><input type="radio" name="${name}" value="${i}"><span class="opt-text">${tx}</span></div>`;

// 四道独立题：题干与选项**完全相同**
const SAME_4 = HEAD + [1, 2, 3, 4].map(n =>
  `<div class="question"><div class="q-stem">${n}. 下列哪个是数据库？</div>` +
  opt("g" + n, 0, "MySQL") + opt("g" + n, 1, "Nginx") + opt("g" + n, 2, "Redis") + "</div>").join("") +
  "</body></html>";

// 选项文字读不出来的页面（.opt 里没有 .opt-text），但有 4 个可点 radio
const UNREADABLE = HEAD +
  "<div class=\"question\"><div class=\"q-stem\">1. 3 + 4 =（  ）</div>" +
  opt("u", 0) + opt("u", 1) + opt("u", 2) + "</div></body></html>";
// 对照组：同一道题，选项文字读得出来
const READABLE = HEAD +
  "<div class=\"question\"><div class=\"q-stem\">1. 3 + 4 =（  ）</div>" +
  opt("r", 0, "6") + opt("r", 1, "7") + opt("r", 2, "8") + "</div></body></html>";

// 分页问卷：页头挂着「提交」，页尾才是「下一题」
const PAGER = (interval) => HEAD +
  "<div id=\"pg\"><div class=\"question\"><div class=\"q-stem\">1. 第一页这道题选哪个？</div>" +
  opt("p1", 0, "甲") + opt("p1", 1, "乙") + "</div></div>" +
  "<button id=\"submitTop\">提交</button><button id=\"next\">下一题</button>" +
  "<script>window.__clicks = 0;" +
  "document.getElementById('next').addEventListener('click', function () {" +
  "  window.__clicks++;" +
  "  document.getElementById('pg').innerHTML =" +
  "    '<div class=\"question\"><div class=\"q-stem\">2. 第二页这道题选哪个？</div>' +" +
  "    '<div class=\"opt\"><input type=\"radio\" name=\"p2\" value=\"0\"><span class=\"opt-text\">丙</span></div>' +" +
  "    '<div class=\"opt\"><input type=\"radio\" name=\"p2\" value=\"1\"><span class=\"opt-text\">丁</span></div></div>';" +
  "  this.style.display = 'none';" +
  "});</script></body></html>";

function boot(html, aiReply, storage) {
  const env = T.makeEnv({
    html, aiReply,
    storage: Object.assign({ mode: "ai", aiKey: "sk-test", aiModel: "mock", interval: "0", answerMode: "standard", showLog: true, concurrentEnabled: false, concurrency: 1 }, storage || {}),
  });
  env.runInlineScripts();
  env.injectContent();
  return env;
}

function runLog(env) {
  const el = env.doc.querySelector(".aa-runlog") || env.doc.querySelector("#aa-log");
  return el ? (el.textContent || "") : "";
}
async function waitDone(env, tries = 90) {
  for (let i = 0; i < tries; i++) {
    await sleep(200);
    if (/完成：题库命中\s*\d+/.test(runLog(env))) break;
  }
  return runLog(env);
}

(async () => {
  // ============ ① 四道独立题不许合成一张卡 ============
  {
    const env = boot(SAME_4, { ok: true, text: "答案：A" });
    env.startScan();
    await sleep(400);
    const cards = env.cards();
    t("① 四道独立题（题干选项完全相同）出四张卡", cards.length === 4, `卡片=${cards.length}`);
    // 每张卡：选项文字条数与可点元素个数必须配套（不配套就会"显示 A 的选项、点 B 的控件"）
    const mispair = cards.filter(c => {
      const q = c.q || {};
      const clickable = (q.inputs || []).filter(Boolean).length || (q.optEls || []).length;
      const opts = (q.options || q.optionTexts || []).length;
      return clickable > 0 && opts > 0 && clickable !== opts;
    }).length;
    t("① 没有任何一张卡「选项条数 ≠ 可点元素个数」", mispair === 0, `${mispair} 张错位`);
    t("① 无未捕获异常", unhandled.length === 0, JSON.stringify(unhandled).slice(0, 120));
  }

  // ============ ② 选项文字读不出来时不盲勾 ============
  {
    const env = boot(UNREADABLE, { ok: true, text: "答案：B" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    const idx = env.checked()[0].idx;
    t("② 页面选项读不出来 + 有可点控件 → 一个都不勾", idx.length === 0, JSON.stringify(env.checked()));
    t("② 如实说明原因（不是「AI 没解析出字母」那种误导）", /读不出来/.test(runLog(env)), (runLog(env).match(/[^\n]*读不出来[^\n]*/) || ["(没有这行)"])[0].slice(0, 80));
    t("② 一次 AI 请求都不发", env.stats.aiCalls.length === 0, env.stats.aiCalls.length);

    const ok2 = boot(READABLE, { ok: true, text: "答案：B" });
    ok2.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(ok2);
    t("②b 对照组：选项读得出来时照常勾上（守卫没把正常路径挡住）", JSON.stringify(ok2.checked()[0].idx) === "[1]", JSON.stringify(ok2.checked()));
  }

  // ============ ③ 页头的「提交」不许挡住翻页 ============
  {
    const env = boot(PAGER(), { ok: true, text: "答案：A" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 0, showLog: true });
    await waitDone(env);
    t("③ 翻了一页（提交按钮没让翻页放弃）", env.win.__clicks === 1, `下一题被点 ${env.win.__clicks} 次`);
    const p2 = [...env.doc.querySelectorAll('input[name=p2]')].map(i => i.checked).indexOf(true);
    t("③ 第二页的题也答上了", p2 === 0, `第二页勾选=${p2}`);
    t("③ 汇总里能看到共 2 页", /共 2 页/.test(runLog(env)), (runLog(env).match(/完成：[^\n]*/) || [""])[0].slice(0, 90));
  }

  // ============ ④ 点了停止就不许再翻页 ============
  {
    const env = boot(PAGER(), { ok: true, text: "答案：A" });
    env.start({ mode: "ai", aiKey: "sk-test", intervalMs: 900, showLog: true });
    // 必须等第一页**真的答上**（answeredThisPage ≥ 1）再停：否则翻页分支压根不可达，
    // 这条断言会空过（第一版就是这么假绿的）。
    let answered = false;
    for (let i = 0; i < 60 && !answered; i++) {
      await sleep(100);
      answered = env.checked()[0].idx.length > 0;
    }
    t("④ 前置：第一页已答上（翻页分支可达）", answered, JSON.stringify(env.checked()));
    env.stop();
    await sleep(2000);                     // 够旧代码走完等待 + 点一次下一题
    t("④ 停止之后没有再点「下一题」", env.win.__clicks === 0, `下一题被点 ${env.win.__clicks} 次`);
    t("④ 停止后没有未处理异常", unhandled.length === 0, JSON.stringify(unhandled).slice(0, 120));
  }

  console.log("----- 断言 -----");
  for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "  got=" + JSON.stringify(r.got));
  const all = results.every(r => r.ok) && unhandled.length === 0;
  console.log("");
  console.log("===== " + (all ? "ALL PASS ✅" : "HAS FAILURES ❌") + " (" + results.filter(r => r.ok).length + "/" + results.length + ") =====");
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
