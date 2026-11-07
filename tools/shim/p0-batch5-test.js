"use strict";
/*
 * 第五批回归：配置与界面里"按提示做却必然失败 / 出错信息把人引偏"的那几处
 *
 *   · 视觉模型和文本模型共用 Base URL/Key，而提示推荐的是另一家的 glm-4v-flash
 *     → 照提示填必 400，报错还是接口原文（用后台真实代码 + 抓请求 URL 证明）
 *   · 模糊阈值填 0.8（想要 80%）会被静默钳成 50%
 *   · 截屏会把插件自己列出的答案一起截进去 → 模型照抄自己的答案
 *   · 悬浮球拖动复用面板的位置存储；重开面板时球不消失
 *   （停止被报成"请求超时"那条在 postchat-timeout-test.js 的 C1b/C1c/C1d）
 *
 * 跑法：node tools/shim/p0-batch5-test.js
 */
const fs = require("fs");
const path = require("path");
const T = require("./env");
const sleep = T.sleep;

const EXT = path.join(T.ROOT, "extension");
const CJ = fs.readFileSync(path.join(EXT, "content.js"), "utf8");
const PJ = fs.readFileSync(path.join(EXT, "popup.js"), "utf8");

const results = [];
const t = (name, cond, got) => results.push({ name, ok: !!cond, got });

// 把产品里的纯函数原样取出来跑（不重写一遍，避免"测的是测试自己"）
function grabFn(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  let depth = 0, i = src.indexOf("{", start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (!depth) break; }
  }
  return src.slice(start, i + 1);
}
function grabArrow(src, name) {
  const start = src.indexOf(`const ${name} =`);
  if (start < 0) throw new Error(`找不到 ${name}`);
  const end = src.indexOf("};", start);
  return src.slice(start, end + 2);
}

(async () => {
// ---------- ① 阈值：两种写法必须等价 ----------
{
  const thresholdFraction = new Function("return (" + grabFn(CJ, "thresholdFraction") + ")")();
  const cases = [[0.8, 0.8], ["0.8", 0.8], [80, 0.8], ["80", 0.8], [95, 0.95], [0.5, 0.5],
                 [50, 0.5], [10, 0.5], [0, 0.75], ["abc", 0.75], [undefined, 0.75]];
  const bad = cases.filter(([v, want]) => Math.abs(thresholdFraction(v) - want) > 1e-9);
  t("① content.js 阈值：0.8 / 80 都表示 80%，非法值回落 75%", bad.length === 0,
    bad.map(([v, want]) => `${JSON.stringify(v)}→${thresholdFraction(v)}(应 ${want})`).join(" "));

  const decl = grabArrow(PJ, "normThresholdPct");      // "const normThresholdPct = v => {...};"
  const normThresholdPct = new Function(decl + " return normThresholdPct;")();
  const pbad = [[0.8, 80], [80, 80], [95, 95], [10, 50], [0, 75]].filter(([v, want]) => normThresholdPct(v) !== want);
  t("① popup 阈值：与 content.js 同一套规则（存的仍是百分数）", pbad.length === 0,
    pbad.map(([v, want]) => `${JSON.stringify(v)}→${normThresholdPct(v)}(应 ${want})`).join(" "));
  t("① 两边一致：popup 存的百分数经 content 解析后不变形",
    [50, 75, 80, 95].every(p => Math.abs(thresholdFraction(normThresholdPct(p)) - p / 100) < 1e-9), "checked");
}

// ---------- ② 视觉模型用独立的地址与 Key ----------
async function visionRun(storage) {
  const bg = T.makeBackground({
    storage,
    fetchImpl: async () => ({
      ok: true, status: 200,
      async text() { return JSON.stringify({ choices: [{ message: { content: "1. B" } }] }); }
    }),
  });
  await bg.send({ type: "REGION_SELECTED", rect: { left: 10, top: 10, width: 100, height: 40 }, vw: 1000 },
    { tab: { id: 7, windowId: 7 }, frameId: 0 });
  await sleep(600);
  return { calls: bg.calls, replies: bg.replies };
}
{
  const shared = { aiKey: "k-text", aiBaseUrl: "http://text.test/v1", aiModel: "deepseek-chat",
                   visionModel: "glm-4v-flash", answerMode: "standard" };
  const sep = await visionRun({ ...shared, visionBaseUrl: "http://vision.test/v1", visionKey: "k-vision" });
  const url = sep.calls.length ? sep.calls[0].url : "";
  const auth = sep.calls.length ? String((sep.calls[0].init && sep.calls[0].init.headers) || {}).slice(0, 80) : "";
  t("② 填了视觉 Base URL 就发到视觉那一家的地址", /vision\.test/.test(url), url || "(没发请求)");
  t("② 用的是视觉 Key", sep.calls.length > 0 && /k-vision/.test(JSON.stringify(sep.calls[0].init)), auth);

  const fallback = await visionRun(shared);
  t("② 视觉地址/Key 留空 → 回退到文本那套（同一家不用填两遍）",
    fallback.calls.length > 0 && /text\.test/.test(fallback.calls[0].url) && /k-text/.test(JSON.stringify(fallback.calls[0].init)),
    fallback.calls.length ? fallback.calls[0].url : "(没发请求)");

  const noModel = await visionRun({ ...shared, visionModel: "" });
  t("② 没填视觉模型时零请求，且提示里点明了独立地址这一栏",
    noModel.calls.length === 0 && noModel.replies.some(r => r.ok === false && /视觉模型/.test(r.text || "")),
    noModel.replies.map(r => (r.text || "").slice(0, 24)));

  // 心跳：等模型期间也要推进度，否则页面那边的 30 秒空闲看门狗会先弹超时
  t("② 后台在等响应期间有进度心跳（setInterval + finally 清理）",
    /const beat = setInterval\(/.test(fs.readFileSync(path.join(EXT, "background.js"), "utf8")) &&
    /clearInterval\(beat\)/.test(fs.readFileSync(path.join(EXT, "background.js"), "utf8")),
    "checked");
}

// ---------- ③ 截屏前把自家界面藏起来 ----------
{
  const HEAD = "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"></head><body>";
  const html = HEAD + "<div class=\"question\"><div class=\"q-stem\">1. 下列哪个是数据库？</div>" +
    "<div class=\"opt\"><input type=\"radio\" name=\"q1" + "\"><span class=\"opt-text\">MySQL</span></div>" +
    "<div class=\"opt\"><input type=\"radio\" name=\"q1\"><span class=\"opt-text\">Nginx</span></div></div></body></html>";
  const env = T.makeEnv({ html, aiReply: { ok: true, text: "答案：A" },
    storage: { mode: "ai", aiKey: "sk", interval: "0", showLog: true } });
  env.runInlineScripts();
  env.injectContent();
  env.startScan();
  await sleep(200);

  const panel = env.panel();
  const shotBtn = [...panel.querySelectorAll("button")].find(b => b.textContent.trim() === "📷");
  t("③ 面板上有 📷 按钮", !!shotBtn, shotBtn && shotBtn.textContent);
  shotBtn.click();                        // 进入框选
  await sleep(50);
  const overlay = env.doc.querySelector(".aa-overlay");
  t("③ 框选遮罩已出现", !!overlay, "ok");
  overlay.dispatchEvent(new T.dom.ShimEvent("mousedown", { bubbles: true, button: 0, clientX: 20, clientY: 20 }));
  overlay.dispatchEvent(new T.dom.ShimEvent("mousemove", { bubbles: true, clientX: 220, clientY: 160 }));
  overlay.dispatchEvent(new T.dom.ShimEvent("mouseup", { bubbles: true, clientX: 220, clientY: 160 }));
  await sleep(50);
  const hiddenVis = (env.panel() || {}).style ? env.panel().style.visibility : "(面板没了)";
  t("③ 发请求前把扫描面板藏起来了（不会把自家答案截进去）", hiddenVis === "hidden", hiddenVis);

  env.sandbox.chrome.__fire({ type: "ANSWER", ok: null, text: "✓ 已截屏，正在裁剪…" });
  await sleep(80);
  const backVis = (env.panel() || {}).style ? env.panel().style.visibility : "(面板没了)";
  t("③ 收到第一条进度后立刻恢复显示", backVis !== "hidden", backVis);
  t("③ 藏起来的兜底定时器存在（一条回复都没有也不会一直藏）",
    /if \(shotRestore\)[\s\S]{0,120}15000/.test(CJ), "checked");
}

// ---------- ④ 悬浮球：不污染面板位置、重开面板要收掉 ----------
{
  const HEAD = "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"></head><body>";
  const html = HEAD + "<div class=\"question\"><div class=\"q-stem\">1. 下列哪个是数据库？</div>" +
    "<div class=\"opt\"><input type=\"radio\" name=\"q1\"><span class=\"opt-text\">MySQL</span></div>" +
    "<div class=\"opt\"><input type=\"radio\" name=\"q1\"><span class=\"opt-text\">Nginx</span></div></div></body></html>";
  const env = T.makeEnv({ html, aiReply: { ok: true, text: "答案：A" },
    storage: { mode: "ai", aiKey: "sk", interval: "0", showLog: true } });
  env.runInlineScripts();
  env.injectContent();
  env.startScan();
  await sleep(200);

  const minBtn = [...env.panel().querySelectorAll("button")].find(b => b.textContent.trim() === "—");
  minBtn.click();
  await sleep(50);
  t("④ 最小化后出现悬浮球", env.doc.querySelectorAll(".aa-ball").length === 1,
    env.doc.querySelectorAll(".aa-ball").length);

  // 拖动球：以前会把球的 46px 坐标写进 scanPanelPos，下次面板就跑到角落
  const ball = env.doc.querySelector(".aa-ball");
  ball.dispatchEvent(new T.dom.ShimEvent("mousedown", { bubbles: true, button: 0, clientX: 30, clientY: 40 }));
  ball.dispatchEvent(new T.dom.ShimEvent("mousemove", { bubbles: true, clientX: 60, clientY: 90 }));
  env.doc.dispatchEvent(new T.dom.ShimEvent("mouseup", { bubbles: true, clientX: 60, clientY: 90 }));
  await sleep(120);
  t("④ 拖球不再污染面板位置 scanPanelPos", env.storage.scanPanelPos === undefined,
    JSON.stringify(env.storage.scanPanelPos === undefined ? "未写" : env.storage.scanPanelPos));

  env.startScan();                       // 重开面板
  await sleep(150);
  t("④ 重开面板时把球收掉（不再球和面板同时挂着）", env.doc.querySelectorAll(".aa-ball").length === 0,
    env.doc.querySelectorAll(".aa-ball").length);

  // 再最小化两次也不攒球
  const min2 = [...env.panel().querySelectorAll("button")].find(b => b.textContent.trim() === "—");
  min2.click(); await sleep(50); min2.click(); await sleep(50);
  t("④ 连续最小化不会攒出两个球", env.doc.querySelectorAll(".aa-ball").length === 1,
    env.doc.querySelectorAll(".aa-ball").length);
}

// ---------- ⑤ 拖拽监听的收场兜底 ----------
{
  const hasCancel = /document\.addEventListener\("pointercancel", stop\)/.test(CJ);
  const hasBlur = /window\.addEventListener\("blur", stop\)/.test(CJ);
  const removed = (CJ.match(/document\.removeEventListener\("pointercancel", stop\)/g) || []).length;
  t("⑤ 拖动/缩放都加了 pointercancel + 窗口 blur 兜底", hasCancel && hasBlur, { hasCancel, hasBlur });
  t("⑤ 兜底监听在结束时一并摘掉（不留永久监听）", removed >= 2, removed);
}

console.log("----- 断言 -----");
for (const r of results) console.log((r.ok ? "PASS" : "FAIL") + "  " + r.name + "  got=" + JSON.stringify(r.got));
const all = results.every(r => r.ok);
console.log("");
console.log("===== " + (all ? "ALL PASS ✅" : "HAS FAILURES ❌") + " (" + results.filter(r => r.ok).length + "/" + results.length + ") =====");
process.exit(all ? 0 : 1);
})().catch(e => { console.error("TEST_CRASH:", e); process.exit(1); });
