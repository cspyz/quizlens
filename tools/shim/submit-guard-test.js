"use strict";
/**
 * 交卷确认守卫下线回归测试 —— 纯 Node，不需要浏览器。
 *
 * 2026-10-25 起插件全局关闭交卷确认弹窗（formsubmit.js 不再注入、不再 arm）。
 * 本测试保证：
 *   1. manifest 不再加载 formsubmit.js；
 *   2. content.js 不再引用 AutoAnswerSubmit / armSubmitGuard；
 *   3. 插件活动后，点页面的「提交答卷」「确认交卷」直达页面，不出现 .aa-submit-dialog。
 */
const T = require("./env");
const fs = require("fs");
const path = require("path");
const sleep = T.sleep;

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });

function htmlWithForm() {
  return [
    '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"></head><body>',
    '<div class="question">',
    '  <div class="q-stem">1. 下列哪个是数据库？</div>',
    '  <div class="opt"><input type="radio" name="q1" value="0"><span class="opt-text">MySQL</span></div>',
    '  <div class="opt"><input type="radio" name="q1" value="1"><span class="opt-text">Nginx</span></div>',
    '  <div class="opt"><input type="radio" name="q1" value="2"><span class="opt-text">Redis</span></div>',
    '</div>',
    '<form id="exam">',
    '  <button type="submit" id="submitBtn">提交答卷</button>',
    '  <button type="button" id="confirmBtn">确认交卷</button>',
    '</form>',
    '</body></html>',
  ].join("");
}

function spySubmit(doc) {
  const spy = { byId: {} };
  doc.addEventListener("click", e => {
    const el = e.target;
    if (!el || el.nodeType !== 1) return;
    const id = el.getAttribute && el.getAttribute("id");
    if (id) spy.byId[id] = (spy.byId[id] || 0) + 1;
  });
  return spy;
}

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(T.EXT, "manifest.json"), "utf8"));
  const injected = (manifest.content_scripts || []).flatMap(x => x.js || []);
  const contentSrc = fs.readFileSync(path.join(T.EXT, "content.js"), "utf8");

  t("1. manifest 不再注入 formsubmit.js", !injected.includes("formsubmit.js"), injected);
  t("1. content.js 仍会被注入", injected.includes("content.js"), injected);
  t("2. content.js 不再引用 AutoAnswerSubmit", !/AutoAnswerSubmit/.test(contentSrc), "AutoAnswerSubmit");
  t("2. content.js 不再引用 armSubmitGuard", !/armSubmitGuard/.test(contentSrc), "armSubmitGuard");

  const env = T.makeEnv({ html: htmlWithForm(), storage: {} });
  env.runInlineScripts();
  env.injectContent();
  const spy = spySubmit(env.doc);

  await env.startScan();
  await sleep(250);

  t("3. 插件面板打开后也没有提交守卫 API", !env.win.AutoAnswerSubmit, !!env.win.AutoAnswerSubmit);

  env.doc.getElementById("submitBtn").click();
  env.doc.getElementById("confirmBtn").click();
  await sleep(60);

  t("3. 「提交答卷」点击直达页面", spy.byId.submitBtn === 1, spy.byId.submitBtn);
  t("3. 「确认交卷」点击直达页面", spy.byId.confirmBtn === 1, spy.byId.confirmBtn);
  t("3. 没有出现插件提交确认框", env.doc.querySelectorAll(".aa-submit-dialog").length === 0,
    env.doc.querySelectorAll(".aa-submit-dialog").length);

  const errs = env.errors();
  t("4. 无未捕获异常", errs.length === 0, errs.map(e => e && (e.error || e)).slice(0, 2));

  console.log("----- 断言 -----");
  for (const r of results) {
    console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "  got=" + JSON.stringify(r.got));
  }
  const all = results.every(r => r.ok);
  console.log("");
  console.log("===== " + (all ? "ALL PASS" : "HAS FAILURES") + " (" + results.filter(r => r.ok).length + "/" + results.length + ") =====");
  process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
